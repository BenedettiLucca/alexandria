import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE,
  EMBEDDING_MODEL,
  CLASSIFICATION_MODEL,
  supabase,
} from "./config.ts";
import {
  VALID_CATEGORIES,
  sanitizeClassification,
} from "./lib.ts";

export async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    await r.text().catch(() => "");
    throw new Error("Embedding generation failed");
  }
  const d = await r.json();
  return d.data[0].embedding;
}

export async function classifyMemory(text: string): Promise<Record<string, unknown>> {
  const defaults = {
    category: "note",
    tags: ["uncategorized"],
    importance: 5,
    title: "Untitled",
    people: [],
    dates_mentioned: [],
  };
  try {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFICATION_MODEL,
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

export function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function wrapHandler(fn: (input: any) => Promise<string>) {
  return async (input: any) => {
    try {
      return ok(await fn(input));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const sanitized = msg
        .replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
        .replace(/https:\/\/[a-z0-9-]+\.supabase\.co[^\s]*/g, "[REDACTED_URL]")
        .replace(/sk-[A-Za-z0-9-]+/g, "[REDACTED_KEY]")
        .replace(/status: \d{3}\s/i, "")
        .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[REDACTED_IP]");
      return err(`Error: ${sanitized}`);
    }
  };
}

export async function queryTable<T = Record<string, unknown>>(
  table: string,
  select: string,
  opts: {
    filters?: Record<string, unknown>;
    days?: number;
    daysColumn?: string;
    limit?: number;
    order?: string;
    ascending?: boolean;
    orderOpts?: { ascending: boolean; nullsFirst: boolean };
  } = {},
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
  "person",
  "project",
  "concept",
  "location",
  "technology",
  "organization",
  "event",
  "other",
] as const;

export async function processEntities(
  _content: string,
  memoryId: string,
  rawEntities: unknown[],
) {
  const validEntities = rawEntities
    .filter((e: unknown) => {
      const obj = e as Record<string, unknown>;
      return obj?.name && obj?.type;
    })
    .map((e: unknown) => {
      const obj = e as Record<string, unknown>;
      return {
        name: String(obj.name).trim().slice(0, 200),
        type: VALID_ENTITY_TYPES.includes(obj.type as any)
          ? obj.type as any
          : "other",
        context: obj.context ? String(obj.context).slice(0, 500) : null,
      };
    });

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
          { onConflict: "memory_id,entity_id" },
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
        .insert({
          memory_id: memoryId,
          entity_id: created.id,
          context: ent.context,
        });
    }
  }
}
