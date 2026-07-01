// deno-lint-ignore no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  briefToText,
  computeBodyCompDelta,
  computeBriefContentHash,
  extractBodyCompMetrics,
  formatBodyCompSummary,
  normalizeBriefBody,
  normalizeStringArray,
  recordToText,
  sanitizeClassification,
  simpleClassify,
  VALID_CATEGORIES,
  workoutToText,
} from "./lib.ts";

// --- extractBodyCompMetrics ---

Deno.test("extractBodyCompMetrics extracts all fields when present", () => {
  const value = {
    weight_kg: 80,
    body_fat_percent: 15.5,
    skeletal_muscle_kg: 35.2,
    body_water_kg: 45,
    waist_cm: 85,
    chest_cm: 100,
    arm_cm: 32,
    thigh_cm: 55,
    calf_cm: 38,
  };
  const result = extractBodyCompMetrics(value);
  assertEquals(result, value);
});

Deno.test("extractBodyCompMetrics returns null for missing fields", () => {
  const value = {
    weight_kg: 80,
    body_fat_percent: 15.5,
  };
  const result = extractBodyCompMetrics(value);
  assertEquals(result.weight_kg, 80);
  assertEquals(result.body_fat_percent, 15.5);
  assertEquals(result.skeletal_muscle_kg, null);
  assertEquals(result.waist_cm, null);
});

// --- computeBodyCompDelta ---

Deno.test("computeBodyCompDelta computes positive/negative/zero deltas correctly", () => {
  const current = { weight_kg: 80.5, body_fat_percent: 15.0, waist_cm: 85 };
  const previous = { weight_kg: 80.0, body_fat_percent: 15.5, waist_cm: 85 };
  const result = computeBodyCompDelta(current, previous);

  assertEquals(result.weight_kg, { delta: 0.5, direction: "up" });
  assertEquals(result.body_fat_percent, { delta: -0.5, direction: "down" });
  assertEquals(result.waist_cm, { delta: 0, direction: "flat" });
});

Deno.test("computeBodyCompDelta returns null when either value is missing", () => {
  const current = { weight_kg: 80.5, body_fat_percent: 15.0 };
  const previous = { weight_kg: 80.0, skeletal_muscle_kg: 35 };
  const result = computeBodyCompDelta(current, previous);

  assertEquals(result.weight_kg, { delta: 0.5, direction: "up" });
  assertEquals(result.body_fat_percent, null);
  assertEquals(result.skeletal_muscle_kg, null);
});

// --- formatBodyCompSummary ---

Deno.test("formatBodyCompSummary includes latest metrics, delta arrows, goals, and quality flags", () => {
  const entries = [{
    timestamp: "2025-06-01T08:00:00Z",
    metrics: { weight_kg: 80.5, body_fat_percent: 15.0 },
    delta: {
      weight_kg: { delta: 0.5, direction: "up" },
      body_fat_percent: { delta: -0.2, direction: "down" },
    },
    context: "evening",
    precision: "day",
  }];
  const goals = [{
    metric_name: "weight_kg",
    target_value: 78,
    current_value: 80.5,
    target_date: "2025-07-01",
    status: "in_progress",
  }];
  const dateRange = { from: "2025-05-01", to: "2025-06-01" };

  const result = formatBodyCompSummary(entries, goals, dateRange);

  assertExists(result);
  assertEquals(result.includes("Body Composition Check-in Summary"), true);
  assertEquals(result.includes("Weight: 80.5kg (↑ 0.5kg)"), true);
  assertEquals(result.includes("Body Fat: 15% (↓ 0.2%)"), true);
  assertEquals(result.includes("⚠ Non-standard conditions: evening"), true);
  assertEquals(result.includes("weight_kg: 80.5 → 78 by 2025-07-01 [in_progress]"), true);
});

// --- simpleClassify ---

Deno.test("simpleClassify detects fitness/observation", () => {
  const result = simpleClassify("Went to the gym and did bench press");
  assertEquals(result.category, "observation");
  assertExists(result.tags);
  assertEquals((result.tags as string[]).includes("fitness"), true);
});

