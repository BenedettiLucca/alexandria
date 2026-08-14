import { assertEquals } from "jsr:@std/assert@1.0.12";
import { canonicalJson, paramsHash, sha256Hex } from "../telemetry.ts";
import { formatToolActivationReport } from "../lib.ts";
import type { ToolActivationRow } from "../types.ts";

Deno.test("canonicalJson is deterministic across key order", () => {
  const a = { b: 1, a: [2, { d: 4, c: 3 }] };
  const b = { a: [2, { c: 3, d: 4 }], b: 1 };
  assertEquals(canonicalJson(a), canonicalJson(b));
});

Deno.test("canonicalJson handles primitives and null", () => {
  assertEquals(canonicalJson(null), "null");
  assertEquals(canonicalJson("x"), '"x"');
  assertEquals(canonicalJson(42), "42");
  assertEquals(canonicalJson(undefined), undefined);
});

Deno.test("sha256Hex matches known vector", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("paramsHash is stable for same params", async () => {
  const h1 = await paramsHash({ query: "test", limit: 5 });
  const h2 = await paramsHash({ limit: 5, query: "test" });
  assertEquals(h1, h2);
});

const activeRow: ToolActivationRow = {
  tool_name: "search_memories",
  never_called: false,
  called_7d: true,
  called_30d: true,
  called_90d: true,
  total_calls: 10,
  success_rate: 90,
  avg_latency_ms: 120,
  last_called_at: "2026-08-14T00:00:00Z",
  client_count: 2,
  clients: ["claude", "hermes"],
  trend: "rising",
};

const dormantRow: ToolActivationRow = {
  tool_name: "delete_memory",
  never_called: false,
  called_7d: false,
  called_30d: false,
  called_90d: false,
  total_calls: 0,
  success_rate: null,
  avg_latency_ms: null,
  last_called_at: null,
  client_count: 0,
  clients: [],
  trend: "dormant",
};

const neverRow: ToolActivationRow = {
  tool_name: "score_brief_provenance",
  never_called: true,
  called_7d: false,
  called_30d: false,
  called_90d: false,
  total_calls: 0,
  success_rate: null,
  avg_latency_ms: null,
  last_called_at: null,
  client_count: 0,
  clients: [],
  trend: "never",
};

Deno.test("formatToolActivationReport empty rows", () => {
  const output = formatToolActivationReport([]);
  assertEquals(output, "No tool activation data available.");
});

Deno.test("formatToolActivationReport groups never, dormant, active", () => {
  const output = formatToolActivationReport([
    activeRow,
    dormantRow,
    neverRow,
  ]);
  assertEquals(output.includes("Tool Activation Report"), true);
  assertEquals(output.includes("🔴 NEVER CALLED (1):"), true);
  assertEquals(output.includes("- score_brief_provenance"), true);
  assertEquals(output.includes("🟡 DORMANT (1):"), true);
  assertEquals(output.includes("- delete_memory"), true);
  assertEquals(output.includes("🟢 ACTIVE (1):"), true);
  assertEquals(output.includes("- search_memories"), true);
  assertEquals(output.includes("trend: rising"), true);
  assertEquals(output.includes("clients: claude, hermes"), true);
  assertEquals(output.includes("success 90%"), true);
  assertEquals(output.includes("avg 120ms"), true);
});
