// deno-lint-ignore no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  computeBodyCompDelta,
  extractBodyCompMetrics,
  formatBodyCompSummary,
} from "../lib.ts";

// --- computeBodyCompDelta ---

Deno.test("computeBodyCompDelta calculates deltas correctly", () => {
  const current = {
    weight_kg: 80.5,
    body_fat_percent: 17.2,
    waist_cm: 89,
  };
  const previous = {
    weight_kg: 82.0,
    body_fat_percent: 18.5,
    waist_cm: 92,
  };

  const delta = computeBodyCompDelta(current, previous);

  assertEquals(delta.weight_kg?.delta, -1.5);
  assertEquals(delta.body_fat_percent?.delta, -1.3);
  assertEquals(delta.waist_cm?.delta, -3);
  assertEquals(delta.weight_kg?.direction, "down");
});

Deno.test("computeBodyCompDelta handles missing values gracefully", () => {
  const current = { weight_kg: 80.5 };
  const previous = { weight_kg: 82.0 };

  const delta = computeBodyCompDelta(current, previous);
  assertEquals(delta.weight_kg?.delta, -1.5);
});

// --- extractBodyCompMetrics ---

Deno.test("extractBodyCompMetrics extracts all fields when present", () => {
  const value = {
    weight_kg: 80,
    body_fat_percent: 15.5,
    skeletal_muscle_kg: 35.2,
    waist_cm: 85,
  };
  const result = extractBodyCompMetrics(value);
  assertEquals(result.weight_kg, 80);
  assertEquals(result.body_fat_percent, 15.5);
});

Deno.test("extractBodyCompMetrics returns partial object for incomplete data", () => {
  const value = { weight_kg: 75 };
  const result = extractBodyCompMetrics(value);
  assertEquals(result.weight_kg, 75);
  assertEquals(result.body_fat_percent, null);
});

// --- formatBodyCompSummary (signature requires entries + goals + dateRange) ---

Deno.test("formatBodyCompSummary returns message for empty entries", () => {
  const result = formatBodyCompSummary([], [], { from: "2026-06-01", to: "2026-06-08" });
  assertEquals(result.includes("No body composition entries"), true);
});
