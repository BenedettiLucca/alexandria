export const VALID_CATEGORIES = [
  "note",
  "idea",
  "decision",
  "observation",
  "reference",
  "task",
  "person",
  "recipe",
  "travel",
  "purchase",
  "quote",
] as const;

export function normalizeStringArray(
  values: unknown,
  opts: { lowercase?: boolean; maxItems?: number } = {},
): string[] {
  const { lowercase = false, maxItems = 25 } = opts;
  if (!Array.isArray(values)) return [];

  const normalized = values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => lowercase ? value.toLowerCase() : value);

  return [...new Set(normalized)].slice(0, maxItems);
}

export function normalizeBriefBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

export async function computeBriefContentHash(input: {
  source_job: string;
  title: string;
  brief_date: string;
  kind: string;
  body_markdown: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    source_job: input.source_job.trim(),
    title: input.title.trim(),
    brief_date: input.brief_date.trim(),
    kind: input.kind.trim().toLowerCase(),
    body_markdown: normalizeBriefBody(input.body_markdown),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sanitizeClassification(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  let category = String(raw.category || "note").toLowerCase().trim();
  if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
    category = "note";
  }

  let importance = Number(raw.importance);
  if (Number.isNaN(importance) || importance < 1 || importance > 10) {
    importance = 5;
  }

  const rawTags = Array.isArray(raw.tags)
    ? (raw.tags as string[]).map((t) => String(t).toLowerCase().trim()).filter(
      Boolean,
    )
    : [];
  const tags = [...new Set(rawTags)].slice(0, 5);

  const rawPeople = Array.isArray(raw.people)
    ? (raw.people as string[]).map((p) => String(p).trim()).filter(Boolean)
    : [];
  const people = [...new Set(rawPeople)].slice(0, 10);

  const title = typeof raw.title === "string" ? raw.title.slice(0, 60) : null;

  return {
    category,
    tags,
    people,
    importance,
    title,
    dates_mentioned: raw.dates_mentioned || [],
  };
}

export function simpleClassify(text: string): Record<string, unknown> {
  const lower = text.toLowerCase();
  const defaults = {
    category: "note",
    tags: [],
    importance: 5,
    title: null,
    people: [],
    dates_mentioned: [],
  };

  const rules: Array<[RegExp, string, string[], number?]> = [
    [/\b(workout|exercise|gym|lifted|ran|running|training)\b/, "observation", [
      "fitness",
      "exercise",
    ]],
    [/\b(bug|error|fix|debug|crash|broken|failing)\b/, "task", [
      "coding",
      "bug",
    ]],
    [/\b(idea|what if|maybe we could|wouldn't it|imagine if)\b/, "idea", [
      "idea",
    ]],
    [/\b(decided|going to|we'll use|let's go with|agreed on)\b/, "decision", [
      "decision",
    ]],
    [/\b(recipe|cook|bake|baking|ingredients)\b/, "recipe", ["cooking"]],
    [/\b(trip|travel|flight|hotel|vacation)\b/, "travel", ["travel"]],
    [/\b(bought|purchased|ordered)\b/, "purchase", ["purchase"]],
    [/\b(sarah said|met with|talked to|spoke with|chatted with)\b/, "note", [
      "people",
    ]],
  ];

  for (const [pattern, category, tags] of rules) {
    if (pattern.test(lower)) {
      return { ...defaults, category, tags };
    }
  }

  return defaults;
}

function formatNum(n: unknown): string {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

export function recordToText(
  type: string,
  record: Record<string, unknown>,
): string {
  const date = record.timestamp
    ? new Date(record.timestamp as string).toLocaleDateString()
    : "unknown date";
  const v = record.value as Record<string, unknown> | undefined;

  switch (type) {
    case "steps":
      return `On ${date}, walked ${formatNum(record.numeric_value)} steps${
        record.duration_s
          ? ` over ${Math.round((record.duration_s as number) / 60)} minutes`
          : ""
      }`;
    case "sleep": {
      const hrs = record.numeric_value || v?.duration_hours;
      const bed = v?.bed_time ? ` from ${v.bed_time}` : "";
      const wake = v?.wake_time ? ` to ${v.wake_time}` : "";
      return `On ${date}, slept ${hrs} hours${bed}${wake}`;
    }
    case "heart_rate":
      return `Heart rate of ${formatNum(record.numeric_value)} bpm at ${
        new Date(record.timestamp as string).toLocaleString()
      }`;
    case "weight":
      return `Weight: ${formatNum(record.numeric_value)} kg on ${date}`;
    case "blood_pressure": {
      const sys = v?.systolic;
      const dia = v?.diastolic;
      return `Blood pressure ${sys}/${dia} mmHg on ${date}`;
    }
    case "water":
      return `Drank ${formatNum(record.numeric_value)} ml of water on ${date}`;
    case "nutrition":
      return `Nutrition log on ${date}: ${JSON.stringify(v)}`;
    case "stress":
      return `Stress level ${formatNum(record.numeric_value)} on ${date}`;
    case "cycle":
      return `Cycle data on ${date}: ${JSON.stringify(v)}`;
    case "body_composition":
      return `Body composition on ${date}: ${JSON.stringify(v)}`;
    default: {
      const parts = [`${type} on ${date}`];
      if (record.numeric_value != null) {
        parts.push(`value: ${record.numeric_value}`);
      }
      if (record.duration_s) {
        parts.push(
          `duration: ${Math.round((record.duration_s as number) / 60)}min`,
        );
      }
      if (v) parts.push(`data: ${JSON.stringify(v)}`);
      return parts.join(", ");
    }
  }
}

export function workoutToText(record: Record<string, unknown>): string {
  const date = record.workout_date as string || "unknown date";
  const name = record.name as string || "Workout";
  const type = record.workout_type as string || "other";
  const exercises = record.exercises as
    | Array<Record<string, unknown>>
    | undefined;

  const parts = [`${type} workout '${name}' on ${date}`];
  if (exercises?.length) {
    const exStr = exercises.map((e) => {
      const sets = e.sets != null ? `${e.sets}x` : "";
      const reps = e.reps != null ? `${e.reps}` : "";
      const weight = e.weight_kg != null ? `@${e.weight_kg}kg` : "";
      return `${e.name} ${sets}${reps}${weight}`.trim();
    }).join(", ");
    parts.push(exStr);
  }
  if (record.volume_kg != null) {
    parts.push(`total volume ${record.volume_kg}kg`);
  }
  if (record.numeric_value != null) parts.push(`value ${record.numeric_value}`);
  if (record.rpe != null) parts.push(`RPE ${record.rpe}`);
  if (record.duration_s) {
    parts.push(`duration ${Math.round((record.duration_s as number) / 60)}min`);
  }

  return parts.join(": ") + (exercises?.length ? "" : "");
}

export function briefToText(record: Record<string, unknown>): string {
  const title = (record.title as string) || "Untitled brief";
  const briefDate = (record.brief_date as string) || "unknown date";
  const kind = (record.kind as string) || "brief";
  const sourceJob = (record.source_job as string) || "unknown-source";
  const body = normalizeBriefBody((record.body_markdown as string) || "");
  const topics = normalizeStringArray(record.topics, { lowercase: true });
  const projectRefs = normalizeStringArray(record.project_refs);
  const entityRefs = normalizeStringArray(record.entity_refs);

  const parts = [
    `Brief '${title}' (${kind}) from ${sourceJob} on ${briefDate}`,
  ];
  if (topics.length) parts.push(`topics: ${topics.join(", ")}`);
  if (projectRefs.length) parts.push(`projects: ${projectRefs.join(", ")}`);
  if (entityRefs.length) parts.push(`entities: ${entityRefs.join(", ")}`);
  if (body) parts.push(body);
  return parts.join("\n");
}

export function memoryToText(
  record: Record<string, unknown>,
  opts: { index?: number; includeSimilarity?: boolean } = {},
): string {
  const parts = [];
  const similarity = record.similarity as number | undefined;
  const i = opts.index;

  if (opts.includeSimilarity && similarity != null) {
    parts.push(
      `--- ${i != null ? i + 1 + ". " : ""}${(similarity * 100).toFixed(1)}% match ---`,
    );
  } else if (i != null) {
    parts.push(`${i + 1}. [${new Date(record.created_at as string).toLocaleDateString()}] ${record.category}`);
  }

  if (opts.includeSimilarity || i == null) {
    parts.push(`Title: ${record.title || "Untitled"}`);
    parts.push(`Category: ${record.category} | Importance: ${record.importance ?? 0}/10`);
    parts.push(`Date: ${new Date(record.created_at as string).toLocaleDateString()}`);
  }

  if (record.tags && Array.isArray(record.tags) && record.tags.length) {
    parts.push(`Tags: ${record.tags.join(", ")}`);
  }

  if (opts.includeSimilarity || i == null) {
    parts.push(`\n${record.content}`);
  } else {
    parts.push(`   ${record.title || (record.content as string).slice(0, 120)}`);
  }

  return parts.join("\n");
}

export function formatMemoryStats(data: {
  count: number;
  entries: Array<{
    category: string;
    tags?: string[];
    people?: string[];
    created_at: string;
  }>;
}): string {
  const { count, entries } = data;
  const cats: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const people: Record<string, number> = {};

  for (const r of entries) {
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
      entries.length
        ? new Date(entries[entries.length - 1].created_at).toLocaleDateString() +
          " -> " +
          new Date(entries[0].created_at).toLocaleDateString()
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
}

export function extractBodyCompMetrics(
  value: Record<string, unknown>,
): Record<string, number | null> {
  const keys = [
    "weight_kg",
    "body_fat_percent",
    "skeletal_muscle_kg",
    "body_water_kg",
    "waist_cm",
    "chest_cm",
    "arm_cm",
    "thigh_cm",
    "calf_cm",
  ];
  const metrics: Record<string, number | null> = {};
  for (const key of keys) {
    const val = value[key];
    metrics[key] = typeof val === "number" ? val : null;
  }
  return metrics;
}

export function computeBodyCompDelta(
  current: Record<string, number | null>,
  previous: Record<string, number | null>,
): Record<string, { delta: number; direction: "up" | "down" | "flat" } | null> {
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const deltas: Record<
    string,
    { delta: number; direction: "up" | "down" | "flat" } | null
  > = {};
  for (const key of keys) {
    const currVal = current[key];
    const prevVal = previous[key];

    if (currVal != null && prevVal != null) {
      const delta = currVal - prevVal;
      const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      deltas[key] = { delta: parseFloat(delta.toFixed(2)), direction };
    } else {
      deltas[key] = null;
    }
  }
  return deltas;
}

export function formatHealthEntry(
  e: Record<string, any>,
  index?: number,
): string {
  const ts = new Date(e.timestamp as string).toLocaleString();
  const dur = e.duration_s
    ? ` (${Math.round((e.duration_s as number) / 60)}min)`
    : "";
  const numVal = e.numeric_value != null ? ` [${e.numeric_value}]` : "";
  const prefix = index != null ? `${index + 1}. ` : "";
  return `${prefix}[${ts}] ${e.entry_type}${dur}${numVal}\n   ${
    JSON.stringify(e.value)
  }`;
}

export function formatDailyHealthSummary(s: Record<string, any>): string {
  const parts = [`== ${s.date} ==`];
  if (s.sleep_total_hours != null) {
    parts.push(
      `Sleep: ${s.sleep_total_hours}h (${s.sleep_sessions || 0} sessions)`,
    );
  }
  if (s.steps_total != null) {
    parts.push(
      `Steps: ${s.steps_total}${
        s.steps_active_minutes ? ` (${s.steps_active_minutes}min active)` : ""
      }`,
    );
  }
  if (s.hr_avg != null) {
    parts.push(
      `HR: avg ${s.hr_avg} / min ${s.hr_min} / max ${s.hr_max} bpm (${s.hr_samples} samples)`,
    );
  }
  if (s.weight_kg != null) parts.push(`Weight: ${s.weight_kg}kg`);
  if (s.exercise_count > 0) {
    parts.push(
      `Exercise: ${s.exercise_count} sessions, ${s.exercise_total_minutes}min${
        s.exercise_types?.length ? ` [${s.exercise_types.join(", ")}]` : ""
      }`,
    );
  }
  if (s.workout_count > 0) {
    parts.push(
      `Training: ${s.workout_count} workouts${
        s.training_volume_kg ? `, ${s.training_volume_kg}kg vol` : ""
      }${s.training_types?.length ? ` [${s.training_types.join(", ")}]` : ""}`,
    );
  }
  if (s.sources?.length) parts.push(`Sources: ${s.sources.join(", ")}`);
  if (s.computed_at) {
    parts.push(`Computed: ${new Date(s.computed_at).toLocaleString()}`);
  }
  return parts.join("\n");
}

export function formatBodyCompSummary(
  entries: Array<{
    timestamp: string;
    metrics: Record<string, number | null>;
    delta?: Record<string, any>;
    context?: string;
    precision?: string;
  }>,
  goals: Array<{
    metric_name: string;
    target_value: number;
    current_value: number | null;
    target_date: string | null;
    status: string | null;
  }>,
  dateRange: { from: string; to: string },
): string {
  if (entries.length === 0) {
    return "No body composition entries found in the selected period.";
  }

  const latest = entries[0];
  const parts = [
    "Body Composition Check-in Summary",
    `Period: ${dateRange.from} to ${dateRange.to}`,
    "",
    `Latest Snapshot: ${new Date(latest.timestamp).toLocaleDateString()}`,
  ];

  if (
    (latest.context && latest.context !== "morning_fast") ||
    (latest.precision && latest.precision !== "day")
  ) {
    parts.push(
      `⚠ Non-standard conditions: ${latest.context || "unknown context"}, ${
        latest.precision || "unknown precision"
      }`,
    );
  }

  const metricLabels: Record<string, string> = {
    weight_kg: "Weight",
    body_fat_percent: "Body Fat",
    skeletal_muscle_kg: "Muscle Mass",
    body_water_kg: "Water",
    waist_cm: "Waist",
    chest_cm: "Chest",
    arm_cm: "Arm",
    thigh_cm: "Thigh",
    calf_cm: "Calf",
  };

  const metricUnits: Record<string, string> = {
    weight_kg: "kg",
    body_fat_percent: "%",
    skeletal_muscle_kg: "kg",
    body_water_kg: "kg",
    waist_cm: "cm",
    chest_cm: "cm",
    arm_cm: "cm",
    thigh_cm: "cm",
    calf_cm: "cm",
  };

  for (const [key, val] of Object.entries(latest.metrics)) {
    if (val != null) {
      let line = `- ${metricLabels[key] || key}: ${val}${metricUnits[key] || ""}`;
      const d = latest.delta?.[key];
      if (d) {
        const arrow = d.direction === "up" ? "↑" : d.direction === "down" ? "↓" : "→";
        line += ` (${arrow} ${Math.abs(d.delta)}${metricUnits[key] || ""})`;
      }
      parts.push(line);
    }
  }

  if (goals.length > 0) {
    parts.push("", "Goal Progress:");
    for (const g of goals) {
      const current = g.current_value != null ? `${g.current_value}` : "N/A";
      const target = g.target_value;
      const status = g.status ? ` [${g.status}]` : "";
      const date = g.target_date ? ` by ${g.target_date}` : "";
      parts.push(`- ${g.metric_name}: ${current} → ${target}${date}${status}`);
    }
  }

  return parts.join("\n");
}
