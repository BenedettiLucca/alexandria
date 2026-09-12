import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthContext, supabase } from "../config.ts";
import type { SearchMemoryRow } from "../types.ts";
import {
  classifyMemory,
  getEmbedding,
  wrapHandler,
} from "../helpers.ts";

import {
  memoryToText,
  sanitizeEntities,
  simpleClassify,
  VALID_CATEGORIES,
} from "../lib.ts";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
      });

      if (error) throw new Error(error.message);

      let results = (data || []) as SearchMemoryRow[];
      if (category) results = results.filter((m) => m.category === category);
      if (tags && tags.length > 0) {
        results = results.filter((m) =>
          m.tags && tags.some((t: string) => m.tags!.includes(t))
        );
      }

      if (!results.length) return `No memories found matching "${query}".`;

      const formatted = results.map(
        (t, i: number) =>
          memoryToText(t, { index: i, includeSimilarity: true }),
      );

      return `${data.length} memor${
        data.length === 1 ? "y" : "ies"
      }:\n\n${formatted.join("\n\n")}`;
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
        category: z.string().optional().describe(
          "Override auto-classification",
        ),
        importance: z.number().optional().describe(
          "Override auto-importance (1-10)",
        ),
        tags: z.array(z.string()).optional().describe("Additional tags"),
        people: z.array(z.string()).optional().describe("People mentioned"),
      },
    },
    wrapHandler(
      async ({ content, title, category, importance, tags, people }) => {
        const contentHash = await sha256Hex(content);

        // Check if an identical memory already exists (no-change avoids provider)
        const { data: existing } = await supabase
          .from("memories")
          .select("id, embedding, embedding_status, enrichment_status, embedding_version, category, importance, title, tags, people, metadata")
          .eq("content_hash", contentHash)
          .maybeSingle();

        let embedding: number[] | null = null;
        let classification: any = null;
        let classifierName = "keyword";
        let finalCategory = category || "note";
        let finalImportance = importance || 5;
        let finalTitle = title || null;
        let allTags: string[] = tags || [];
        let allPeople: string[] = people || [];
        const rawEntities: unknown[] = [];

        if (existing && existing.embedding) {
          // No-change path: reuse existing classification/embedding without calling external provider
          finalCategory = category || existing.category || "note";
          finalImportance = importance !== undefined ? importance : (existing.importance || 5);
          finalTitle = title !== undefined ? title : (existing.title || null);
          const autoTags = (existing.tags as string[]) || [];
          const autoPeople = (existing.people as string[]) || [];
          allTags = [...new Set([...autoTags, ...(tags || [])])];
          allPeople = [...new Set([...autoPeople, ...(people || [])])];
          classifierName = (existing.metadata as any)?.classifier || "keyword";
        } else {
          // New content: execute provider for classification and embedding
          const useLLM = content.length > 200 || importance === undefined;
          classification = useLLM
            ? await classifyMemory(content)
            : simpleClassify(content);

          embedding = await getEmbedding(content);

          const cl = classification as Record<string, unknown>;
          const isModel = classification.status === "model";
          classifierName = isModel
            ? "LLM"
            : (classification.status === "fallback" ? "fallback" : "keyword");

          finalCategory = category || (cl.category as string) || "note";
          finalImportance = importance || (cl.importance as number) || 5;
          finalTitle = title || (cl.title as string) || null;
          const autoTags = (cl.tags as string[]) || [];
          const autoPeople = (cl.people as string[]) || [];
          allTags = [...new Set([...autoTags, ...(tags || [])])];
          allPeople = [...new Set([...autoPeople, ...(people || [])])];

          if (Array.isArray(cl.entities)) {
            rawEntities.push(...cl.entities);
          }
        }

        // Short path entities explicit: ensure all explicit people are included as entities
        for (const p of allPeople) {
          if (!rawEntities.some((e: any) => e && typeof e === "object" && e.name === p)) {
            rawEntities.push({ name: p, type: "person", context: null });
          }
        }
        const validEntities = sanitizeEntities(rawEntities);

        const metadataPayload: Record<string, unknown> = {
          dates_mentioned: classification?.dates_mentioned || (existing?.metadata as any)?.dates_mentioned || [],
          auto_classified: !category,
          classifier: classifierName,
          classifier_status: classification?.status || (classifierName === "LLM" ? "model" : (classifierName === "fallback" ? "fallback" : "keyword")),
          classifier_source: classification?.source || (classifierName === "LLM" ? "model" : "short_path"),
          error_class: classification?.error_class || null,
        };

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
            p_metadata: metadataPayload,
          },
        );

        if (upsertError) {
          throw new Error("Failed to save memory: " + upsertError.message);
        }

        const thoughtId = upsertResult?.id;
        if (!thoughtId) {
          throw new Error("Failed to save memory: missing row ID");
        }

        if (embedding) {
          const { error: embError } = await supabase
            .from("memories")
            .update({ embedding })
            .eq("id", thoughtId);

          if (embError) {
            throw new Error("Failed to save embedding: " + embError.message);
          }
        }

        // Transactional & idempotent graph reconciliation with version guard
        const { data: memRow, error: memErr } = await supabase
          .from("memories")
          .select("embedding_version")
          .eq("id", thoughtId)
          .single();

        if (memErr) {
          throw new Error("Failed to check memory version: " + memErr.message);
        }

        const { error: recError } = await supabase.rpc("reconcile_memory_entities", {
          p_memory_id: thoughtId,
          p_entities: validEntities,
          p_source_version: memRow.embedding_version,
        });

        if (recError) {
          throw new Error("Failed to reconcile entity graph: " + recError.message);
        }

        const status = upsertResult?.status === "updated"
          ? "Updated existing"
          : "Captured new";
        let confirmation =
          `${status} memory as "${finalCategory}" (importance ${finalImportance}/10, classified via ${classifierName})`;
        if (allTags.length) confirmation += `\nTags: ${allTags.join(", ")}`;
        if (allPeople.length) {
          confirmation += `\nPeople: ${allPeople.join(", ")}`;
        }

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
            t,
            i: number,
          ) => memoryToText(t, { index: i, includeSimilarity: true }),
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
      // Bounded SQL aggregation via RPC (no unbounded row transfer or JS materialization)
      const { data, error } = await supabase.rpc("get_memory_stats");
      if (error) {
        throw new Error("Failed to fetch memory statistics: " + error.message);
      }
      if (!data) {
        throw new Error("Failed to fetch memory statistics: empty response");
      }

      const count = Number(data.total_count ?? 0);
      const earliest = data.earliest_date ? new Date(data.earliest_date).toLocaleDateString() : null;
      const latest = data.latest_date ? new Date(data.latest_date).toLocaleDateString() : null;
      const dateRange = earliest && latest ? `${earliest} -> ${latest}` : "N/A";

      const categories = (data.categories || []) as Array<{ category: string; count: number }>;
      const topTags = (data.top_tags || []) as Array<{ tag: string; count: number }>;
      const topPeople = (data.top_people || []) as Array<{ person: string; count: number }>;

      const lines = [
        "Library of Alexandria -- Memory Statistics",
        `Total memories: ${count}`,
        `Date range: ${dateRange}`,
        "",
        "Categories:",
        ...categories.map((c) => `  ${c.category}: ${c.count}`),
      ];

      if (topTags.length) {
        lines.push("", "Top tags:", ...topTags.map((t) => `  ${t.tag}: ${t.count}`));
      }
      if (topPeople.length) {
        lines.push("", "People:", ...topPeople.map((p) => `  ${p.person}: ${p.count}`));
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
        // Fetch existing memory to guard ownership and detect actual content changes
        const { data: existing, error: fetchErr } = await supabase
          .from("memories")
          .select("*")
          .eq("id", id)
          .single();

        if (fetchErr || !existing) {
          throw new Error(`Memory ${id} not found.`);
        }

        const update: Record<string, unknown> = {};
        if (title !== undefined) update.title = title;
        if (category !== undefined) {
          if (
            !VALID_CATEGORIES.includes(
              category as (typeof VALID_CATEGORIES)[number],
            )
          ) {
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

        const contentChanged = content !== undefined && content !== existing.content;
        let classification: any = null;

        if (contentChanged) {
          // Changed content reindexes: execute embedding and classification
          update.content = content;
          const [embedding, clResult] = await Promise.all([
            getEmbedding(content),
            classifyMemory(content),
          ]);
          classification = clResult;
          update.embedding = embedding;
          if (!title) update.title = (classification.title as string) || null;
          if (!category) update.category = classification.category;
          if (importance === undefined) {
            update.importance = classification.importance;
          }
          if (tags === undefined && classification.tags) update.tags = classification.tags;
          if (people === undefined && classification.people) update.people = classification.people;
        } else if (content !== undefined) {
          // No-change: avoid calling provider
          update.content = content;
        }

        const { data: updatedMem, error: updateErr } = await supabase
          .from("memories")
          .update(update)
          .eq("id", id)
          .select("id, title, category, embedding_version, people")
          .single();

        if (updateErr || !updatedMem) {
          throw new Error("Memory update failed: " + (updateErr?.message || "unknown"));
        }

        // Reconcile graph mentions if content or people changed
        if (contentChanged || people !== undefined) {
          const rawEntities: unknown[] = [];
          if (contentChanged && classification && Array.isArray(classification.entities)) {
            rawEntities.push(...classification.entities);
          }
          const currentPeople: string[] = (people !== undefined ? people : (updatedMem.people as string[])) || [];
          for (const p of currentPeople) {
            if (!rawEntities.some((e: any) => e && typeof e === "object" && e.name === p)) {
              rawEntities.push({ name: p, type: "person", context: null });
            }
          }
          const validEntities = sanitizeEntities(rawEntities);

          const { error: recErr } = await supabase.rpc("reconcile_memory_entities", {
            p_memory_id: id,
            p_entities: validEntities,
            p_source_version: updatedMem.embedding_version,
          });

          if (recErr) {
            throw new Error("Failed to reconcile entity graph: " + recErr.message);
          }
        }

        return `Memory updated: "${updatedMem.title || updatedMem.id}" (${updatedMem.category})`;
      },
    ),
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete Memory",
      description:
        "Permanently delete a memory from Alexandria. Use when the user explicitly asks to forget or remove a memory.",
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

      if (error) throw new Error("Memory deletion failed");
      if (!data) throw new Error(`Memory ${id} not found.`);
      return `Memory deleted: "${data.title || data.id}"`;
    }),
  );
}