Deno.test("simpleClassify detects task/coding", () => {
  const result = simpleClassify("Found a bug in the API, getting 500 errors");
  assertEquals(result.category, "task");
  assertExists(result.tags);
  assertEquals((result.tags as string[]).includes("coding"), true);
});

Deno.test("simpleClassify detects idea", () => {
  const result = simpleClassify("What if we used a queue instead?");
  assertEquals(result.category, "idea");
});

Deno.test("simpleClassify detects decision", () => {
  const result = simpleClassify("Decided to go with PostgreSQL");
  assertEquals(result.category, "decision");
});

Deno.test("simpleClassify detects recipe/cooking", () => {
  const result = simpleClassify("Made a pasta recipe with basil and tomatoes");
  assertEquals(result.category, "recipe");
  assertExists(result.tags);
  assertEquals((result.tags as string[]).includes("cooking"), true);
});

Deno.test("simpleClassify detects travel", () => {
  const result = simpleClassify("Booked flights to Tokyo for the trip");
  assertEquals(result.category, "travel");
});

Deno.test("simpleClassify detects purchase", () => {
  const result = simpleClassify("Bought a new mechanical keyboard");
  assertEquals(result.category, "purchase");
});

Deno.test("simpleClassify detects people note", () => {
  const result = simpleClassify("Met with Sarah about the project");
  assertEquals(result.category, "note");
  assertExists(result.tags);
  assertEquals((result.tags as string[]).includes("people"), true);
});

Deno.test("simpleClassify defaults to note", () => {
  const result = simpleClassify("Just a regular note");
  assertEquals(result.category, "note");
});

Deno.test("simpleClassify handles empty string", () => {
  const result = simpleClassify("");
  assertEquals(result.category, "note");
});

Deno.test("simpleClassify handles long text with no keywords", () => {
  const longText =
    "The quick brown fox jumps over the lazy dog and then goes to the market to buy some apples and oranges and bananas and grapes and watermelon and cantaloupe and honeydew and strawberries and blueberries and raspberries";
  const result = simpleClassify(longText);
  assertEquals(result.category, "note");
});

// --- sanitizeClassification ---

Deno.test("sanitizeClassification passes valid classification", () => {
  const raw = {
    category: "idea",
    importance: 7,
    tags: ["brainstorm"],
    people: ["Alice"],
  };
  const result = sanitizeClassification(raw);
  assertEquals(result.category, "idea");
  assertEquals(result.importance, 7);
  assertEquals(result.tags, ["brainstorm"]);
  assertEquals(result.people, ["Alice"]);
});

Deno.test("sanitizeClassification falls back to note for invalid category", () => {
  const result = sanitizeClassification({ category: "foobar" });
  assertEquals(result.category, "note");
});

Deno.test("sanitizeClassification clamps importance below 1", () => {
  assertEquals(sanitizeClassification({ importance: 0 }).importance, 5);
  assertEquals(sanitizeClassification({ importance: -5 }).importance, 5);
});

Deno.test("sanitizeClassification clamps importance above 10", () => {
  assertEquals(sanitizeClassification({ importance: 11 }).importance, 5);
  assertEquals(sanitizeClassification({ importance: 15 }).importance, 5);
});

Deno.test("sanitizeClassification keeps importance in range", () => {
  assertEquals(sanitizeClassification({ importance: 1 }).importance, 1);
  assertEquals(sanitizeClassification({ importance: 10 }).importance, 10);
});

Deno.test("sanitizeClassification limits tags to 5 and lowercases", () => {
  const raw = {
    tags: ["Fitness", "CODING", "Health", "Wellness", "Productivity", "Extra"],
  };
  const result = sanitizeClassification(raw);
  assertEquals((result.tags as string[]).length, 5);
  assertEquals(result.tags, [
    "fitness",
    "coding",
    "health",
    "wellness",
    "productivity",
  ]);
});

Deno.test("sanitizeClassification deduplicates tags", () => {
  const raw = { tags: ["fitness", "Fitness", "FITNESS", "coding"] };
  const result = sanitizeClassification(raw);
  assertEquals(result.tags, ["fitness", "coding"]);
});

Deno.test("sanitizeClassification limits people to 10", () => {
  const raw = {
    people: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
  };
  const result = sanitizeClassification(raw);
  assertEquals((result.people as string[]).length, 10);
});

