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

const VALID_CATEGORIES = [
  "note", "idea", "decision", "observation",
  "reference", "task", "person", "recipe",
  "travel", "purchase", "quote",
] as const;

const VALID_SOURCES = [
  "manual", "mcp", "import", "capture",
  "health-connect", "iron-log", "auto",
] as const;

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

function sanitizeClassification(raw: Record<string, unknown>): Record<string, unknown> {
  let category = String(raw.category || "note").toLowerCase().trim();
  if (!VALID_CATEGORIES.includes(category as any)) category = "note";

  let importance = Number(raw.importance);
  if (Number.isNaN(importance) || importance < 1 || importance > 10) importance = 5;

  const rawTags = Array.isArray(raw.tags)
    ? (raw.tags as string[]).map((t) => String(t).toLowerCase().trim()).filter(Boolean)
    : [];
  const tags = [...new Set(rawTags)].slice(0, 5);

  const rawPeople = Array.isArray(raw.people)
    ? (raw.people as string[]).map((p) => String(p).trim()).filter(Boolean)
    : [];
  const people = [...new Set(rawPeople)].slice(0, 10);

  const title = typeof raw.title === "string"
    ? raw.title.slice(0, 60)
    : null;

  return { category, tags, people, importance, title, dates_mentioned: raw.dates_mentioned || [] };
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

function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
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
  async ({ query, limit, threshold, category, tags }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_memories", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_category: category || null,
        filter_tags: tags || null,
      });

      if (error) return err(`Search error: ${error.message}`);
      if (!data || data.length === 0)
        return ok(`No memories found matching "${query}".`);

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

      return ok(`Found ${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ content, title, category, importance, tags, people }) => {
    try {
      const [embedding, classification] = await Promise.all([
        getEmbedding(content),
        classifyMemory(content),
      ]);

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
            auto_classified: !category, // true if AI-picked the category
          },
        }
      );

      if (upsertError) return err(`Capture failed: ${upsertError.message}`);

      const thoughtId = upsertResult?.id;
      const { error: embError } = await supabase
        .from("memories")
        .update({ embedding })
        .eq("id", thoughtId);

      if (embError) return err(`Embedding save failed: ${embError.message}`);

      const status = upsertResult?.status === "updated" ? "Updated existing" : "Captured new";
      let confirmation = `${status} memory as "${finalCategory}" (importance ${finalImportance}/10)`;
      if (allTags.length) confirmation += `\nTags: ${allTags.join(", ")}`;
      if (allPeople.length) confirmation += `\nPeople: ${allPeople.join(", ")}`;

      return ok(confirmation);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ limit, category, tag, source, days, importance_min }) => {
    try {
      let q = supabase
        .from("memories")
        .select("id, content, title, category, source, importance, tags, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (category) q = q.eq("category", category);
      if (tag) q = q.contains("tags", [tag]);
      if (source) q = q.eq("source", source);
      if (importance_min) q = q.gte("importance", importance_min);
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;
      if (error) return err(`Error: ${error.message}`);
      if (!data || !data.length) return ok("No memories found.");

      const results = data.map((t: any, i: number) => {
        const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
        return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] ${t.category}${tags} (${t.importance}/10)\n   ${t.title || t.content.slice(0, 120)}`;
      });

      return ok(`${data.length} memor${data.length === 1 ? "y" : "ies"}:\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
);

server.registerTool(
  "memory_stats",
  {
    title: "Memory Statistics",
    description: "Summary of all memories: totals by category, top tags, people mentioned, date range.",
    inputSchema: {},
  },
  async () => {
    try {
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

      return ok(lines.join("\n"));
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ key }) => {
    try {
      if (key) {
        const { data, error } = await supabase
          .from("profile")
          .select("key, value, updated_at")
          .eq("key", key)
          .single();
        if (error) return err(`Profile key "${key}" not found.`);
        return ok(`Profile: ${data.key}\nUpdated: ${new Date(data.updated_at).toLocaleDateString()}\n\n${JSON.stringify(data.value, null, 2)}`);
      }

      const { data, error } = await supabase
        .from("profile")
        .select("key, value, updated_at")
        .order("key");

      if (error) return err(`Error: ${error.message}`);
      if (!data?.length) return ok("Profile is empty. Use set_profile to add entries.");

      const sections = data.map((s: any) =>
        `== ${s.key} == (updated ${new Date(s.updated_at).toLocaleDateString()})\n${JSON.stringify(s.value, null, 2)}`
      );
      return ok(`User Profile:\n\n${sections.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ key, value }) => {
    try {
      const { error } = await supabase
        .from("profile")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

      if (error) return err(`Failed: ${error.message}`);
      return ok(`Profile "${key}" saved.`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
);

// ============================================================
// PROJECT TOOLS
// ============================================================

server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List tracked projects and their status.",
    inputSchema: {
      status: z.string().optional().describe("Filter: active, paused, archived"),
    },
  },
  async ({ status }) => {
    try {
      let q = supabase
        .from("projects")
        .select("id, name, path, status, stack, created_at, updated_at")
        .order("updated_at", { ascending: false });
      if (status) q = q.eq("status", status);

      const { data, error } = await q;
      if (error) return err(`Error: ${error.message}`);
      if (!data?.length) return ok("No projects tracked yet.");

      const results = data.map((p: any, i: number) => {
        const stack = p.stack?.length ? ` [${p.stack.join(", ")}]` : "";
        return `${i + 1}. ${p.name} (${p.status})${stack}\n   Path: ${p.path || "N/A"} | Updated: ${new Date(p.updated_at).toLocaleDateString()}`;
      });
      return ok(`${data.length} project(s):\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ name, path, description, stack, conventions, status }) => {
    try {
      const update: Record<string, unknown> = {
        name,
        updated_at: new Date().toISOString(),
      };
      if (path !== undefined) update.path = path;
      if (description !== undefined) update.description = description;
      if (stack !== undefined) update.stack = stack;
      if (conventions !== undefined) update.conventions = conventions;
      if (status !== undefined) update.status = status;

      // Check if project exists by name
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
        if (error) return err(`Update failed: ${error.message}`);
        return ok(`Project "${name}" updated.`);
      }

      const { error } = await supabase.from("projects").insert(update);
      if (error) return err(`Create failed: ${error.message}`);
      return ok(`Project "${name}" created.`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ entry_type, timestamp, duration_s, value, tags, event_time, numeric_value, ingestion_source, external_id }) => {
    try {
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

      if (error) return err(`Health log failed: ${error.message}`);
      const ts = event_time || timestamp;
      return ok(`Health entry logged: ${entry_type} at ${new Date(ts).toLocaleString()}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ entry_type, days, limit, event_from, event_to }) => {
    try {
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
      if (error) return err(`Error: ${error.message}`);
      if (!data?.length) return ok("No health entries found.");

      const results = data.map((e: any, i: number) => {
        const ts = new Date(e.event_time || e.timestamp).toLocaleString();
        const dur = e.duration_s ? ` (${Math.round(e.duration_s / 60)}min)` : "";
        const numVal = e.numeric_value != null ? ` [${e.numeric_value}]` : "";
        return `${i + 1}. [${ts}] ${e.entry_type}${dur}${numVal}\n   ${JSON.stringify(e.value)}`;
      });
      return ok(`${data.length} health entries:\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ workout_date, workout_type, name, exercises, duration_s, volume_kg, rpe, notes, tags, event_time, ingestion_source, external_id }) => {
    try {
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

      if (error) return err(`Workout log failed: ${error.message}`);
      return ok(`Workout logged: ${name} (${workout_type}) on ${workout_date}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ workout_type, days, limit }) => {
    try {
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
      if (error) return err(`Error: ${error.message}`);
      if (!data?.length) return ok("No workouts found.");

      const results = data.map((w: any, i: number) => {
        const vol = w.volume_kg ? ` | Vol: ${w.volume_kg}kg` : "";
        const rpe = w.rpe ? ` | RPE: ${w.rpe}` : "";
        const exCount = Array.isArray(w.exercises) ? `${w.exercises.length} exercises` : "";
        return `${i + 1}. [${w.workout_date}] ${w.name} (${w.workout_type})${vol}${rpe}\n   ${exCount}${w.notes ? " -- " + w.notes : ""}`;
      });
      return ok(`${data.length} workout(s):\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ id, content, title, category, importance, tags, people }) => {
    try {
      const update: Record<string, unknown> = {};
      if (title !== undefined) update.title = title;
      if (category !== undefined) {
        if (!VALID_CATEGORIES.includes(category as any)) return err(`Invalid category: "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
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

      if (error) return err(`Update failed: ${error.message}`);
      if (!data) return err(`Memory ${id} not found.`);
      return ok(`Memory updated: "${data.title || data.id}" (${data.category})`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("memories")
        .delete()
        .eq("id", id)
        .select("id, title")
        .single();

      if (error) return err(`Delete failed: ${error.message}`);
      if (!data) return err(`Memory ${id} not found.`);
      return ok(`Deleted memory: "${data.title || data.id}"`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("health_entries")
        .delete()
        .eq("id", id)
        .select("id, entry_type, timestamp")
        .single();

      if (error) return err(`Delete failed: ${error.message}`);
      if (!data) return err(`Health entry ${id} not found.`);
      return ok(`Deleted health entry: ${data.entry_type} at ${new Date(data.timestamp).toLocaleString()}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ id, name, workout_type, exercises, duration_s, volume_kg, rpe, notes, tags }) => {
    try {
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

      if (error) return err(`Update failed: ${error.message}`);
      if (!data) return err(`Workout ${id} not found.`);
      return ok(`Workout updated: "${data.name}" (${data.workout_type}) on ${data.workout_date}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
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
  async ({ source, limit }) => {
    try {
      let q = supabase
        .from("sync_log")
        .select("id, source, sync_type, records_processed, records_imported, records_skipped, records_failed, started_at, completed_at, status, error_message")
        .order("started_at", { ascending: false })
        .limit(limit);

      if (source) q = q.eq("source", source);

      const { data, error } = await q;
      if (error) return err(`Error: ${error.message}`);
      if (!data?.length) return ok("No sync history found.");

      const results = data.map((s: any, i: number) => {
        const started = new Date(s.started_at).toLocaleString();
        const completed = s.completed_at ? new Date(s.completed_at).toLocaleString() : "—";
        const dur = s.completed_at
          ? `${Math.round((new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000)}s`
          : "—";
        const errLine = s.error_message ? `\n   Error: ${s.error_message}` : "";
        return `${i + 1}. [${started}] ${s.source} (${s.sync_type}) — ${s.status}${errLine}\n   Processed: ${s.records_processed} | Imported: ${s.records_imported} | Skipped: ${s.records_skipped} | Failed: ${s.records_failed}\n   Duration: ${dur} | Completed: ${completed}`;
      });

      return ok(`${data.length} sync(s):\n\n${results.join("\n\n")}`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  }
);

// ============================================================
// HONO APP -- Auth + CORS + MCP Transport
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  // Auth: accept key via header or query param
  const provided =
    c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");

  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  // Fix: some MCP clients don't send the Accept header StreamableHTTP expects
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
