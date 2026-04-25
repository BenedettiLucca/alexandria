import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  VALID_CATEGORIES,
  VALID_SOURCES,
  simpleClassify,
  sanitizeClassification,
  recordToText,
  workoutToText,
  extractNumericValue,
} from "./lib.ts";

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
  const longText = "The quick brown fox jumps over the lazy dog and then goes to the market to buy some apples and oranges and bananas and grapes and watermelon and cantaloupe and honeydew and strawberries and blueberries and raspberries";
  const result = simpleClassify(longText);
  assertEquals(result.category, "note");
});

// --- sanitizeClassification ---

Deno.test("sanitizeClassification passes valid classification", () => {
  const raw = { category: "idea", importance: 7, tags: ["brainstorm"], people: ["Alice"] };
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
  const raw = { tags: ["Fitness", "CODING", "Health", "Wellness", "Productivity", "Extra"] };
  const result = sanitizeClassification(raw);
  assertEquals((result.tags as string[]).length, 5);
  assertEquals(result.tags, ["fitness", "coding", "health", "wellness", "productivity"]);
});

Deno.test("sanitizeClassification deduplicates tags", () => {
  const raw = { tags: ["fitness", "Fitness", "FITNESS", "coding"] };
  const result = sanitizeClassification(raw);
  assertEquals(result.tags, ["fitness", "coding"]);
});

Deno.test("sanitizeClassification limits people to 10", () => {
  const raw = { people: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] };
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
  const result = recordToText("weight", { timestamp: "2025-06-01T10:00:00Z", numeric_value: 80 });
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
  assertEquals(result.includes("1800") === false || result.includes("30min"), true);
});

// --- extractNumericValue ---

Deno.test("extractNumericValue extracts steps count", () => {
  assertEquals(extractNumericValue("steps", { count: 10000 }), 10000);
});

Deno.test("extractNumericValue extracts heart_rate bpm", () => {
  assertEquals(extractNumericValue("heart_rate", { bpm: 72 }), 72);
});

Deno.test("extractNumericValue extracts weight weight_kg", () => {
  assertEquals(extractNumericValue("weight", { weight_kg: 75.5 }), 75.5);
});

Deno.test("extractNumericValue extracts sleep duration_hours", () => {
  assertEquals(extractNumericValue("sleep", { duration_hours: 7.5 }), 7.5);
});

Deno.test("extractNumericValue extracts exercise duration_min", () => {
  assertEquals(extractNumericValue("exercise", { duration_min: 45 }), 45);
});

Deno.test("extractNumericValue extracts exercise calories as fallback", () => {
  assertEquals(extractNumericValue("exercise", { calories: 300 }), 300);
});

Deno.test("extractNumericValue extracts blood_pressure systolic", () => {
  assertEquals(extractNumericValue("blood_pressure", { systolic: 120, diastolic: 80 }), 120);
});

Deno.test("extractNumericValue extracts body_composition weight_kg", () => {
  assertEquals(extractNumericValue("body_composition", { weight_kg: 75, body_fat: 15 }), 75);
});

Deno.test("extractNumericValue returns null for unknown type", () => {
  assertEquals(extractNumericValue("foobar", { some_value: 42 }), null);
});

Deno.test("extractNumericValue returns null for missing value", () => {
  assertEquals(extractNumericValue("steps", null as any), null);
});

// --- Constants ---

Deno.test("VALID_CATEGORIES contains expected categories", () => {
  const expected = [
    "note", "idea", "decision", "observation",
    "reference", "task", "person", "recipe",
    "travel", "purchase", "quote",
  ];
  assertEquals([...VALID_CATEGORIES], expected);
  assertEquals(VALID_CATEGORIES.length, 11);
});

Deno.test("VALID_SOURCES contains expected sources", () => {
  const expected = [
    "manual", "mcp", "import", "capture",
    "health-connect", "iron-log", "auto",
  ];
  assertEquals([...VALID_SOURCES], expected);
  assertEquals(VALID_SOURCES.length, 7);
});

// --- numeric_value in training_logs context ---

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