Deno.test("sanitizeClassification truncates title to 60 chars", () => {
  const longTitle = "A".repeat(100);
  const result = sanitizeClassification({ title: longTitle });
  assertEquals((result.title as string).length, 60);
});

Deno.test("sanitizeClassification defaults missing fields", () => {
  const result = sanitizeClassification({ category: "task" });
  assertEquals(result.category, "task");
  assertEquals(result.importance, 5);
  assertEquals(result.tags, []);
  assertEquals(result.people, []);
  assertEquals(result.title, null);
  assertEquals(result.dates_mentioned, []);
});

Deno.test("sanitizeClassification handles empty object", () => {
  const result = sanitizeClassification({});
  assertEquals(result.category, "note");
  assertEquals(result.importance, 5);
  assertEquals(result.tags, []);
  assertEquals(result.people, []);
  assertEquals(result.title, null);
});

Deno.test("sanitizeClassification filters falsy and whitespace tags", () => {
  const raw = { tags: ["", "  ", "valid"] };
  const result = sanitizeClassification(raw);
  assertEquals(result.tags, ["valid"]);
});

// --- recordToText ---

Deno.test("recordToText handles steps", () => {
  const result = recordToText("steps", {
    timestamp: "2025-01-15T12:00:00Z",
    numeric_value: 8500,
    duration_s: 3600,
  });
  assertExists(result);
  assertEquals(result.includes("8,500"), true);
  assertEquals(result.includes("steps"), true);
  assertEquals(result.includes("60 minutes"), true);
});

Deno.test("recordToText handles sleep", () => {
  const result = recordToText("sleep", {
    timestamp: "2025-01-15T07:00:00Z",
    numeric_value: 7.5,
    value: { duration_hours: 7.5, bed_time: "23:00", wake_time: "06:30" },
  });
  assertExists(result);
  assertEquals(result.includes("7.5"), true);
  assertEquals(result.includes("hours"), true);
});

Deno.test("recordToText handles heart_rate", () => {
  const result = recordToText("heart_rate", {
    timestamp: "2025-01-15T08:00:00Z",
    numeric_value: 72,
  });
  assertExists(result);
  assertEquals(result.includes("72"), true);
  assertEquals(result.includes("bpm"), true);
});

Deno.test("recordToText handles weight", () => {
  const result = recordToText("weight", {
    timestamp: "2025-01-15T08:00:00Z",
    numeric_value: 75.5,
  });
  assertExists(result);
  assertEquals(result.includes("75.5"), true);
  assertEquals(result.includes("kg"), true);
});

Deno.test("recordToText handles exercise", () => {
  const result = recordToText("exercise", {
    timestamp: "2025-01-15T10:00:00Z",
    numeric_value: 45,
    duration_s: 2700,
  });
  assertExists(result);
  assertEquals(result.includes("45"), true);
  assertEquals(result.includes("45min"), true);
});

Deno.test("recordToText handles missing fields gracefully", () => {
  const result = recordToText("steps", {});
  assertExists(result);
  assertEquals(result.includes("unknown date"), true);
});

Deno.test("recordToText uses timestamp as fallback", () => {
  const result = recordToText("weight", {
    timestamp: "2025-06-01T10:00:00Z",
    numeric_value: 80,
  });
  assertEquals(result.includes("kg"), true);
});

// --- workoutToText ---

Deno.test("workoutToText produces text with name, date, exercises", () => {
  const result = workoutToText({
    workout_date: "2025-01-15",
    name: "Push Day",
    workout_type: "strength",
    exercises: [
      { name: "Bench Press", sets: 4, reps: 8, weight_kg: 80 },
      { name: "OHP", sets: 3, reps: 10, weight_kg: 50 },
    ],
  });
  assertExists(result);
  assertEquals(result.includes("Push Day"), true);
  assertEquals(result.includes("Bench Press"), true);
  assertEquals(result.includes("OHP"), true);
});

Deno.test("workoutToText includes volume and RPE", () => {
  const result = workoutToText({
    workout_date: "2025-01-15",
    name: "Leg Day",
    workout_type: "strength",
    exercises: [{ name: "Squat", sets: 5, reps: 5, weight_kg: 100 }],
    volume_kg: 5000,
    rpe: 8,
  });
  assertEquals(result.includes("5000"), true);
  assertEquals(result.includes("RPE 8"), true);
});

