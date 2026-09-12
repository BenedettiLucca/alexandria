import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthContext, supabase } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import type { MemoryRow, SyncLogRow } from "../types.ts";

export function registerEntitiesTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "search_entities",
    {
      title: "Search Entities",
      description:
        "Search the knowledge graph for entities by name. Use when the user asks about a person, project, concept, technology, organization, location, or event they've mentioned in their memories.",
      inputSchema: {
        query: z.string().describe("Entity name or partial name to search for"),
        entity_type: z.string().optional().describe(
          "Filter: person, project, concept, location, technology, organization, event, other",
        ),
        limit: z.number().optional().default(10),
      },
    },
    wrapHandler(async ({ query, entity_type, limit }) => {
      let q = supabase
        .from("entities")
        .select("id, name, entity_type, description, created_at")
        .ilike("name", `%${query}%`)
        .limit(limit);

      if (entity_type) q = q.eq("entity_type", entity_type);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) return `No entities found matching "${query}".`;

      const results = data.map(
        (e, i: number) => {
          const desc = e.description ? `\n   ${e.description}` : "";
          return `${i + 1}. ${e.name} (${e.entity_type})${desc}`;
        },
      );

      return `${data.length} entit${
        data.length === 1 ? "y" : "ies"
      } found:\n\n${results.join("\n")}`;
    }),
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get Entity",
      description:
        "Get full entity details including all memories that mention this entity. Use when the user wants to see everything related to a specific person, project, concept, etc.",
      inputSchema: {
        entity_id: z.string().uuid().describe("Entity UUID"),
        limit: z.number().optional().default(10),
      },
    },
    wrapHandler(async ({ entity_id, limit }) => {
      const { data: entity, error: entityErr } = await supabase
        .from("entities")
        .select("*")
        .eq("id", entity_id)
        .single();

      if (entityErr || !entity) throw new Error("Entity not found.");

      const { data: mentions, error: mentionErr } = await supabase
        .from("entity_mentions")
        .select("memory_id, context, created_at")
        .eq("entity_id", entity_id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (mentionErr) throw new Error(mentionErr.message);

      const memoryIds = (mentions || []).map((m) => m.memory_id);
      let memoryDetails: Pick<
        MemoryRow,
        "id" | "content" | "title" | "category" | "created_at"
      >[] = [];
      if (memoryIds.length) {
        const { data: mems } = await supabase
          .from("memories")
          .select("id, content, title, category, created_at")
          .in("id", memoryIds);
        memoryDetails = mems || [];
      }

      const memById = new Map(memoryDetails.map((m) => [m.id, m]));
      const lines = [
        `== ${entity.name} (${entity.entity_type}) ==`,
        entity.description ? `Description: ${entity.description}` : "",
        `Created: ${new Date(entity.created_at).toLocaleDateString()}`,
        `Mentioned in ${(mentions || []).length} memories`,
      ].filter(Boolean);

      if (mentions?.length) {
        lines.push("", "Related memories:");
        mentions.forEach((m, i: number) => {
          const mem = memById.get(m.memory_id);
          if (mem) {
            lines.push(
              `  ${i + 1}. [${
                new Date(mem.created_at).toLocaleDateString()
              }] ${mem.category}: ${mem.title || mem.content.slice(0, 100)}`,
            );
            if (m.context) lines.push(`     "${m.context}"`);
          }
        });
      }

      return lines.join("\n");
    }),
  );

  server.registerTool(
    "list_entities",
    {
      title: "List Entities",
      description:
        "List all entities in the knowledge graph, optionally filtered by type. Sorted by number of mentions (most connected first). Use to browse the knowledge graph.",
      inputSchema: {
        entity_type: z.string().optional().describe(
          "Filter: person, project, concept, location, technology, organization, event, other",
        ),
        limit: z.number().optional().default(25),
      },
    },
    wrapHandler(async ({ entity_type, limit }) => {
      // Bounded SQL aggregate query via RPC (bounded row transfer, ordered in database)
      const { data, error } = await supabase.rpc("list_entities_ranked", {
        p_entity_type: entity_type || null,
        p_limit: limit || 25,
      });

      if (error) {
        throw new Error("Failed to list entities: " + error.message);
      }
      if (!data || !data.length) {
        return "No entities in the knowledge graph yet.";
      }

      const results = data.map((e: any, i: number) => {
        const count = Number(e.mention_count || 0);
        return `${i + 1}. ${e.name} (${e.entity_type}) — ${count} mention${
          count === 1 ? "" : "s"
        }`;
      });

      return `${data.length} entit${data.length === 1 ? "y" : "ies"}:\n\n${
        results.join("\n")
      }`;
    }),
  );

  server.registerTool(
    "sync_status",
    {
      title: "Sync Status",
      description: "View recent sync history from the sync_log table.",
      inputSchema: {
        source: z.string().optional().describe(
          "Filter by source: iron-log, health-connect, health-api",
        ),
        limit: z.number().optional().default(10),
      },
    },
    wrapHandler(async ({ source, limit }) => {
      const filters: Record<string, unknown> = {};
      if (source) filters.source = source;

      let q = supabase
        .from("sync_log")
        .select(
          "id, source, sync_type, records_processed, records_imported, records_skipped, records_failed, started_at, completed_at, status, error_message",
        )
        .order("started_at", { ascending: false })
        .limit(limit);

      for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) return "No sync history found.";

      const results = data.map(
        (
          s: Pick<
            SyncLogRow,
            | "id"
            | "source"
            | "sync_type"
            | "records_processed"
            | "records_imported"
            | "records_skipped"
            | "records_failed"
            | "started_at"
            | "completed_at"
            | "status"
            | "error_message"
          >,
          i: number,
        ) => {
          const lines = [
            `${i + 1}. [${s.source}] ${s.sync_type || "sync"} — ${s.status}`,
            `   Started: ${new Date(s.started_at).toISOString()}`,
            s.completed_at
              ? `   Completed: ${new Date(s.completed_at).toISOString()}`
              : null,
            `   Processed: ${s.records_processed}, Imported: ${s.records_imported}, Skipped: ${s.records_skipped}, Failed: ${s.records_failed}`,
            s.error_message ? `   Error: ${s.error_message}` : null,
          ].filter(Boolean);
          return lines.join("\n");
        },
      );

      return `${data.length} sync log entr${
        data.length === 1 ? "y" : "ies"
      }:\n\n${results.join("\n\n")}`;
    }),
  );
}
