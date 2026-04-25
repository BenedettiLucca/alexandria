import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// --- Config ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type AuthContext = {
  method: "jwt" | "key";
  userId: string;
  email?: string;
};

function getUserClient(auth?: AuthContext) {
  if (auth?.method === "jwt") {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: { Authorization: `Bearer ${auth.userId}` },
      },
      auth: { persistSession: false },
    });
  }
  return supabase;
}

import {
  VALID_CATEGORIES,
  VALID_SOURCES,
  sanitizeClassification,
  simpleClassify,
  recordToText,
  workoutToText,
} from "./lib.ts";

// --- Helpers ---

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}



async function classifyMemory(text: string): Promise<Record<string, unknown>> {
  const defaults = { category: "note", tags: ["uncategorized"], importance: 5, title: "Untitled", people: [], dates_mentioned: [] };
  try {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Classify this memory. Return JSON with:
- "category": one of ${JSON.stringify([...VALID_CATEGORIES])}
- "tags": array of 1-5 short lowercase tags
- "people": array of people mentioned (empty if none)
- "dates_mentioned": array of dates as YYYY-MM-DD (empty if none)
- "importance": 1-10 (1=trivial, 10=critical life event)
- "title": short descriptive title (max 60 chars)
- "entities": array of objects with "name" (string), "type" (one of: person, project, concept, location, technology, organization, event, other), "context" (the sentence or phrase where the entity was mentioned)
Only extract what is explicitly present.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!r.ok) return defaults;
    const d = await r.json();
    const parsed = JSON.parse(d.choices?.[0]?.message?.content || "{}");
    return sanitizeClassification(parsed);
  } catch {
    return defaults;
  }
}



function formatNum(n: unknown): string {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function wrapHandler(fn: (...args: any[]) => Promise<string>) {
  return async (...args: any[]) => {
    try {
      return ok(await fn(...args));
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  };
}

async function queryTable<T = any>(
  table: string,
  select: string,
  opts: {
    filters?: Record<string, any>;
    days?: number;
    daysColumn?: string;
    limit?: number;
    order?: string;
    ascending?: boolean;
    orderOpts?: { ascending: boolean; nullsFirst: boolean };
  } = {}
): Promise<T[]> {
  const {
    filters = {},
    days,
    daysColumn = "created_at",
    limit = 20,
    order = "created_at",
    ascending = false,
    orderOpts,
  } = opts;

  let q = supabase
    .from(table)
    .select(select)
    .order(order, orderOpts ?? { ascending, nullsFirst: false })
    .limit(limit);

  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }

  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    q = q.gte(daysColumn, since.toISOString());
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as T[]) || [];
}

const VALID_ENTITY_TYPES = [
  "person", "project", "concept", "location",
  "technology", "organization", "event", "other",
] as const;

async function processEntities(content: string, memoryId: string, rawEntities: unknown[]) {
  const validEntities = rawEntities
    .filter((e: any) => e?.name && e?.type)
    .map((e: any) => ({
      name: String(e.name).trim().slice(0, 200),
      type: VALID_ENTITY_TYPES.includes(e.type) ? e.type : "other",
      context: e.context ? String(e.context).slice(0, 500) : null,
    }));

  for (const ent of validEntities) {
    const { data: existing, error: lookupErr } = await supabase
      .from("entities")
      .select("id")
      .eq("name", ent.name)
      .eq("entity_type", ent.type)
      .maybeSingle();

    if (lookupErr) continue;

    const entityId = existing?.id;

    if (entityId) {
      await supabase
        .from("entity_mentions")
        .upsert(
          { memory_id: memoryId, entity_id: entityId, context: ent.context },
          { onConflict: "memory_id,entity_id" }
        );
    } else {
      const { data: created, error: insErr } = await supabase
        .from("entities")
        .insert({ name: ent.name, entity_type: ent.type })
        .select("id")
        .single();

      if (insErr || !created) continue;

      await supabase
        .from("entity_mentions")
        .insert({ memory_id: memoryId, entity_id: created.id, context: ent.context });
    }
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: "alexandria",
  version: "1.0.0",
});

// ============================================================
// MEMORY TOOLS
// ============================================================

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

    if (error) throw new Error(`Search error: ${error.message}`);
    if (!data || data.length === 0)
      return `No memories found matching "${query}".`;

    const results = data.map(
      (t: any, i: number) => {
        const parts = [
          `--- ${i + 1}. ${(t.similarity * 100).toFixed(1)}% match ---`,
          `Title: ${t.title || "Untitled"}`,
          `Category: ${t.category} | Importance: ${t.importance}/10`,
          `Date: ${new Date(t.created_at).toLocaleDateString()}`,
        ];
        if (t.tags?.length) parts.push(`Tags: ${t.tags.join(", ")}`);
        parts.push(`\n${t.content}`);
        return parts.join("\n");
      }
    );

    return `Found ${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${results.join("\n\n")}`;
  })
);

