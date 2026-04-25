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

export const VALID_SOURCES = [
  "manual",
  "mcp",
  "import",
  "capture",
  "health-connect",
  "iron-log",
  "auto",
] as const;

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

export function extractNumericValue(
  entryType: string,
  value: Record<string, unknown>,
): number | null {
  if (!value) return null;

  switch (entryType) {
    case "steps":
      return typeof value.count === "number" ? value.count : null;
    case "heart_rate":
      return typeof value.bpm === "number" ? value.bpm : null;
    case "weight":
      return typeof value.weight_kg === "number" ? value.weight_kg : null;
    case "sleep":
      return typeof value.duration_hours === "number"
        ? value.duration_hours
        : null;
    case "exercise":
      if (typeof value.duration_min === "number") return value.duration_min;
      if (typeof value.calories === "number") return value.calories;
      return null;
    case "blood_pressure":
      return typeof value.systolic === "number" ? value.systolic : null;
    case "body_composition":
      return typeof value.weight_kg === "number" ? value.weight_kg : null;
    default:
      return null;
  }
}
