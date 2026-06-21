import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  simpleClassify,
  sanitizeClassification,
  VALID_CATEGORIES,
  recordToText,
  normalizeStringArray,
} from "../lib.ts";

Deno.test("simpleClassify returns valid category for short text", () => {
  const result = simpleClassify("I had a great idea for a new app");
  assertEquals(result.category, "idea");
});

Deno.test("simpleClassify extracts title from content", () => {
  const result = simpleClassify("Something");
  assertExists(result);
  assertEquals(result.title, null);
});

Deno.test("sanitizeClassification clamps importance to 1-10", () => {
  assertEquals(sanitizeClassification({ importance: 11 }).importance, 5);
  assertEquals(sanitizeClassification({ importance: 0 }).importance, 5);
  assertEquals(sanitizeClassification({ importance: 7 }).importance, 7);
});

Deno.test("sanitizeClassification fixes invalid category to 'note'", () => {
  assertEquals(sanitizeClassification({ category: "invalid" }).category, "note");
});

Deno.test("sanitizeClassification cleans tags array", () => {
  const result = sanitizeClassification({ tags: [" TAG1 ", "tag2", "tag1"] });
  assertEquals(result.tags, ["tag1", "tag2"]);
});

Deno.test("normalizeStringArray trims whitespace", () => {
  assertEquals(normalizeStringArray(["  a  ", "b"]), ["a", "b"]);
});

Deno.test("normalizeStringArray deduplicates", () => {
  assertEquals(normalizeStringArray(["a", "a", "b"]), ["a", "b"]);
});

Deno.test("normalizeStringArray lowercases when requested", () => {
  assertEquals(normalizeStringArray(["A", "B"], { lowercase: true }), ["a", "b"]);
});

Deno.test("normalizeStringArray handles empty arrays", () => {
  assertEquals(normalizeStringArray([]), []);
  assertEquals(normalizeStringArray(null), []);
});

Deno.test("recordToText serializes memory with all fields", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    numeric_value: 100,
    duration_s: 600,
  };
  const text = recordToText("steps", record);
  assertExists(text);
  assertEquals(text.includes("100 steps"), true);
  assertEquals(text.includes("10 minutes"), true);
});

Deno.test("recordToText handles missing optional fields", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    numeric_value: 100,
  };
  const text = recordToText("steps", record);
  assertEquals(text.includes("100 steps"), true);
  assertEquals(text.includes("minutes"), false);
});

Deno.test("VALID_CATEGORIES contains expected categories", () => {
  assertEquals(VALID_CATEGORIES.includes("note"), true);
  assertEquals(VALID_CATEGORIES.includes("idea"), true);
  assertEquals(VALID_CATEGORIES.includes("task"), true);
});
