import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import {
  EntityRow,
  EntityMentionRow,
  MemoryRow,
  SyncLogRow,
} from "../types.ts";

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

      const entityIds = data.map((e: any) => e.id);
      await supabase
        .from("entity_mentions")
        .select("entity_id", { count: "exact", head: true })
        .in("entity_id", entityIds);

      const results = data.map(
        (e: any, i: number) => {
          const desc = e.description ? `\n   ${e.description}` : "";
          return `${i + 1}. ${e.name} (${e.entity_type})${desc}`;
        },
      );

      return `${data.length} entit${data.length === 1 ? "y" : "ies"} found:\n\n${
        results.join("\n")
      }`;
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

      const memoryIds = (mentions || []).map((m: any) => m.memory_id);
      let memoryDetails: any[] = [];
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
        mentions.forEach((m: any, i: number) => {
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
      let entityQ = supabase
        .from("entities")
        .select("id, name, entity_type, description, created_at");

      if (entity_type) entityQ = entityQ.eq("entity_type", entity_type);

      const { data: entities, error: entityErr } = await entityQ;
      if (entityErr) throw new Error(entityErr.message);
      if (!entities?.length) return "No entities in the knowledge graph yet.";

      const entityIds = entities.map((e: any) => e.id);
      const { data: mentions } = await supabase
        .from("entity_mentions")
        .select("entity_id")
        .in("entity_id", entityIds);

      const countByEntity = new Map<string, number>();
      for (const m of mentions || []) {
        countByEntity.set(m.entity_id, (countByEntity.get(m.entity_id) || 0) + 1);
      }

      const sorted = entities
        .map((e: any) => ({
          ...e,
          mention_count: countByEntity.get(e.id) || 0,
        }))
        .sort((a: any, b: any) => b.mention_count - a.mention_count)
        .slice(0, limit);

      const results = sorted.map((e: any, i: number) =>
        `${i + 1}. ${e.name} (${e.entity_type}) — ${e.mention_count} mention${
          e.mention_count === 1 ? "" : "s"
        }`
      );

      return `${sorted.length} entit${sorted.length === 1 ? "y" : "ies"}:\n\n${
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

      const results = data.map((s: any, i: number) => {
        const started = new Date(s.started_at).toLocaleString();
        const completed = s.completed_at
          ? new Date(s.completed_at).toLocaleString()
          : "—";
        const dur = s.completed_at
          ? `${
            Math.round(
              (new Date(s.completed_at).getTime() -
                new Date(s.started_at).getTime()) / 1000,
            )
          }s`
          : "—";
        const errLine = s.error_message ? `\n   Error: ${s.error_message}` : "";
        return `${
          i + 1
        }. [${started}] ${s.source} (${s.sync_type}) — ${s.status}${errLine}\n   Processed: ${s.records_processed} | Imported: ${s.records_imported} | Skipped: ${s.records_skipped} | Failed: ${s.records_failed}\n   Duration: ${dur} | Completed: ${completed}`;
      });

      return `${data.length} sync(s):\n\n${results.join("\n\n")}`;
    }),
  );
}
