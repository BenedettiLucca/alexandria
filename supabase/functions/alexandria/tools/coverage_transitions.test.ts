import { assertEquals } from "jsr:@std/assert@1.0.12";
import { formatCoverageTransitions, formatCoverageWarnings } from "../lib.ts";

const base = {
  source_kind: "health",
  source_name: "health-connect",
  prev_status: "current",
  prev_captured_at: "2026-08-13T00:00:00Z",
  current_status: "missing",
  current_captured_at: "2026-08-14T00:00:00Z",
  first_degraded_at: "2026-08-14T00:00:00Z",
  degradation_streak: 1,
  gap_hours: null,
  expected_cadence_hours: 36,
  last_success_at: null,
  last_failure_at: null,
  last_expected_run_at: null,
  artifact_freshness_status: "n/a",
  trust_blocking: false,
};

Deno.test("formatCoverageTransitions empty rows", () => {
  const output = formatCoverageTransitions([]);
  assertEquals(output.includes("No coverage transition history"), true);
});

Deno.test("formatCoverageTransitions groups NEW degradation", () => {
  const rows = [
    {
      ...base,
      lane: "sleep",
      transition_type: "NEW",
    },
  ];

  const output = formatCoverageTransitions(rows);
  assertEquals(output.includes("Coverage Transition Report"), true);
  assertEquals(output.includes("🟠 NEW DEGRADATION:"), true);
  assertEquals(output.includes("- sleep"), true);
  assertEquals(output.includes("Transition: NEW"), true);
});

Deno.test("formatCoverageTransitions flags trust-blocking separately", () => {
  const rows = [
    {
      ...base,
      lane: "steps",
      transition_type: "ONGOING",
      degradation_streak: 3,
      trust_blocking: true,
    },
  ];

  const output = formatCoverageTransitions(rows);
  assertEquals(output.includes("🔴 TRUST-BLOCKING"), true);
  assertEquals(output.includes("Streak: 3 snapshot(s)"), true);
  assertEquals(output.includes("First degraded"), true);
});

Deno.test("formatCoverageTransitions distinguishes RECOVERED and STEADY", () => {
  const rows = [
    {
      ...base,
      lane: "weight",
      current_status: "current",
      transition_type: "RECOVERED",
      first_degraded_at: null,
      degradation_streak: 0,
    },
    {
      ...base,
      lane: "heart_rate",
      current_status: "current",
      transition_type: "STEADY",
      first_degraded_at: null,
      degradation_streak: 0,
    },
  ];

  const output = formatCoverageTransitions(rows);
  assertEquals(output.includes("🟢 RECOVERED:"), true);
  assertEquals(output.includes("⚪ STEADY / HEALTHY:"), true);
});

Deno.test("formatCoverageTransitions renders brief artifact freshness", () => {
  const rows = [
    {
      ...base,
      source_kind: "brief",
      lane: "night_research_pack",
      current_status: "missing",
      transition_type: "NEW",
      artifact_freshness_status: "stale",
      last_success_at: "2026-08-01T00:00:00Z",
      last_failure_at: "2026-08-14T00:00:00Z",
      last_expected_run_at: "2026-08-14T00:00:00Z",
    },
  ];

  const output = formatCoverageTransitions(rows);
  assertEquals(output.includes("[brief]"), true);
  assertEquals(output.includes("Artifact: stale"), true);
});

Deno.test("formatCoverageWarnings annotates NEW and ONGOING via transitions", () => {
  const covRows = [
    {
      source_name: "health-connect",
      lane: "sleep",
      last_event_at: null,
      last_ingested_at: null,
      last_summary_refresh_at: null,
      expected_cadence_hours: 36,
      gap_hours: null,
      coverage_status: "missing",
      true_zero_possible: false,
      notes: [],
    },
  ];
  const transitions = {
    "health-connect:sleep": {
      ...base,
      lane: "sleep",
      transition_type: "NEW",
    },
  };

  const output = formatCoverageWarnings(covRows, transitions);
  assertEquals(output.includes("missing [NEW]"), true);
});
