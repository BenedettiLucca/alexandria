import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { wrapHandler, queryTable } from "../helpers.ts";
import { ProjectRow } from "../types.ts";

export function registerProjectsTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
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
      const data = await queryTable(
        "projects",
        "id, name, path, status, stack, created_at, updated_at",
        {
          filters: status ? { status } : {},
          order: "updated_at",
          ascending: false,
        },
      );

      if (!data.length) return "No projects tracked yet.";

      const results = data.map(
        (p: any, i: number) => {
          const stack = p.stack?.length ? ` [${p.stack.join(", ")}]` : "";
          return `${i + 1}. ${p.name} (${p.status})${stack}\n   Path: ${
            p.path || "N/A"
          } | Updated: ${new Date(p.updated_at).toLocaleDateString()}`;
        },
      );
      return `${data.length} project(s):\n\n${results.join("\n\n")}`;
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
        const update: Record<string, unknown> = {
          name,
          updated_at: new Date().toISOString(),
        };
        if (path !== undefined) update.path = path;
        if (description !== undefined) update.description = description;
        if (stack !== undefined) update.stack = stack;
        if (conventions !== undefined) update.conventions = conventions;
        if (status !== undefined) update.status = status;

        const { data: existing } = await supabase
          .from("projects")
          .select("id")
          .eq("name", name)
          .maybeSingle();

        if (existing) {
          const { error } = await supabase
            .from("projects")
            .update(update)
            .eq("id", existing.id);
          if (error) throw new Error("Project update failed");
          return `Project "${name}" updated.`;
        }

        const { error } = await supabase.from("projects").insert(update);
        if (error) throw new Error("Project creation failed");
        return `Project "${name}" created.`;
      },
    ),
  );
}
