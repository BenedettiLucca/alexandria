import "@supabase/functions-js/edge-runtime.d.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  supabase,
  MCP_ACCESS_KEY,
  SUPABASE_URL,
  timingSafeEqual,
  getCorsHeaders,
  AuthContext,
} from "./config.ts";

import { registerMemoriesTools } from "./tools/memories.ts";
import { registerBriefsTools } from "./tools/briefs.ts";
import { registerProfileTools } from "./tools/profile.ts";
import { registerProjectsTools } from "./tools/projects.ts";
import { registerHealthTools } from "./tools/health.ts";
import { registerWorkoutsTools } from "./tools/workouts.ts";
import { registerEntitiesTools } from "./tools/entities.ts";

const OAUTH_SCOPE = "alexandria.access";
const MCP_PUBLIC_URL = `${SUPABASE_URL}/functions/v1/alexandria`;

const server = new McpServer({
  name: "alexandria",
  version: "1.0.0",
});

let currentAuth: AuthContext | undefined;
const getAuth = () => currentAuth;

registerMemoriesTools(server, getAuth);
registerBriefsTools(server, getAuth);
registerProfileTools(server, getAuth);
registerProjectsTools(server, getAuth);
registerHealthTools(server, getAuth);
registerWorkoutsTools(server, getAuth);
registerEntitiesTools(server, getAuth);

function getProtectedResourceMetadataUrl(): string {
  return `${MCP_PUBLIC_URL}?oauth_metadata=protected_resource`;
}

function getOAuthChallenge(errorDescription = "Authorization required"): string {
  const resourceMetadata = getProtectedResourceMetadataUrl();
  return `Bearer realm="alexandria", resource_metadata="${resourceMetadata}", scope="${OAUTH_SCOPE}", error="invalid_token", error_description="${errorDescription}"`;
}

function unauthorized(c: Context, errorDescription = "Authorization required") {
  const challenge = getOAuthChallenge(errorDescription);
  return c.json(
    {
      error: "Unauthorized",
      _meta: { "mcp/www_authenticate": challenge },
    },
    401,
    {
      ...getCorsHeaders(c.req.header("origin")),
      "WWW-Authenticate": challenge,
    },
  );
}

function protectedResourceMetadata() {
  return {
    resource: MCP_PUBLIC_URL,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_documentation: MCP_PUBLIC_URL,
  };
}

async function getAuthorizationServerMetadata() {
  const oidcUrl = `${SUPABASE_URL}/auth/v1/.well-known/openid-configuration`;
  const response = await fetch(oidcUrl, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Failed to load Supabase auth metadata");
  }

  const oidc = await response.json();
  const origin = new URL(SUPABASE_URL).origin;

  return {
    issuer: origin,
    authorization_endpoint: oidc.authorization_endpoint,
    token_endpoint: oidc.token_endpoint,
    jwks_uri: oidc.jwks_uri,
    response_types_supported: oidc.response_types_supported || ["code"],
    response_modes_supported: oidc.response_modes_supported || ["query"],
    grant_types_supported: oidc.grant_types_supported || ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: oidc.token_endpoint_auth_methods_supported || ["none"],
    code_challenge_methods_supported: oidc.code_challenge_methods_supported || ["S256"],
    scopes_supported: oidc.scopes_supported || ["openid", "profile", "email", OAUTH_SCOPE],
    subject_types_supported: oidc.subject_types_supported || ["public"],
    id_token_signing_alg_values_supported: oidc.id_token_signing_alg_values_supported || ["RS256"],
  };
}

async function authenticate(c: Context): Promise<AuthContext | null> {
  const authHeader = c.req.header("authorization") ||
    c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        return {
          method: "jwt",
          userId: user.id,
          email: user.email || undefined,
        };
      }
    } catch {
      // Fall through to key auth for backwards compatibility
    }
  }

  const keyProvided = c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");

  if (keyProvided && timingSafeEqual(keyProvided, MCP_ACCESS_KEY)) {
    return { method: "key", userId: "service-role" };
  }

  return null;
}

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, getCorsHeaders(c.req.header("origin"))));

app.get("/.well-known/oauth-protected-resource", (c) => {
  return c.json(protectedResourceMetadata(), 200, {
    ...getCorsHeaders(c.req.header("origin")),
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/.well-known/oauth-protected-resource/*", (c) => {
  return c.json(protectedResourceMetadata(), 200, {
    ...getCorsHeaders(c.req.header("origin")),
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/.well-known/oauth-authorization-server", async (c) => {
  try {
    const metadata = await getAuthorizationServerMetadata();
    return c.json(metadata, 200, {
      ...getCorsHeaders(c.req.header("origin")),
      "Cache-Control": "public, max-age=300",
    });
  } catch {
    return c.json({ error: "OAuth metadata unavailable" }, 503, getCorsHeaders(c.req.header("origin")));
  }
});

app.get("/.well-known/oauth-authorization-server/*", async (c) => {
  try {
    const metadata = await getAuthorizationServerMetadata();
    return c.json(metadata, 200, {
      ...getCorsHeaders(c.req.header("origin")),
      "Cache-Control": "public, max-age=300",
    });
  } catch {
    return c.json({ error: "OAuth metadata unavailable" }, 503, getCorsHeaders(c.req.header("origin")));
  }
});

app.get("/.well-known/openid-configuration", async (c) => {
  try {
    const metadata = await getAuthorizationServerMetadata();
    return c.json(metadata, 200, {
      ...getCorsHeaders(c.req.header("origin")),
      "Cache-Control": "public, max-age=300",
    });
  } catch {
    return c.json({ error: "OAuth metadata unavailable" }, 503, getCorsHeaders(c.req.header("origin")));
  }
});

app.all("*", async (c) => {
  const reqUrl = new URL(c.req.url);
  const oauthMeta = reqUrl.searchParams.get("oauth_metadata");

  if (c.req.method === "GET" && oauthMeta === "protected_resource") {
    return c.json(protectedResourceMetadata(), 200, {
      ...getCorsHeaders(c.req.header("origin")),
      "Cache-Control": "public, max-age=300",
    });
  }

  if (c.req.method === "GET" && (oauthMeta === "authorization_server" || oauthMeta === "openid_configuration")) {
    try {
      const metadata = await getAuthorizationServerMetadata();
      return c.json(metadata, 200, {
        ...getCorsHeaders(c.req.header("origin")),
        "Cache-Control": "public, max-age=300",
      });
    } catch {
      return c.json({ error: "OAuth metadata unavailable" }, 503, getCorsHeaders(c.req.header("origin")));
    }
  }

  const auth = await authenticate(c);
  if (!auth) {
    return unauthorized(c);
  }

  currentAuth = auth;

  const acceptHeader = c.req.header("accept") || "";
  if (!acceptHeader.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore: Hono server type mismatch with Deno.ServeInit
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
