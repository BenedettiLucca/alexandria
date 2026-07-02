import { assertEquals } from "jsr:@std/assert@1.0.12";
import { formatCoverageWarnings, formatCoverageReport } from "../lib.ts";

Deno.test("formatCoverageWarnings formats mixed-state scenario correctly", () => {
  const rows = [
    {
      lane: "workouts",
      source_name: "iron-log",
      coverage_status: "current",
      last_event_at: "2026-07-02T00:00:00Z",
      gap_hours: 4,
      expected_cadence_hours: 96,
      true_zero_possible: true,
      notes: ["recent_workouts_found"]
    },
    {
      lane: "sleep",
      source_name: "health-connect",
      coverage_status: "missing",
      last_event_at: null,
      gap_hours: null,
      expected_cadence_hours: 36,
      true_zero_possible: false,
      notes: ["no_data_points", "no_sync_log", "recent_workouts_found"]
    },
    {
      lane: "steps",
      source_name: "health-connect",
      coverage_status: "never_seen",
      last_event_at: null,
      gap_hours: null,
      expected_cadence_hours: 36,
      true_zero_possible: false,
      notes: ["no_data_points", "no_sync_log"]
    }
  ];

  const output = formatCoverageWarnings(rows);

  // Output must distinguish missing data from zero
  assertEquals(output.includes("Coverage warnings:"), true);
  assertEquals(output.includes("- sleep: missing"), true);
  assertEquals(output.includes("- steps: never_seen"), true);
  assertEquals(output.includes("workouts recent"), true);
  assertEquals(output.includes("no sync log"), true);
  assertEquals(output.includes("0"), false); // Should not have 0 representing values
  assertEquals(output.includes("zero"), false); // Should not say zero representing values
});

Deno.test("formatCoverageReport groups rows by status severity", () => {
  const rows = [
    {
      lane: "workouts",
      source_name: "iron-log",
      coverage_status: "current",
      last_event_at: "2026-07-02T00:00:00Z",
      gap_hours: 4,
      expected_cadence_hours: 96,
      true_zero_possible: true,
      notes: []
    },
    {
      lane: "sleep",
      source_name: "health-connect",
      coverage_status: "missing",
      last_event_at: null,
      gap_hours: null,
      expected_cadence_hours: 36,
      true_zero_possible: false,
      notes: []
    },
    {
      lane: "steps",
      source_name: "health-connect",
      coverage_status: "never_seen",
      last_event_at: null,
      gap_hours: null,
      expected_cadence_hours: 36,
      true_zero_possible: false,
      notes: []
    },
    {
      lane: "weight",
      source_name: "health-connect",
      coverage_status: "late",
      last_event_at: "2026-06-15T00:00:00Z",
      gap_hours: 400,
      expected_cadence_hours: 336,
      true_zero_possible: false,
      notes: []
    }
  ];

  const report = formatCoverageReport(rows);

  assertEquals(report.includes("Source Coverage Diagnostics Report"), true);
  assertEquals(report.includes("🚨 CRITICAL / MISSING DATA:"), true);
  assertEquals(report.includes("⚠️ STALE / LATE DATA:"), true);
  assertEquals(report.includes("✅ CURRENT (HEALTHY):"), true);
  assertEquals(report.includes("sleep"), true);
  assertEquals(report.includes("steps"), true);
  assertEquals(report.includes("weight"), true);
  assertEquals(report.includes("workouts"), true);
});