Deno.test("workoutToText handles workouts with no exercises", () => {
  const result = workoutToText({
    workout_date: "2025-01-15",
    name: "Rest Day",
    workout_type: "other",
  });
  assertExists(result);
  assertEquals(result.includes("Rest Day"), true);
});

Deno.test("workoutToText uses workout_date for date", () => {
  const result = workoutToText({
    workout_date: "2025-03-20",
    name: "Morning Run",
    workout_type: "cardio",
    duration_s: 1800,
  });
  assertEquals(
    result.includes("1800") === false || result.includes("30min"),
    true,
  );
});

// --- Constants ---

Deno.test("VALID_CATEGORIES contains expected categories", () => {
  const expected = [
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
  ];
  assertEquals([...VALID_CATEGORIES], expected);
  assertEquals(VALID_CATEGORIES.length, 11);
});

Deno.test("workoutToText includes numeric_value when present", () => {
  const result = workoutToText({
    workout_date: "2025-06-01",
    name: "Tempo Run",
    workout_type: "cardio",
    numeric_value: 5.2,
    exercises: [{ name: "Running", distance_km: 5.2 }],
  });
  assertExists(result);
  assertEquals(result.includes("5.2"), true);
});

Deno.test("recordToText uses timestamp fallback correctly", () => {
  const result = recordToText("steps", {
    timestamp: "2025-07-04T12:00:00Z",
    numeric_value: 10000,
  });
  assertExists(result);
  assertEquals(result.includes("10,000"), true);
  assertEquals(result.includes("steps"), true);
});

// --- brief helpers ---

Deno.test("normalizeStringArray trims, dedupes, and lowercases when requested", () => {
  assertEquals(
    normalizeStringArray([" ETF Flows ", "etf flows", "Hyperliquid", ""], {
      lowercase: true,
    }),
    ["etf flows", "hyperliquid"],
  );
});

Deno.test("normalizeBriefBody normalizes line endings and trims edges", () => {
  assertEquals(
    normalizeBriefBody("\nLine 1\r\nLine 2\r\n\n"),
    "Line 1\nLine 2",
  );
});

Deno.test("computeBriefContentHash is stable across line-ending differences", async () => {
  const a = await computeBriefContentHash({
    source_job: "research-pack",
    title: "Morning Brief",
    brief_date: "2026-06-06",
    kind: "night_research",
    body_markdown: "## Summary\nLine 1\nLine 2\n",
  });
  const b = await computeBriefContentHash({
    source_job: "research-pack",
    title: "Morning Brief",
    brief_date: "2026-06-06",
    kind: "night_research",
    body_markdown: "\r\n## Summary\r\nLine 1\r\nLine 2\r\n",
  });

  assertEquals(a, b);
});

Deno.test("computeBriefContentHash changes when brief identity changes", async () => {
  const a = await computeBriefContentHash({
    source_job: "research-pack",
    title: "Morning Brief",
    brief_date: "2026-06-06",
    kind: "night_research",
    body_markdown: "same body",
  });
  const b = await computeBriefContentHash({
    source_job: "research-pack",
    title: "Morning Brief",
    brief_date: "2026-06-07",
    kind: "night_research",
    body_markdown: "same body",
  });

  assertEquals(a === b, false);
});

Deno.test("briefToText includes metadata and markdown body for semantic indexing", () => {
  const result = briefToText({
    title: "ETF + Hyperliquid",
    brief_date: "2026-06-06",
    kind: "content_coach",
    source_job: "content-coach",
    topics: ["ETF flows", "Hyperliquid"],
    project_refs: ["wyde"],
    entity_refs: ["Intmax"],
    body_markdown: "## Talking Points\n- ETF flows still dominate",
  });

  assertEquals(result.includes("ETF + Hyperliquid"), true);
  assertEquals(result.includes("content-coach"), true);
  assertEquals(result.includes("topics: etf flows, hyperliquid"), true);
  assertEquals(result.includes("projects: wyde"), true);
  assertEquals(result.includes("entities: Intmax"), true);
  assertEquals(result.includes("## Talking Points"), true);
});
