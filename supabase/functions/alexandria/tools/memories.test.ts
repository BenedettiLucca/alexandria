// deno-lint-ignore no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  simpleClassify,
  VALID_CATEGORIES,
  VALID_SOURCES,
  memoryToText,
  formatMemoryStats,
} from "../lib.ts";

// --- simpleClassify ---

Deno.test("simpleClassify detects workout as observation", () => {
  const result = simpleClassify("Fiz supino 100kg hoje no gym");
  assertEquals(result.category, "observation");
});

Deno.test("simpleClassify detects decision", () => {
  const result = simpleClassify("we decided to use the new approach");
  assertEquals(result.category, "decision");
});

Deno.test("simpleClassify falls back to note for unknown text", () => {
  const result = simpleClassify("Qualquer coisa aleatória aqui");
  assertEquals(result.category, "note");
});

// --- VALID_CATEGORIES / VALID_SOURCES ---

Deno.test("VALID_CATEGORIES contains expected values", () => {
  assertExists(VALID_CATEGORIES);
  assertEquals(Array.isArray(VALID_CATEGORIES), true);
  assertEquals(VALID_CATEGORIES.includes("observation"), true);
});

// --- memoryToText ---

Deno.test("memoryToText produces readable string", () => {
  const memory = {
    title: "Test memory",
    content: "Conteúdo importante",
    category: "idea",
    tags: ["test"],
  };
  const text = memoryToText(memory);
  assertExists(text);
  assertEquals(typeof text, "string");
  assertEquals(text.includes("Test memory"), true);
});

// --- formatMemoryStats ---

Deno.test("formatMemoryStats handles empty list", () => {
  const stats = formatMemoryStats({ count: 0, entries: [] });
  assertExists(stats);
  assertEquals(typeof stats, "string");
});
