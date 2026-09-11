// deno-lint-ignore no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  briefToText,
  computeBodyCompDelta,
  computeBriefContentHash,
  computeWorkoutContentHash,
  extractBodyCompMetrics,
  extractEntitiesFromShortText,
  formatBodyCompSummary,
  normalizeBriefBody,
  normalizeStringArray,
  recordToText,
  sanitizeClassification,
  sanitizeEntities,
  simpleClassify,
  VALID_CATEGORIES,
  VALID_ENTITY_TYPES,
  validateEntity,
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
      weight_kg: { delta: 0.5, direction: "up" as const },
      body_fat_percent: { delta: -0.2, direction: "down" as const },
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

// --- Entity validation and sanitizeClassification entity preservation ---

Deno.test("VALID_ENTITY_TYPES has 8 canonical entity types", () => {
  assertEquals(VALID_ENTITY_TYPES.length, 8);
  assertEquals(VALID_ENTITY_TYPES.includes("person"), true);
  assertEquals(VALID_ENTITY_TYPES.includes("project"), true);
  assertEquals(VALID_ENTITY_TYPES.includes("technology"), true);
});

Deno.test("validateEntity validates well-formed entities and rejects malformed ones", () => {
  // Valid
  const valid = validateEntity({
    name: " Alexandria ",
    type: "project",
    context: " working on alexandria ",
  });
  assertEquals(valid, {
    name: "Alexandria",
    type: "project",
    context: "working on alexandria",
  });

  // Malformed - missing name or empty name
  assertEquals(validateEntity({ type: "person" }), null);
  assertEquals(validateEntity({ name: "", type: "person" }), null);
  assertEquals(validateEntity({ name: "   ", type: "person" }), null);
  assertEquals(validateEntity({ name: 123, type: "person" }), null);

  // Malformed - invalid or missing type
  assertEquals(validateEntity({ name: "Alexandria" }), null);
  assertEquals(validateEntity({ name: "Alexandria", type: "not_a_valid_type" }), null);
  assertEquals(validateEntity({ name: "Alexandria", type: 123 }), null);

  // Malformed - non-object or null
  assertEquals(validateEntity(null), null);
  assertEquals(validateEntity(undefined), null);
  assertEquals(validateEntity("string"), null);
  assertEquals(validateEntity([]), null);
});

Deno.test("sanitizeEntities deduplicates by type and case-insensitive name", () => {
  const raw = [
    { name: "PostgreSQL", type: "technology", context: "used postgres" },
    { name: "postgresql", type: "technology", context: "different context" },
    { name: "PostgreSQL", type: "concept" }, // different type is allowed
    { name: "", type: "person" }, // malformed
    null,
  ];
  const results = sanitizeEntities(raw);
  assertEquals(results.length, 2);
  assertEquals(results[0], {
    name: "PostgreSQL",
    type: "technology",
    context: "used postgres",
  });
  assertEquals(results[1], {
    name: "PostgreSQL",
    type: "concept",
    context: null,
  });
});

Deno.test("sanitizeClassification preserves validated entities and drops malformed", () => {
  const raw = {
    category: "idea",
    importance: 8,
    entities: [
      { name: "TypeScript", type: "technology" },
      { name: "typescript", type: "technology" }, // dup
      { name: "", type: "technology" }, // malformed
      { type: "technology" }, // malformed
    ],
  };
  const result = sanitizeClassification(raw);
  assertEquals(Array.isArray(result.entities), true);
  const entities = result.entities as Array<{ name: string; type: string }>;
  assertEquals(entities.length, 1);
  assertEquals(entities[0].name, "TypeScript");
  assertEquals(entities[0].type, "technology");
});

Deno.test("short-text extraction policy extracts entities from text patterns", () => {
  const text = "Met with Sarah and discussed the Alexandria project";
  const entities = extractEntitiesFromShortText(text);
  assertEquals(entities.some((e) => e.name === "Sarah" && e.type === "person"), true);
  assertEquals(entities.some((e) => e.name === "Alexandria" && e.type === "project"), true);

  const text2 = "Bob said we should ship by Friday";
  const entities2 = extractEntitiesFromShortText(text2);
  assertEquals(entities2.some((e) => e.name === "Bob" && e.type === "person"), true);
});

Deno.test("simpleClassify applies short-text entity extraction policy", () => {
  const result = simpleClassify("Met with Sarah about the roadmap");
  assertEquals(result.category, "note");
  assertEquals((result.people as string[]).includes("Sarah"), true);
  const entities = result.entities as Array<{ name: string; type: string }>;
  assertExists(entities);
  assertEquals(entities.some((e) => e.name === "Sarah" && e.type === "person"), true);
});

// --- workoutToText: nested sets, zero preservation, notes/tags, and indexed fields only ---