server.registerTool(
  "capture_memory",
  {
    title: "Capture Memory",
    description:
      "Save a new memory to Alexandria. Auto-generates embedding, classifies category/tags/importance, and deduplicates. Use when the user wants to save a note, idea, decision, or any piece of knowledge.",
    inputSchema: {
      content: z.string().describe("The memory content -- a clear, standalone statement"),
      title: z.string().optional().describe("Optional title (auto-generated if omitted)"),
      category: z.string().optional().describe("Override auto-classification"),
      importance: z.number().optional().describe("Override auto-importance (1-10)"),
      tags: z.array(z.string()).optional().describe("Additional tags"),
      people: z.array(z.string()).optional().describe("People mentioned"),
    },
  },
  wrapHandler(async ({ content, title, category, importance, tags, people }) => {
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
      }
    );

    if (upsertError) throw new Error(`Capture failed: ${upsertError.message}`);

    const thoughtId = upsertResult?.id;
    const { error: embError } = await supabase
      .from("memories")
      .update({ embedding })
      .eq("id", thoughtId);

    if (embError) throw new Error(`Embedding save failed: ${embError.message}`);

    try {
      const rawEntities = Array.isArray(cl.entities) ? cl.entities : [];
      if (rawEntities.length > 0 && thoughtId) {
        await processEntities(content, thoughtId as string, rawEntities);
      }
    } catch { /* non-blocking */ }

    const classifier = useLLM ? "LLM" : "keyword";
    const status = upsertResult?.status === "updated" ? "Updated existing" : "Captured new";
    let confirmation = `${status} memory as "${finalCategory}" (importance ${finalImportance}/10, classified via ${classifier})`;
    if (allTags.length) confirmation += `\nTags: ${allTags.join(", ")}`;
    if (allPeople.length) confirmation += `\nPeople: ${allPeople.join(", ")}`;

    return confirmation;
  })
);

