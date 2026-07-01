// deno-lint-ignore no-import-prefix
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import {
  briefToText,
  computeBriefContentHash,
  normalizeBriefBody,
} from "../lib.ts";

Deno.test("briefToText produces string output", () => {
  const brief = {
    title: "Sprint review",
    body: "Avançamos nos testes do brl",
    tags: ["sprint"],
  };
  const text = briefToText(brief);
  assertExists(text);
  assertEquals(typeof text, "string");
});

Deno.test("computeBriefContentHash is deterministic", async () => {
  const input = {
    source_job: "test",
    title: "Test",
    brief_date: "2026-01-01",
    kind: "report",
    body_markdown: "conteúdo do brief",
  };
  const h1 = await computeBriefContentHash(input);
  const h2 = await computeBriefContentHash(input);
  assertEquals(h1, h2);
});

Deno.test("normalizeBriefBody cleans extra whitespace", () => {
  const raw = "  Linha 1  \n\n  Linha 2   ";
  const normalized = normalizeBriefBody(raw);
  assertExists(normalized);
});
