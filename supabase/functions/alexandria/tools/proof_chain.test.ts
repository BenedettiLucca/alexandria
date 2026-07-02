import { assertEquals, assert } from "jsr:@std/assert@1.0.12";
import {
  countSources,
  hasEvidenceBlocks,
  hasCitations,
  classifyProvenanceDepth,
  isStale,
  computeProofChainScore,
  formatScoreBreakdown
} from "./proof_chain.ts";

Deno.test("Primary-backed brief outscores derivative", () => {
  const today = new Date().toISOString().split("T")[0];
  const briefA = {
    kind: "night_research",
    source_job: "crawler",
    brief_date: today,
    body_markdown: "Source: https://example.com/a\nSource: https://example.com/b\nSource: https://example.com/c\n> evidence"
  };
  const briefB = {
    kind: "draft_room",
    source_job: "room-builder",
    brief_date: today,
    body_markdown: "some body with no sources"
  };

  const resA = computeProofChainScore(briefA);
  const resB = computeProofChainScore(briefB);

  assert(resA.score > resB.score, "Brief A should outscore Brief B");
  assert(resA.score >= 70, `Brief A score ${resA.score} should be >= 70`);
  assert(resB.score <= 40, `Brief B score ${resB.score} should be <= 40`);
});

Deno.test("Source count test", () => {
  const body = "Source: https://example.com/a\nSource: https://example.com/b\nSource: https://example.com/c";
  assertEquals(countSources(body), 3);
});

Deno.test("Evidence block detection", () => {
  const bodyWithQuote = "> Quote from primary source";
  assertEquals(hasEvidenceBlocks(bodyWithQuote), true);

  const bodyWithout = "regular text without markers";
  assertEquals(hasEvidenceBlocks(bodyWithout), false);
});

Deno.test("Citation detection", () => {
  const bodyWithCitation = "[1] See primary data";
  assertEquals(hasCitations(bodyWithCitation), true);
});

Deno.test("Stale penalty", () => {
  assertEquals(isStale("2026-01-01"), true);
  const today = new Date().toISOString().split("T")[0];
  assertEquals(isStale(today), false);
});

Deno.test("Provenance depth classification", () => {
  assertEquals(classifyProvenanceDepth("night_research", "any"), "primary");
  assertEquals(classifyProvenanceDepth("report", "any"), "summary");
  assertEquals(classifyProvenanceDepth("draft_room", "any"), "summary_of_summary");
});

Deno.test("Breakdown contains reasons", () => {
  const today = new Date().toISOString().split("T")[0];
  const brief = {
    kind: "night_research",
    source_job: "crawler",
    brief_date: today,
    body_markdown: "Source: https://example.com/a\nSource: https://example.com/b\nSource: https://example.com/c\n> evidence"
  };

  const res = computeProofChainScore(brief);
  const hasPrimary = res.breakdown.some(item => item.includes("primary"));
  const hasSource = res.breakdown.some(item => item.includes("source"));
  const hasEvidence = res.breakdown.some(item => item.includes("evidence"));

  assert(hasPrimary, "Breakdown should mention primary");
  assert(hasSource, "Breakdown should mention source");
  assert(hasEvidence, "Breakdown should mention evidence");

  res.breakdown.forEach(item => {
    assert(item.length > 0, "Breakdown item should not be empty");
  });
});

Deno.test("Format test", () => {
  const score = {
    score: 85,
    source_count: 3,
    primary_source_count: 3,
    derivative_source_count: 0,
    provenance_depth: "primary" as const,
    has_evidence_blocks: true,
    has_citations: false,
    stale_penalty: false,
    single_source_penalty: false,
    breakdown: ["primary provenance: +15", "3 sources found: +15", "evidence blocks present: +10"]
  };

  const output = formatScoreBreakdown(score);
  assert(output.includes("85"), "Format should contain score number");
  assert(output.includes("primary provenance: +15"), "Format should contain at least one breakdown item");
});