server.registerTool(
  "list_memories",
  {
    title: "List Recent Memories",
    description:
      "List memories with optional filters. Use when the user wants to browse recent memories or filter by category, tag, source, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      category: z.string().optional().describe("Filter: note, idea, decision, observation, reference, task, person, recipe, travel, purchase, quote"),
      tag: z.string().optional().describe("Filter by single tag"),
      source: z.string().optional().describe("Filter by source: manual, mcp, import, capture, health-connect, iron-log, auto"),
      days: z.number().optional().describe("Only memories from last N days"),
      importance_min: z.number().optional().describe("Minimum importance (1-10)"),
    },
  },
  wrapHandler(async ({ limit, category, tag, source, days, importance_min }) => {
    const filters: Record<string, any> = {};
    if (category) filters.category = category;
    if (source) filters.source = source;

    let q = supabase
      .from("memories")
      .select("id, content, title, category, source, importance, tags, created_at")
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

    const results = data.map((t: any, i: number) => {
      const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
      return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] ${t.category}${tags} (${t.importance}/10)\n   ${t.title || t.content.slice(0, 120)}`;
    });

    return `${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${results.join("\n\n")}`;
  })
);

server.registerTool(
  "memory_stats",
  {
    title: "Memory Statistics",
    description: "Summary of all memories: totals by category, top tags, people mentioned, date range.",
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
      if (r.tags) for (const t of r.tags) tags[t] = (tags[t] || 0) + 1;
      if (r.people) for (const p of r.people) people[p] = (people[p] || 0) + 1;
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
      lines.push("", "Top tags:", ...sort(tags).map(([k, v]) => `  ${k}: ${v}`));
    }
    if (Object.keys(people).length) {
      lines.push("", "People:", ...sort(people).map(([k, v]) => `  ${k}: ${v}`));
    }

    return lines.join("\n");
  })
);

// ============================================================
// PROFILE TOOLS
// ============================================================

server.registerTool(
  "get_profile",
  {
    title: "Get Profile",
    description:
      "Retrieve profile data. Use when you need to know about the user's identity, preferences, development stack, environment, or other stored profile data.",
    inputSchema: {
      key: z.string().optional().describe("Specific profile key (e.g. 'identity', 'preferences', 'stack'). Omit for all."),
    },
  },
  wrapHandler(async ({ key }) => {
    const client = getUserClient(currentAuth);
    const isJwt = currentAuth?.method === "jwt";
    const qBase = isJwt
      ? client.from("profile").select("key, value, updated_at").eq("owner_id", currentAuth.userId)
      : client.from("profile").select("key, value, updated_at").is("owner_id", null);

    if (key) {
      const { data, error } = await qBase.eq("key", key).single();
      if (error) throw new Error(`Profile key "${key}" not found.`);
      return `Profile: ${data.key}\nUpdated: ${new Date(data.updated_at).toLocaleDateString()}\n\n${JSON.stringify(data.value, null, 2)}`;
    }

    const { data, error } = await qBase.order("key");
    if (error) throw new Error(error.message);
    if (!data?.length) return "Profile is empty. Use set_profile to add entries.";

    const sections = data.map((s: any) =>
      `== ${s.key} == (updated ${new Date(s.updated_at).toLocaleDateString()})\n${JSON.stringify(s.value, null, 2)}`
    );
    return `User Profile:\n\n${sections.join("\n\n")}`;
  })
);

server.registerTool(
  "set_profile",
  {
    title: "Set Profile",
    description:
      "Create or update a profile section. Use when the user tells you about themselves, their preferences, their stack, or any persistent identity information.",
    inputSchema: {
      key: z.string().describe("Profile section key (e.g. 'identity', 'preferences', 'stack', 'environment')"),
      value: z.record(z.any()).describe("Profile data as a JSON object"),
    },
  },
  wrapHandler(async ({ key, value }) => {
    const client = getUserClient(currentAuth);
    const isJwt = currentAuth?.method === "jwt";
    const ownerFilter = isJwt
      ? { owner_id: currentAuth.userId }
      : { owner_id: null };

    const row = { key, value, updated_at: new Date().toISOString(), ...ownerFilter };

    const { error } = await client
      .from("profile")
      .upsert(row, { onConflict: isJwt ? "key,owner_id" : "key" });

    if (error) throw new Error(`Failed: ${error.message}`);
    return `Profile "${key}" saved.`;
  })
);

// ============================================================
// PROJECT TOOLS
// ============================================================

server.registerTool(
  "whoami",
  {
    title: "Auth Status",
    description: "Return the current authentication context: user ID, email, auth method (JWT or API key), and profile sections.",
    inputSchema: {},
  },
  wrapHandler(async () => {
    const auth = currentAuth;
    if (!auth) throw new Error("Not authenticated.");

    const lines = [
      `Auth method: ${auth.method === "jwt" ? "JWT Bearer token" : "Static API key"}`,
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
        profileKeys.forEach((p: any) => lines.push(`  - ${p.key}`));
      }
    }

    return lines.join("\n");
  })
);

server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List tracked projects and their status.",
    inputSchema: {
      status: z.string().optional().describe("Filter: active, paused, archived"),
    },
  },
  wrapHandler(async ({ status }) => {
    const data = await queryTable(
      "projects",
      "id, name, path, status, stack, created_at, updated_at",
      { filters: status ? { status } : {}, order: "updated_at", ascending: false }
    );

    if (!data.length) return "No projects tracked yet.";

    const results = data.map((p: any, i: number) => {
      const stack = p.stack?.length ? ` [${p.stack.join(", ")}]` : "";
      return `${i + 1}. ${p.name} (${p.status})${stack}\n   Path: ${p.path || "N/A"} | Updated: ${new Date(p.updated_at).toLocaleDateString()}`;
    });
    return `${data.length} project(s):\n\n${results.join("\n\n")}`;
  })
);

server.registerTool(
  "save_project",
  {
    title: "Save Project",
    description: "Create or update a project record. Use when onboarding a new codebase or updating project context.",
    inputSchema: {
      name: z.string().describe("Project name"),
      path: z.string().optional().describe("Filesystem path"),
      description: z.string().optional().describe("What this project does"),
      stack: z.array(z.string()).optional().describe("Tech stack (e.g. ['python', 'fastapi', 'postgres'])"),
      conventions: z.record(z.any()).optional().describe("Coding conventions (commit style, linting, testing)"),
      status: z.string().optional().describe("active, paused, or archived"),
    },
  },
  wrapHandler(async ({ name, path, description, stack, conventions, status }) => {
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
      if (error) throw new Error(`Update failed: ${error.message}`);
      return `Project "${name}" updated.`;
    }

    const { error } = await supabase.from("projects").insert(update);
    if (error) throw new Error(`Create failed: ${error.message}`);
    return `Project "${name}" created.`;
  })
);

// ============================================================
// HEALTH TOOLS
// ============================================================

server.registerTool(
  "log_health",
  {
    title: "Log Health Entry",
    description: "Record a health data point. Use for manual logging or data imports from Health Connect.",
    inputSchema: {
      entry_type: z.string().describe("Type: sleep, exercise, heart_rate, steps, weight, water, nutrition, blood_pressure, stress, cycle, body_composition"),
      timestamp: z.string().describe("ISO 8601 timestamp"),
      duration_s: z.number().optional().describe("Duration in seconds"),
      value: z.record(z.any()).describe("Health data as JSON (varies by type)"),
      tags: z.array(z.string()).optional(),
      event_time: z.string().optional().describe("ISO 8601 timestamp for when the event actually happened (distinct from ingestion time)"),
      numeric_value: z.number().optional().describe("Primary numeric value (e.g. bpm for heart_rate, kg for weight, duration_hours for sleep)"),
      ingestion_source: z.string().optional().describe("Source system: health-connect, iron-log, health-api, mcp"),
      external_id: z.string().optional().describe("External record ID from source system for upsert dedup"),
    },
  },
  wrapHandler(async ({ entry_type, timestamp, duration_s, value, tags, event_time, numeric_value, ingestion_source, external_id }) => {
    const row: Record<string, unknown> = {
      entry_type,
      timestamp,
      duration_s: duration_s || null,
      value,
      tags: tags || [],
      source: "mcp",
    };
    if (event_time !== undefined) row.event_time = event_time;
    if (numeric_value !== undefined) row.numeric_value = numeric_value;
    if (ingestion_source !== undefined) row.ingestion_source = ingestion_source;
    if (external_id !== undefined) row.external_id = external_id;

    const { data, error } = await supabase
      .from("health_entries")
      .insert(row)
      .select("id")
      .single();

    if (error) throw new Error(`Health log failed: ${error.message}`);
    const id = data?.id;
    const ts = event_time || timestamp;

    try {
      const text = recordToText(entry_type, { ...row, event_time: row.event_time || timestamp });
      const embedding = await getEmbedding(text);
      await supabase.from("health_entries").update({ embedding }).eq("id", id);
    } catch { /* non-blocking */ }

    return `Health entry logged: ${entry_type} at ${new Date(ts).toLocaleString()}`;
  })
);

server.registerTool(
  "query_health",
  {
    title: "Query Health Data",
    description: "Search and filter health entries. Use when the user asks about their health history.",
    inputSchema: {
      entry_type: z.string().optional().describe("Filter by type"),
      days: z.number().optional().describe("Last N days"),
      limit: z.number().optional().default(20),
      event_from: z.string().optional().describe("Filter from event_time (ISO 8601)"),
      event_to: z.string().optional().describe("Filter to event_time (ISO 8601)"),
    },
  },
  wrapHandler(async ({ entry_type, days, limit, event_from, event_to }) => {
    let q = supabase
      .from("health_entries")
      .select("entry_type, timestamp, event_time, duration_s, numeric_value, value, tags")
      .order("event_time", { ascending: false, nullsFirst: false })
      .limit(limit);

    if (entry_type) q = q.eq("entry_type", entry_type);
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      q = q.gte("event_time", since.toISOString());
    }
    if (event_from) q = q.gte("event_time", event_from);
    if (event_to) q = q.lte("event_time", event_to);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) return "No health entries found.";

    const results = data.map((e: any, i: number) => {
      const ts = new Date(e.event_time || e.timestamp).toLocaleString();
      const dur = e.duration_s ? ` (${Math.round(e.duration_s / 60)}min)` : "";
      const numVal = e.numeric_value != null ? ` [${e.numeric_value}]` : "";
      return `${i + 1}. [${ts}] ${e.entry_type}${dur}${numVal}\n   ${JSON.stringify(e.value)}`;
    });
    return `${data.length} health entries:\n\n${results.join("\n\n")}`;
  })
);

server.registerTool(
  "search_health",
  {
    title: "Search Health (Semantic)",
    description:
      "Search health entries by semantic meaning. Use when the user asks about health patterns like 'days I slept poorly', 'high heart rate episodes', 'when did I walk a lot'.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.3),
      entry_type: z.string().optional().describe("Filter by entry type (e.g. sleep, steps, heart_rate)"),
    },
  },
  wrapHandler(async ({ query, limit, threshold, entry_type }) => {
    const qEmb = await getEmbedding(query);
    const { data, error } = await supabase.rpc("search_health_entries", {
      query_embedding: qEmb,
      match_threshold: threshold,
      match_count: limit,
      filter_entry_type: entry_type || null,
    });

    if (error) throw new Error(`Search error: ${error.message}`);
    if (!data || data.length === 0)
      return `No health entries found matching "${query}".`;

    const results = data.map(
      (t: any, i: number) => {
        const parts = [
          `--- ${i + 1}. ${(t.similarity * 100).toFixed(1)}% match ---`,
          `Type: ${t.entry_type}`,
          `Date: ${new Date(t.event_time || t.timestamp).toLocaleString()}`,
        ];
        if (t.numeric_value != null) parts.push(`Value: ${t.numeric_value}`);
        if (t.duration_s) parts.push(`Duration: ${Math.round(t.duration_s / 60)}min`);
        parts.push(`\n${JSON.stringify(t.value)}`);
        return parts.join("\n");
      }
    );

    return `Found ${data.length} health entr${data.length === 1 ? "y" : "ies"}:\n\n${results.join("\n\n")}`;
  })
);

// ============================================================
// TRAINING TOOLS
// ============================================================

server.registerTool(
  "log_workout",
  {
    title: "Log Workout",
    description: "Record a training session. Use for manual logging or Iron-Log imports.",
    inputSchema: {
      workout_date: z.string().describe("Date YYYY-MM-DD"),
      workout_type: z.string().describe("Type: strength, cardio, flexibility, other"),
      name: z.string().describe("Workout name (e.g. 'Push Day', '5K Run')"),
      exercises: z.array(z.record(z.any())).describe("Array of exercises: [{name, sets, reps, weight_kg, rpe, notes}]"),
      duration_s: z.number().optional().describe("Duration in seconds"),
      volume_kg: z.number().optional().describe("Total volume in kg"),
      rpe: z.number().optional().describe("Overall RPE 1-10"),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      event_time: z.string().optional().describe("ISO 8601 timestamp for when the workout actually happened"),
      ingestion_source: z.string().optional().describe("Source system: iron-log, health-connect, mcp"),
      external_id: z.string().optional().describe("External record ID from source system for upsert dedup"),
    },
  },
  wrapHandler(async ({ workout_date, workout_type, name, exercises, duration_s, volume_kg, rpe, notes, tags, event_time, ingestion_source, external_id }) => {
    const row: Record<string, unknown> = {
      workout_date,
      workout_type,
      name,
      exercises,
      duration_s: duration_s || null,
      volume_kg: volume_kg || null,
      rpe: rpe || null,
      notes: notes || null,
      tags: tags || [],
    };
    if (event_time !== undefined) row.event_time = event_time;
    if (ingestion_source !== undefined) row.ingestion_source = ingestion_source;
    if (external_id !== undefined) row.external_id = external_id;

    const { data, error } = await supabase
      .from("training_logs")
      .insert(row)
      .select("id")
      .single();

    if (error) throw new Error(`Workout log failed: ${error.message}`);
    const id = data?.id;

    try {
      const text = workoutToText({ ...row, event_time: row.event_time || workout_date });
      const embedding = await getEmbedding(text);
      await supabase.from("training_logs").update({ embedding }).eq("id", id);
    } catch { /* non-blocking */ }

    return `Workout logged: ${name} (${workout_type}) on ${workout_date}`;
  })
);

server.registerTool(
  "query_workouts",
  {
    title: "Query Workouts",
    description: "Search training history. Use when the user asks about past workouts, progress, or training patterns.",
    inputSchema: {
      workout_type: z.string().optional().describe("Filter: strength, cardio, flexibility, other"),
      days: z.number().optional().describe("Last N days"),
      limit: z.number().optional().default(20),
    },
  },
  wrapHandler(async ({ workout_type, days, limit }) => {
    let q = supabase
      .from("training_logs")
      .select("workout_date, workout_type, name, exercises, volume_kg, rpe, notes, event_time")
      .order("event_time", { ascending: false, nullsFirst: false })
      .limit(limit);

    if (workout_type) q = q.eq("workout_type", workout_type);
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      q = q.gte("workout_date", since.toISOString().split("T")[0]);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) return "No workouts found.";

    const results = data.map((w: any, i: number) => {
      const vol = w.volume_kg ? ` | Vol: ${w.volume_kg}kg` : "";
      const rpe = w.rpe ? ` | RPE: ${w.rpe}` : "";
      const exCount = Array.isArray(w.exercises) ? `${w.exercises.length} exercises` : "";
      return `${i + 1}. [${w.workout_date}] ${w.name} (${w.workout_type})${vol}${rpe}\n   ${exCount}${w.notes ? " -- " + w.notes : ""}`;
    });
    return `${data.length} workout(s):\n\n${results.join("\n\n")}`;
  })
);

server.registerTool(
  "search_workouts",
  {
    title: "Search Workouts (Semantic)",
    description:
      "Search training logs by semantic meaning. Use when the user asks about training patterns like 'heavy bench press days', 'cardio sessions last month', 'high volume workouts'.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.3),
      workout_type: z.string().optional().describe("Filter: strength, cardio, flexibility, other"),
    },
  },
  wrapHandler(async ({ query, limit, threshold, workout_type }) => {
    const qEmb = await getEmbedding(query);
    const { data, error } = await supabase.rpc("search_training_logs", {
      query_embedding: qEmb,
      match_threshold: threshold,
      match_count: limit,
      filter_workout_type: workout_type || null,
    });

    if (error) throw new Error(`Search error: ${error.message}`);
    if (!data || data.length === 0)
      return `No workouts found matching "${query}".`;

    const results = data.map(
      (t: any, i: number) => {
        const parts = [
          `--- ${i + 1}. ${(t.similarity * 100).toFixed(1)}% match ---`,
          `Workout: ${t.name} (${t.workout_type}) on ${t.workout_date}`,
        ];
        if (t.volume_kg != null) parts.push(`Volume: ${t.volume_kg}kg`);
        if (t.rpe != null) parts.push(`RPE: ${t.rpe}`);
        if (t.duration_s) parts.push(`Duration: ${Math.round(t.duration_s / 60)}min`);
        if (t.exercises?.length) {
          const exList = t.exercises.map((e: any) => {
            const sets = e.sets != null ? `${e.sets}x` : "";
            const reps = e.reps != null ? `${e.reps}` : "";
            const w = e.weight_kg != null ? `@${e.weight_kg}kg` : "";
            return `  - ${e.name} ${sets}${reps}${w}`.trim();
          });
          parts.push(`Exercises:\n${exList.join("\n")}`);
        }
        if (t.notes) parts.push(`Notes: ${t.notes}`);
        return parts.join("\n");
      }
    );

    return `Found ${data.length} workout(s):\n\n${results.join("\n\n")}`;
  })
);

// ============================================================
// DERIVED METRICS TOOLS
// ============================================================

server.registerTool(
  "health_summary",
  {
    title: "Health Summary",
    description:
      "View daily aggregated health summaries. Use when the user asks about their daily or weekly health overview, sleep stats, step counts, heart rate trends, or training volume.",
    inputSchema: {
      days: z.number().optional().default(7).describe("Number of recent days to show"),
      from: z.string().optional().describe("Start date YYYY-MM-DD (overrides days)"),
      to: z.string().optional().describe("End date YYYY-MM-DD (overrides days)"),
    },
  },
  wrapHandler(async ({ days, from, to }) => {
    let q = supabase
      .from("health_summaries")
      .select("*")
      .order("date", { ascending: false })
      .limit(days);

    if (from) q = q.gte("date", from);
    if (to) q = q.lte("date", to);
    if (!from) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      q = q.gte("date", since.toISOString().split("T")[0]);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) return "No summary computed yet. Use refresh_summary to generate one.";

    const lines = data.map((s: any) => {
      const parts = [`== ${s.date} ==`];
      if (s.sleep_total_hours != null) parts.push(`Sleep: ${s.sleep_total_hours}h (${s.sleep_sessions || 0} sessions)`);
      if (s.steps_total != null) parts.push(`Steps: ${s.steps_total}${s.steps_active_minutes ? ` (${s.steps_active_minutes}min active)` : ""}`);
      if (s.hr_avg != null) parts.push(`HR: avg ${s.hr_avg} / min ${s.hr_min} / max ${s.hr_max} bpm (${s.hr_samples} samples)`);
      if (s.weight_kg != null) parts.push(`Weight: ${s.weight_kg}kg`);
      if (s.exercise_count > 0) parts.push(`Exercise: ${s.exercise_count} sessions, ${s.exercise_total_minutes}min${s.exercise_types?.length ? ` [${s.exercise_types.join(", ")}]` : ""}`);
      if (s.workout_count > 0) parts.push(`Training: ${s.workout_count} workouts${s.training_volume_kg ? `, ${s.training_volume_kg}kg vol` : ""}${s.training_types?.length ? ` [${s.training_types.join(", ")}]` : ""}`);
      if (s.sources?.length) parts.push(`Sources: ${s.sources.join(", ")}`);
      return parts.join("\n");
    });

    return `${data.length} day(s):\n\n${lines.join("\n\n")}`;
  })
);

server.registerTool(
  "refresh_summary",
  {
    title: "Refresh Summary",
    description:
      "Compute or re-compute daily health summaries from raw health_entries and training_logs. Use after importing new data or to recalculate summaries.",
    inputSchema: {
      date: z.string().optional().describe("Single date YYYY-MM-DD to refresh"),
      days: z.number().optional().default(1).describe("Number of recent days to refresh (used when date is omitted)"),
    },
  },
  wrapHandler(async ({ date, days }) => {
    const dates: string[] = [];
    if (date) {
      dates.push(date);
    } else {
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split("T")[0]);
      }
    }

    let computed = 0;
    const errors: string[] = [];

    for (const d of dates) {
      const { error: rpcError } = await supabase.rpc("compute_daily_summary", {
        target_date: d,
      });
      if (rpcError) {
        errors.push(`${d}: ${rpcError.message}`);
      } else {
        computed++;
      }
    }

    let result = `Refreshed ${computed} of ${dates.length} summary(s).`;
    if (errors.length) result += `\n\nErrors:\n${errors.join("\n")}`;
    return result;
  })
);

// ============================================================
// ENTITY / KNOWLEDGE GRAPH TOOLS
// ============================================================

server.registerTool(
  "search_entities",
  {
    title: "Search Entities",
    description:
      "Search the knowledge graph for entities by name. Use when the user asks about a person, project, concept, technology, organization, location, or event they've mentioned in their memories.",
    inputSchema: {
      query: z.string().describe("Entity name or partial name to search for"),
      entity_type: z.string().optional().describe("Filter: person, project, concept, location, technology, organization, event, other"),
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

    const results = data.map((e: any, i: number) => {
      const desc = e.description ? `\n   ${e.description}` : "";
      return `${i + 1}. ${e.name} (${e.entity_type})${desc}`;
    });

    return `${data.length} entit${data.length === 1 ? "y" : "ies"} found:\n\n${results.join("\n")}`;
  })
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

    const memById = new Map(memoryDetails.map((m: any) => [m.id, m]));
    const lines = [
      `== ${entity.name} (${entity.entity_type}) ==`,
      entity.description ? `Description: ${entity.description}` : "",
      entity.aliases?.length ? `Aliases: ${entity.aliases.join(", ")}` : "",
      `Created: ${new Date(entity.created_at).toLocaleDateString()}`,
      `Mentioned in ${(mentions || []).length} memories`,
    ].filter(Boolean);

    if (mentions?.length) {
      lines.push("", "Related memories:");
      mentions.forEach((m: any, i: number) => {
        const mem = memById.get(m.memory_id);
        if (mem) {
          lines.push(`  ${i + 1}. [${new Date(mem.created_at).toLocaleDateString()}] ${mem.category}: ${mem.title || mem.content.slice(0, 100)}`);
          if (m.context) lines.push(`     "${m.context}"`);
        }
      });
    }

    return lines.join("\n");
  })
);

server.registerTool(
  "list_entities",
  {
    title: "List Entities",
    description:
      "List all entities in the knowledge graph, optionally filtered by type. Sorted by number of mentions (most connected first). Use to browse the knowledge graph.",
    inputSchema: {
      entity_type: z.string().optional().describe("Filter: person, project, concept, location, technology, organization, event, other"),
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
      .map((e: any) => ({ ...e, mention_count: countByEntity.get(e.id) || 0 }))
      .sort((a: any, b: any) => b.mention_count - a.mention_count)
      .slice(0, limit);

    const results = sorted.map((e: any, i: number) =>
      `${i + 1}. ${e.name} (${e.entity_type}) — ${e.mention_count} mention${e.mention_count === 1 ? "" : "s"}`
    );

    return `${sorted.length} entit${sorted.length === 1 ? "y" : "ies"}:\n\n${results.join("\n")}`;
  })
);

// ============================================================
// CRUD TOOLS
// ============================================================

server.registerTool(
  "update_memory",
  {
    title: "Update Memory",
    description: "Update an existing memory. If content changes, the embedding is regenerated and the memory is reclassified.",
    inputSchema: {
      id: z.string().uuid().describe("Memory ID to update"),
      content: z.string().optional().describe("New content (triggers re-embedding + reclassification)"),
      title: z.string().optional(),
      category: z.string().optional(),
      importance: z.number().min(1).max(10).optional(),
      tags: z.array(z.string()).optional(),
      people: z.array(z.string()).optional(),
    },
  },
  wrapHandler(async ({ id, content, title, category, importance, tags, people }) => {
    const update: Record<string, unknown> = {};
    if (title !== undefined) update.title = title;
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category as any)) throw new Error(`Invalid category: "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
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
      if (!title) update.title = classification.title || null;
      if (!category) update.category = classification.category;
      if (importance === undefined) update.importance = classification.importance;
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

    if (error) throw new Error(`Update failed: ${error.message}`);
    if (!data) throw new Error(`Memory ${id} not found.`);
    return `Memory updated: "${data.title || data.id}" (${data.category})`;
  })
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

    if (error) throw new Error(`Delete failed: ${error.message}`);
    if (!data) throw new Error(`Memory ${id} not found.`);
    return `Deleted memory: "${data.title || data.id}"`;
  })
);

