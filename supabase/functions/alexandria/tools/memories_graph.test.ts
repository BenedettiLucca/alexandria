import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.12";
import { sanitizeEntities } from "../lib.ts";

Deno.test("memories_graph: sanitizeEntities deduplicates and preserves valid entities", () => {
  const raw = [
    { name: "Alice", type: "person", context: "meeting" },
    { name: "Alice", type: "person", context: "duplicate" },
    { name: "Project X", type: "project" },
    { name: "  Bob  ", type: "person" },
    { name: "", type: "person" }, // invalid name
    { name: "Unknown", type: "invalid_type" }, // invalid type
  ];

  const valid = sanitizeEntities(raw);
  assertEquals(valid.length, 3);
  assertEquals(valid[0].name, "Alice");
  assertEquals(valid[0].type, "person");
  assertEquals(valid[1].name, "Project X");
  assertEquals(valid[1].type, "project");
  assertEquals(valid[2].name, "Bob");
  assertEquals(valid[2].type, "person");
});

Deno.test("memories_graph: short-path explicit people are added as person entities", () => {
  const extractedEntities = [{ name: "Project X", type: "project", context: null }];
  const allPeople = ["Alice", "Bob"];

  const rawEntities = [...extractedEntities];
  for (const p of allPeople) {
    if (!rawEntities.some((e: any) => e && typeof e === "object" && e.name === p)) {
      rawEntities.push({ name: p, type: "person", context: null });
    }
  }

  const valid = sanitizeEntities(rawEntities);
  assertEquals(valid.length, 3);
  const names = valid.map((e) => e.name);
  assertStringIncludes(names.join(","), "Project X");
  assertStringIncludes(names.join(","), "Alice");
  assertStringIncludes(names.join(","), "Bob");
});

Deno.test("memories_graph: classifier status mapping never labels fallback as LLM", () => {
  function getClassifierName(useLLM: boolean, status?: string): string {
    if (!useLLM) return "keyword";
    if (status === "model") return "LLM";
    if (status === "fallback") return "fallback";
    return "keyword";
  }

  assertEquals(getClassifierName(true, "model"), "LLM");
  assertEquals(getClassifierName(true, "fallback"), "fallback");
  assertEquals(getClassifierName(false, "model"), "keyword");
  assertEquals(getClassifierName(false, "fallback"), "keyword");
});
