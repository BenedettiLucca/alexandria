import "@supabase/functions-js/edge-runtime.d.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  supabase,
  MCP_ACCESS_KEY,
  timingSafeEqual,
  getCorsHeaders,
  AuthContext,
} from "./config.ts";

import { registerMemoriesTools } from "./tools/memories.ts";
import { registerProfileTools } from "./tools/profile.ts";
import { registerProjectsTools } from "./tools/projects.ts";
import { registerHealthTools } from "./tools/health.ts";
import { registerWorkoutsTools } from "./tools/workouts.ts";
import { registerEntitiesTools } from "./tools/entities.ts";

const server = new McpServer({
  name: "alexandria",
  version: "1.0.0",
});

let currentAuth: AuthContext | undefined;
const getAuth = () => currentAuth;

registerMemoriesTools(server, getAuth);
registerProfileTools(server, getAuth);
registerProjectsTools(server, getAuth);
registerHealthTools(server, getAuth);
registerWorkoutsTools(server, getAuth);
registerEntitiesTools(server, getAuth);

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
    } catch { /* fall through to key auth */ }
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

app.all("*", async (c) => {
  const auth = await authenticate(c);
  if (!auth) {
    return c.json({ error: "Unauthorized" }, 401, getCorsHeaders(c.req.header("origin")));
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