server.registerTool(
  "delete_health_entry",
  {
    title: "Delete Health Entry",
    description: "Permanently delete a health entry by ID.",
    inputSchema: {
      id: z.string().uuid().describe("Health entry ID to delete"),
    },
  },
  wrapHandler(async ({ id }) => {
    const { data, error } = await supabase
      .from("health_entries")
      .delete()
      .eq("id", id)
      .select("id, entry_type, timestamp")
      .single();

    if (error) throw new Error(`Delete failed: ${error.message}`);
    if (!data) throw new Error(`Health entry ${id} not found.`);
    return `Deleted health entry: ${data.entry_type} at ${new Date(data.timestamp).toLocaleString()}`;
  })
);

server.registerTool(
  "update_workout",
  {
    title: "Update Workout",
    description: "Update an existing training log entry.",
    inputSchema: {
      id: z.string().uuid().describe("Workout ID to update"),
      name: z.string().optional(),
      workout_type: z.string().optional(),
      exercises: z.array(z.record(z.any())).optional().describe("Array of exercises: [{name, sets, reps, weight_kg, rpe, notes}]"),
      duration_s: z.number().optional(),
      volume_kg: z.number().optional(),
      rpe: z.number().min(1).max(10).optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  wrapHandler(async ({ id, name, workout_type, exercises, duration_s, volume_kg, rpe, notes, tags }) => {
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name;
    if (workout_type !== undefined) update.workout_type = workout_type;
    if (exercises !== undefined) update.exercises = exercises;
    if (duration_s !== undefined) update.duration_s = duration_s;
    if (volume_kg !== undefined) update.volume_kg = volume_kg;
    if (rpe !== undefined) update.rpe = rpe;
    if (notes !== undefined) update.notes = notes;
    if (tags !== undefined) update.tags = tags;

    const { data, error } = await supabase
      .from("training_logs")
      .update(update)
      .eq("id", id)
      .select("id, name, workout_type, workout_date")
      .single();

    if (error) throw new Error(`Update failed: ${error.message}`);
    if (!data) throw new Error(`Workout ${id} not found.`);
    return `Workout updated: "${data.name}" (${data.workout_type}) on ${data.workout_date}`;
  })
);

server.registerTool(
  "sync_status",
  {
    title: "Sync Status",
    description: "View recent sync history from the sync_log table.",
    inputSchema: {
      source: z.string().optional().describe("Filter by source: iron-log, health-connect, health-api"),
      limit: z.number().optional().default(10),
    },
  },
  wrapHandler(async ({ source, limit }) => {
    const filters: Record<string, any> = {};
    if (source) filters.source = source;

    let q = supabase
      .from("sync_log")
      .select("id, source, sync_type, records_processed, records_imported, records_skipped, records_failed, started_at, completed_at, status, error_message")
      .order("started_at", { ascending: false })
      .limit(limit);

    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) return "No sync history found.";

    const results = data.map((s: any, i: number) => {
      const started = new Date(s.started_at).toLocaleString();
      const completed = s.completed_at ? new Date(s.completed_at).toLocaleString() : "—";
      const dur = s.completed_at
        ? `${Math.round((new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000)}s`
        : "—";
      const errLine = s.error_message ? `\n   Error: ${s.error_message}` : "";
      return `${i + 1}. [${started}] ${s.source} (${s.sync_type}) — ${s.status}${errLine}\n   Processed: ${s.records_processed} | Imported: ${s.records_imported} | Skipped: ${s.records_skipped} | Failed: ${s.records_failed}\n   Duration: ${dur} | Completed: ${completed}`;
    });

    return `${data.length} sync(s):\n\n${results.join("\n\n")}`;
  })
);

// ============================================================
// HONO APP -- Auth + CORS + MCP Transport
// ============================================================

let currentAuth: AuthContext | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

async function authenticate(c: any): Promise<AuthContext | null> {
  const authHeader = c.req.header("authorization") || c.req.header("Authorization");

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

  const keyProvided =
    c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");

  if (keyProvided && keyProvided === MCP_ACCESS_KEY) {
    return { method: "key", userId: "service-role" };
  }

  return null;
}

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const auth = await authenticate(c);
  if (!auth) {
    return c.json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  currentAuth = auth;

  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
