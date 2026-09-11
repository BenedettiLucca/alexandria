import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthContext, supabase } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import type { ProjectRow } from "../types.ts";

export function registerProjectsTools(
  server: McpServer,
  getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: "List tracked projects and their status.",
      inputSchema: {
        status: z.string().optional().describe(
          "Filter: active, paused, archived",
        ),
      },
    },
    wrapHandler(async ({ status }) => {
      const auth = getAuth();
      if (!auth) throw new Error("Not authenticated.");
      let q = supabase
        .from("projects")
        .select("id, name, path, status, stack, created_at, updated_at")
        .eq("user_id", auth.userId)
        .order("updated_at", { ascending: false, nullsFirst: false });
      if (status) q = q.eq("status", status);
      const { data, error } = await q.limit(20);
      if (error) throw new Error(error.message);
      const projects = data || [];

      if (!projects.length) return "No projects tracked yet.";

      const results = projects.map(
        (
          p: Pick<
            ProjectRow,
            | "id"
            | "name"
            | "path"
            | "status"
            | "stack"
            | "created_at"
            | "updated_at"
          >,
          i: number,
        ) => {
          const stack = p.stack?.length ? ` [${p.stack.join(", ")}]` : "";
          return `${i + 1}. ${p.name} (${p.status})${stack}\n   Path: ${
            p.path || "N/A"
          } | Updated: ${new Date(p.updated_at).toLocaleDateString()}`;
        },
      );
      return `${projects.length} project(s):\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "save_project",
    {
      title: "Save Project",
      description:
        "Create or update a project record. Use when onboarding a new codebase or updating project context.",
      inputSchema: {
        name: z.string().describe("Project name"),
        path: z.string().optional().describe("Filesystem path"),
        description: z.string().optional().describe("What this project does"),
        stack: z.array(z.string()).optional().describe(
          "Tech stack (e.g. ['python', 'fastapi', 'postgres'])",
        ),
        conventions: z.record(z.any()).optional().describe(
          "Coding conventions (commit style, linting, testing)",
        ),
        status: z.string().optional().describe("active, paused, or archived"),
      },
    },
    wrapHandler(
      async ({ name, path, description, stack, conventions, status }) => {
        const auth = getAuth();
        if (!auth) throw new Error("Not authenticated.");

        const { data, error } = await supabase.rpc("upsert_project", {
          p_name: name,
          p_path: path,
          p_description: description,
          p_stack: stack ?? [],
          p_conventions: conventions ?? {},
          p_status: status ?? "active",
          p_user_id: auth.userId,
        });
        if (error) throw new Error(error.message);
        if (!data?.id || !data?.status) throw new Error("Project save failed");

        return `Project "${name.trim()}" ${data.status}.`;
      },
    ),
  );
}
