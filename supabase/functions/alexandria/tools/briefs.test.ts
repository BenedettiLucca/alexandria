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

Deno.test("computeBriefContentHash is deterministic", () => {
  const body = "conteúdo do brief";
  const h1 = computeBriefContentHash(body);
  const h2 = computeBriefContentHash(body);
  assertEquals(h1, h2);
});

Deno.test("normalizeBriefBody cleans extra whitespace", () => {
  const raw = "  Linha 1  \n\n  Linha 2   ";
  const normalized = normalizeBriefBody(raw);
  assertExists(normalized);
});
