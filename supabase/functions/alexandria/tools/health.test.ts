import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  recordToText,
  extractBodyCompMetrics,
  computeBodyCompDelta,
  formatBodyCompSummary,
} from "../lib.ts";

Deno.test("recordToText serializes sleep entry correctly", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    numeric_value: 8,
    value: { duration_hours: 8, bed_time: "22:00", wake_time: "06:00" }
  };
  const text = recordToText("sleep", record);
  assertEquals(text.includes("slept 8 hours"), true);
  assertEquals(text.includes("from 22:00"), true);
  assertEquals(text.includes("to 06:00"), true);
});

Deno.test("recordToText serializes exercise entry correctly", () => {
    const record = {
        timestamp: "2026-06-06T12:00:00Z",
        numeric_value: 300,
        duration_s: 1800,
        value: { name: "Running" }
    };
    const text = recordToText("exercise", record);
    assertEquals(text.includes("exercise on"), true);
    assertEquals(text.includes("value: 300"), true);
    assertEquals(text.includes("duration: 30min"), true);
});

Deno.test("recordToText serializes heart_rate entry correctly", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    numeric_value: 70
  };
  const text = recordToText("heart_rate", record);
  assertEquals(text.includes("Heart rate of 70 bpm"), true);
});

Deno.test("recordToText serializes weight entry correctly", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    numeric_value: 80
  };
  const text = recordToText("weight", record);
  assertEquals(text.includes("Weight: 80 kg"), true);
});

Deno.test("recordToText serializes body_composition entry correctly", () => {
  const record = {
    timestamp: "2026-06-06T12:00:00Z",
    value: { weight_kg: 80, body_fat_percent: 20 }
  };
  const text = recordToText("body_composition", record);
  assertEquals(text.includes("Body composition on"), true);
  assertEquals(text.includes('"weight_kg":80'), true);
});

Deno.test("extractBodyCompMetrics extracts all 9 fields", () => {
  const value = {
    weight_kg: 80,
    body_fat_percent: 20,
    skeletal_muscle_kg: 40,
    body_water_kg: 50,
    waist_cm: 85,
    chest_cm: 100,
    arm_cm: 35,
    thigh_cm: 55,
    calf_cm: 38,
    extra: 10
  };
  const metrics = extractBodyCompMetrics(value);
  assertEquals(metrics.weight_kg, 80);
  assertEquals(metrics.body_fat_percent, 20);
  assertEquals(metrics.skeletal_muscle_kg, 40);
  assertEquals(metrics.body_water_kg, 50);
  assertEquals(metrics.waist_cm, 85);
  assertEquals(metrics.chest_cm, 100);
  assertEquals(metrics.arm_cm, 35);
  assertEquals(metrics.thigh_cm, 55);
  assertEquals(metrics.calf_cm, 38);
});

Deno.test("extractBodyCompMetrics returns null for missing fields", () => {
    const metrics = extractBodyCompMetrics({});
    assertEquals(metrics.weight_kg, null);
    assertEquals(metrics.body_fat_percent, null);
});

Deno.test("computeBodyCompDelta computes up/down/flat correctly", () => {
  const current = { weight_kg: 80, body_fat_percent: 19, skeletal_muscle_kg: 40 };
  const previous = { weight_kg: 81, body_fat_percent: 20, skeletal_muscle_kg: 40 };
  const deltas = computeBodyCompDelta(current, previous);
  
  assertEquals(deltas.weight_kg, { delta: -1, direction: "down" });
  assertEquals(deltas.body_fat_percent, { delta: -1, direction: "down" });
  assertEquals(deltas.skeletal_muscle_kg, { delta: 0, direction: "flat" });
});

Deno.test("computeBodyCompDelta returns null for missing either side", () => {
    const current = { weight_kg: 80 };
    const previous = { body_fat_percent: 20 };
    const deltas = computeBodyCompDelta(current, previous);
    assertEquals(deltas.weight_kg, null);
    assertEquals(deltas.body_fat_percent, null);
});

Deno.test("formatBodyCompSummary returns 'No entries' message for empty array", () => {
  const summary = formatBodyCompSummary([], [], { from: "2026-06-01", to: "2026-06-07" });
  assertEquals(summary, "No body composition entries found in the selected period.");
});

Deno.test("formatBodyCompSummary includes latest metrics in output", () => {
  const entries = [{
    timestamp: "2026-06-06T12:00:00Z",
    metrics: { weight_kg: 80, body_fat_percent: 20 }
  }];
  const summary = formatBodyCompSummary(entries as any, [], { from: "2026-06-01", to: "2026-06-07" });
  assertEquals(summary.includes("Weight: 80kg"), true);
  assertEquals(summary.includes("Body Fat: 20%"), true);
});

Deno.test("formatBodyCompSummary includes delta arrows", () => {
    const entries = [{
      timestamp: "2026-06-06T12:00:00Z",
      metrics: { weight_kg: 80 },
      delta: { weight_kg: { delta: -1, direction: "down" } }
    }];
    const summary = formatBodyCompSummary(entries as any, [], { from: "2026-06-01", to: "2026-06-07" });
    assertEquals(summary.includes("Weight: 80kg (↓ 1kg)"), true);
});

Deno.test("formatBodyCompSummary includes quality warning for non-standard context", () => {
    const entries = [{
      timestamp: "2026-06-06T12:00:00Z",
      metrics: { weight_kg: 80 },
      context: "evening"
    }];
    const summary = formatBodyCompSummary(entries as any, [], { from: "2026-06-01", to: "2026-06-07" });
    assertEquals(summary.includes("⚠ Non-standard conditions: evening"), true);
});
