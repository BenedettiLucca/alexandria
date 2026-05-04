import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUserClient, AuthContext } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import {  } from "../types.ts";

export function registerProfileTools(
  server: McpServer,
  getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "get_profile",
    {
      title: "Get Profile",
      description:
        "Retrieve profile data. Use when you need to know about the user's identity, preferences, development stack, environment, or other stored profile data.",
      inputSchema: {
        key: z.string().optional().describe(
          "Specific profile key (e.g. 'identity', 'preferences', 'stack'). Omit for all.",
        ),
      },
    },
    wrapHandler(async ({ key }) => {
      const auth = getAuth();
      const client = getUserClient(auth);
      const isJwt = auth?.method === "jwt";
      const qBase = isJwt
        ? client.from("profile").select("key, value, updated_at").eq(
          "owner_id",
          auth.userId,
        )
        : client.from("profile").select("key, value, updated_at").is(
          "owner_id",
          null,
        );
      if (key) {
        const { data, error } = await qBase.eq("key", key).single();
        if (error) throw new Error(`Profile key "${key}" not found.`);
        return `Profile: ${data.key}\nUpdated: ${
          new Date(data.updated_at).toLocaleDateString()
        }\n\n${JSON.stringify(data.value, null, 2)}`;
      }

      const { data, error } = await qBase.order("key");
      if (error) throw new Error(error.message);
      if (!data?.length) {
        return "Profile is empty. Use set_profile to add entries.";
      }

      const sections = data.map((s: any) =>
        `== ${s.key} == (updated ${
          new Date(s.updated_at).toLocaleDateString()
        })\n${JSON.stringify(s.value, null, 2)}`
      );
      return `User Profile:\n\n${sections.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "set_profile",
    {
      title: "Set Profile",
      description:
        "Create or update a profile section. Use when the user tells you about themselves, their preferences, their stack, or any persistent identity information.",
      inputSchema: {
        key: z.string().describe(
          "Profile section key (e.g. 'identity', 'preferences', 'stack', 'environment')",
        ),
        value: z.record(z.any()).describe("Profile data as a JSON object"),
      },
    },
    wrapHandler(async ({ key, value }) => {
      const auth = getAuth();
      const client = getUserClient(auth);
      const isJwt = auth?.method === "jwt";
      const ownerFilter = isJwt
        ? { owner_id: auth!.userId }
        : { owner_id: null };

      const row = {
        key,
        value,
        updated_at: new Date().toISOString(),
        ...ownerFilter,
      };

      const { error } = await client
        .from("profile")
        .upsert(row, { onConflict: isJwt ? "key,owner_id" : "key" });

      if (error) throw new Error("Profile update failed");
      return `Profile "${key}" saved.`;
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Auth Status",
      description:
        "Return the current authentication context: user ID, email, auth method (JWT or API key), and profile sections.",
      inputSchema: {},
    },
    wrapHandler(async () => {
      const auth = getAuth();
      if (!auth) throw new Error("Not authenticated.");
      const lines = [
        `Auth method: ${
          auth.method === "jwt" ? "JWT Bearer token" : "Static API key"
        }`,
        `User ID: ${auth.userId}`,
      ];
      if (auth.email) lines.push(`Email: ${auth.email}`);

      if (auth.method === "jwt") {
        const client = getUserClient(auth);
        const { data: profileKeys, error } = await client
          .from("profile")
          .select("key")
          .eq("owner_id", auth.userId)
          .order("key");

        if (!error && profileKeys?.length) {
          lines.push("", "Profile sections:");
          profileKeys.forEach((p: { key: string }) => lines.push(`  - ${p.key}`));
        }
      }

      return lines.join("\n");
    }),
  );
}
