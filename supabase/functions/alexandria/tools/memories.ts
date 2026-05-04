import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import {
  getEmbedding,
  classifyMemory,
  processEntities,
  wrapHandler,
} from "../helpers.ts";
import {  } from "../types.ts";
import {
  VALID_CATEGORIES,
  simpleClassify,
} from "../lib.ts";

export function registerMemoriesTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "search_memories",
    {
      title: "Search Memories",
      description:
        "Search memories by semantic meaning. Use when the user asks about something they've previously noted, decided, or referenced.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
        category: z.string().optional().describe("Filter by category"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
      },
    },
    wrapHandler(async ({ query, limit, threshold, category, tags }) => {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_memories", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_category: category || null,
        filter_tags: tags || null,
      });

      if (error) throw new Error("Search failed");
      if (!data || data.length === 0) {
        return `No memories found matching "${query}".`;
      }

      const results = data.map(
        (
          t: any,
          i: number,
        ) => {
          const parts = [
            `--- ${i + 1}. ${(t.similarity! * 100).toFixed(1)}% match ---`,
            `Title: ${t.title || "Untitled"}`,
            `Category: ${t.category} | Importance: ${(t.importance ?? 0)}/10`,
            `Date: ${new Date(t.created_at).toLocaleDateString()}`,
          ];
          if (t.tags?.length) parts.push(`Tags: ${t.tags.join(", ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        },
      );

      return `Found ${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${
        results.join("\n\n")
      }`;
    }),
  );

  server.registerTool(
    "capture_memory",
    {
      title: "Capture Memory",
      description:
        "Save a new memory to Alexandria. Auto-generates embedding, classifies category/tags/importance, and deduplicates. Use when the user wants to save a note, idea, decision, or any piece of knowledge.",
      inputSchema: {
        content: z.string().describe(
          "The memory content -- a clear, standalone statement",
        ),
        title: z.string().optional().describe(
          "Optional title (auto-generated if omitted)",
        ),
        category: z.string().optional().describe("Override auto-classification"),
        importance: z.number().optional().describe(
          "Override auto-importance (1-10)",
        ),
        tags: z.array(z.string()).optional().describe("Additional tags"),
        people: z.array(z.string()).optional().describe("People mentioned"),
      },
    },
    wrapHandler(
      async ({ content, title, category, importance, tags, people }) => {
        const useLLM = content.length > 200 || importance === undefined;
        const classification = useLLM
          ? await classifyMemory(content)
          : simpleClassify(content);

        const embedding = await getEmbedding(content);

        const cl = classification as Record<string, unknown>;
        const finalCategory = category || (cl.category as string) || "note";
        const finalImportance = importance || (cl.importance as number) || 5;
        const finalTitle = title || (cl.title as string) || null;
        const autoTags = (cl.tags as string[]) || [];
        const autoPeople = (cl.people as string[]) || [];
        const allTags = [...new Set([...autoTags, ...(tags || [])])];
        const allPeople = [...new Set([...autoPeople, ...(people || [])])];
        const { data: upsertResult, error: upsertError } = await supabase.rpc(
          "upsert_memory",
          {
            p_content: content,
            p_title: finalTitle,
            p_category: finalCategory,
            p_source: "mcp",
            p_importance: finalImportance,
            p_tags: allTags,
            p_people: allPeople,
            p_metadata: {
              dates_mentioned: cl.dates_mentioned || [],
              auto_classified: !category,
            },
          },
        );

        if (upsertError) {
          throw new Error("Failed to save memory");
        }

        const thoughtId = upsertResult?.id;
        const { error: embError } = await supabase
          .from("memories")
          .update({ embedding })
          .eq("id", thoughtId);

        if (embError) {
          throw new Error("Failed to save embedding");
        }

        try {
          const rawEntities = Array.isArray(cl.entities) ? cl.entities : [];
          if (rawEntities.length > 0 && thoughtId) {
            await processEntities(content, thoughtId as string, rawEntities);
          }
        } catch { /* non-blocking */ }

        const classifier = useLLM ? "LLM" : "keyword";
        const status = upsertResult?.status === "updated"
          ? "Updated existing"
          : "Captured new";
        let confirmation =
          `${status} memory as "${finalCategory}" (importance ${finalImportance}/10, classified via ${classifier})`;
        if (allTags.length) confirmation += `\nTags: ${allTags.join(", ")}`;
        if (allPeople.length) confirmation += `\nPeople: ${allPeople.join(", ")}`;

        return confirmation;
      },
    ),
  );

  server.registerTool(
    "list_memories",
    {
      title: "List Recent Memories",
      description:
        "List memories with optional filters. Use when the user wants to browse recent memories or filter by category, tag, source, or time range.",
      inputSchema: {
        limit: z.number().optional().default(10),
        category: z.string().optional().describe(
          "Filter: note, idea, decision, observation, reference, task, person, recipe, travel, purchase, quote",
        ),
        tag: z.string().optional().describe("Filter by single tag"),
        source: z.string().optional().describe(
          "Filter by source: manual, mcp, import, capture, health-connect, iron-log, auto",
        ),
        days: z.number().optional().describe("Only memories from last N days"),
        importance_min: z.number().optional().describe(
          "Minimum importance (1-10)",
        ),
      },
    },
    wrapHandler(
      async ({ limit, category, tag, source, days, importance_min }) => {
        const filters: Record<string, unknown> = {};
        if (category) filters.category = category;
        if (source) filters.source = source;

        let q = supabase
          .from("memories")
          .select(
            "id, content, title, category, source, importance, tags, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(limit);

        for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
        if (tag) q = q.contains("tags", [tag]);
        if (importance_min) q = q.gte("importance", importance_min);
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          q = q.gte("created_at", since.toISOString());
        }

        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (!data || !data.length) return "No memories found.";

        const results = data.map(
          (
            t: any,
            i: number,
          ) => {
            const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
            return `${i + 1}. [${
              new Date(t.created_at).toLocaleDateString()
            }] ${t.category}${tags} (${t.importance}/10)\n   ${
              t.title || t.content.slice(0, 120)
            }`;
          },
        );

        return `${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${
          results.join("\n\n")
        }`;
      },
    ),
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory Statistics",
      description:
        "Summary of all memories: totals by category, top tags, people mentioned, date range.",
      inputSchema: {},
    },
    wrapHandler(async () => {
      const { count } = await supabase
        .from("memories")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("memories")
        .select("category, tags, people, importance, created_at")
        .order("created_at", { ascending: false });

      const cats: Record<string, number> = {};
      const tags: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        if (r.category) cats[r.category] = (cats[r.category] || 0) + 1;
        if (r.tags) {
          for (const t of r.tags) tags[t] = (tags[t] || 0) + 1;
        }
        if (r.people) {
          for (const p of r.people) people[p] = (people[p] || 0) + 1;
        }
      }

      const sort = (o: Record<string, number>) =>
        Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

      const lines = [
        `Library of Alexandria -- Memory Statistics`,
        `Total memories: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " -> " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Categories:",
        ...sort(cats).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(tags).length) {
        lines.push(
          "",
          "Top tags:",
          ...sort(tags).map(([k, v]) => `  ${k}: ${v}`),
        );
      }
      if (Object.keys(people).length) {
        lines.push(
          "",
          "People:",
          ...sort(people).map(([k, v]) => `  ${k}: ${v}`),
        );
      }

      return lines.join("\n");
    }),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update Memory",
      description:
        "Update an existing memory. If content changes, the embedding is regenerated and the memory is reclassified.",
      inputSchema: {
        id: z.string().uuid().describe("Memory ID to update"),
        content: z.string().optional().describe(
          "New content (triggers re-embedding + reclassification)",
        ),
        title: z.string().optional(),
        category: z.string().optional(),
        importance: z.number().min(1).max(10).optional(),
        tags: z.array(z.string()).optional(),
        people: z.array(z.string()).optional(),
      },
    },
    wrapHandler(
      async ({ id, content, title, category, importance, tags, people }) => {
        const update: Record<string, unknown> = {};
        if (title !== undefined) update.title = title;
        if (category !== undefined) {
          if (!VALID_CATEGORIES.includes(category as any)) {
            throw new Error(
              `Invalid category: "${category}". Valid: ${
                VALID_CATEGORIES.join(", ")
              }`,
            );
          }
          update.category = category;
        }
        if (importance !== undefined) update.importance = importance;
        if (tags !== undefined) update.tags = tags;
        if (people !== undefined) update.people = people;

        if (content !== undefined) {
          update.content = content;
          const [embedding, classification] = await Promise.all([
            getEmbedding(content),
            classifyMemory(content),
          ]);
          update.embedding = embedding;
          if (!title) update.title = (classification.title as string) || null;
          if (!category) update.category = classification.category;
          if (importance === undefined) {
            update.importance = classification.importance;
          }
          const cl = classification;
          if (tags === undefined && cl.tags) update.tags = cl.tags;
          if (people === undefined && cl.people) update.people = cl.people;
        }

        const { data, error } = await supabase
          .from("memories")
          .update(update)
          .eq("id", id)
          .select("id, title, category")
          .single();

        if (error) throw new Error("Memory update failed");
        if (!data) throw new Error(`Memory ${id} not found.`);
        return `Memory updated: "${data.title || data.id}" (${data.category})`;
      },
    ),
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete Memory",
      description: "Permanently delete a memory by ID.",
      inputSchema: {
        id: z.string().uuid().describe("Memory ID to delete"),
      },
    },
    wrapHandler(async ({ id }) => {
      const { data, error } = await supabase
        .from("memories")
        .delete()
        .eq("id", id)
        .select("id, title")
        .single();

      if (error) throw new Error("Memory delete failed");
      if (!data) throw new Error(`Memory ${id} not found.`);
      return `Deleted memory: "${data.title || data.id}"`;
    }),
  );
}