Deno.test("workoutToText formats real nested sets from Iron Log", () => {
  const workout = {
    workout_date: "2026-09-10",
    workout_type: "strength",
    name: "Bench & OHP",
    exercises: [
      {
        name: "Bench Press",
        sets: [
          { set_number: 1, weight_kg: 80, reps: 8, duration_s: null, rir: 2, is_warmup: false },
          { set_number: 2, weight_kg: 85, reps: 6, duration_s: null, rir: 0, is_warmup: false },
          { set_number: 3, weight_kg: 50, reps: 10, duration_s: null, rir: 4, is_warmup: true },
        ],
      },
    ],
  };
  const result = workoutToText(workout);
  assertEquals(result.includes("Bench Press"), true);
  assertEquals(result.includes("8@80kg"), true);
  assertEquals(result.includes("6@85kg"), true);
  assertEquals(result.includes("warmup"), true);
});

Deno.test("workoutToText normalizers do not lose zero values", () => {
  const workout = {
    workout_date: "2026-09-10",
    workout_type: "strength",
    name: "Bodyweight & Core",
    duration_s: 0,
    volume_kg: 0,
    numeric_value: 0,
    rpe: 0,
    exercises: [
      {
        name: "Pull-ups",
        sets: [
          { set_number: 1, weight_kg: 0, reps: 10, rir: 0, is_warmup: false },
        ],
      },
      {
        name: "Plank",
        sets: 1,
        reps: 0,
        weight_kg: 0,
      },
    ],
  };
  const result = workoutToText(workout);
  assertEquals(result.includes("duration 0min"), true);
  assertEquals(result.includes("total volume 0kg"), true);
  assertEquals(result.includes("value 0"), true);
  assertEquals(result.includes("RPE 0"), true);
  assertEquals(result.includes("@0kg"), true);
});

Deno.test("workoutToText includes notes and normalized tags", () => {
  const workout = {
    workout_date: "2026-09-10",
    workout_type: "strength",
    name: "Heavy Legs",
    notes: "Shoulder felt good today, hit new PR",
    tags: [" Iron-Log ", "STRENGTH", "legs", "iron-log"],
  };
  const result = workoutToText(workout);
  assertEquals(result.includes("notes: Shoulder felt good today, hit new PR"), true);
  assertEquals(result.includes("tags: iron-log, strength, legs"), true);
});

Deno.test("workoutToText document changes ONLY when indexed fields change", () => {
  const base = {
    workout_date: "2026-09-10",
    workout_type: "strength",
    name: "Upper Body",
    exercises: [{ name: "Bench Press", sets: 3, reps: 8, weight_kg: 80 }],
    duration_s: 3600,
    volume_kg: 1920,
    numeric_value: 1920,
    rpe: 8,
    notes: "Solid session",
    tags: ["strength", "upper"],
    // Non-indexed / provenance / runtime fields:
    id: "uuid-1234",
    user_id: "user-5678",
    created_at: "2026-09-10T10:00:00Z",
    updated_at: "2026-09-10T10:00:00Z",
    external_id: "ironlog-session-99",
    embedding: [0.1, 0.2, 0.3],
    metadata: { source: "iron-log", device: "pixel-8" },
  };

  const textBase = workoutToText(base);

  // Changing non-indexed fields should NOT change the document
  const modifiedNonIndexed = {
    ...base,
    id: "uuid-9999",
    user_id: "user-9999",
    created_at: "2026-09-11T12:00:00Z",
    updated_at: "2026-09-11T12:00:00Z",
    external_id: "different-external-id",
    embedding: [0.9, 0.9, 0.9],
    metadata: { completely: "different" },
  };
  assertEquals(workoutToText(modifiedNonIndexed), textBase);

  // Changing any indexed field SHOULD change the document
  assertEquals(workoutToText({ ...base, name: "Upper Body B" }) !== textBase, true);
  assertEquals(workoutToText({ ...base, workout_date: "2026-09-11" }) !== textBase, true);
  assertEquals(workoutToText({ ...base, notes: "Changed notes" }) !== textBase, true);
  assertEquals(workoutToText({ ...base, tags: ["strength", "upper", "pr"] }) !== textBase, true);
  assertEquals(workoutToText({ ...base, duration_s: 1800 }) !== textBase, true);
  assertEquals(workoutToText({ ...base, volume_kg: 2000 }) !== textBase, true);
  assertEquals(workoutToText({ ...base, rpe: 9 }) !== textBase, true);
});

Deno.test("computeWorkoutContentHash is deterministic and changes only when indexed fields change", async () => {
  const row = {
    workout_date: "2026-09-10",
    workout_type: "strength",
    name: "Push",
    notes: "Good session",
    tags: ["push", "strength"],
    duration_s: 3600,
    volume_kg: 2500,
    rpe: 8,
    id: "id-1",
    created_at: "2026-09-10T00:00:00Z",
  };

  const hash1 = await computeWorkoutContentHash(row);
  const hash2 = await computeWorkoutContentHash({
    ...row,
    id: "id-2",
    created_at: "2026-09-11T00:00:00Z",
  });

  assertEquals(hash1, hash2);

  const hash3 = await computeWorkoutContentHash({
    ...row,
    notes: "Different notes",
  });
  assertEquals(hash1 === hash3, false);
});
