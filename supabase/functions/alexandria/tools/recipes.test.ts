import { assertEquals } from "jsr:@std/assert@1.0.12";
import {
  applyRecipeExclusions,
  applyRecipeWeights,
  formatRankedManifest,
} from "./recipes.ts";

Deno.test("Exclusion test - excluded_kinds excludes matching briefs", () => {
  const recipe: any = {
    excluded_kinds: ["content_coach"],
    allowed_kinds: [],
    allowed_source_jobs: [],
    excluded_source_jobs: [],
  };
  const briefs: any[] = [
    { id: "1", title: "Brief 1", kind: "night_research", source_job: "crawler", similarity: 0.9 },
    { id: "2", title: "Brief 2", kind: "content_coach", source_job: "crawler", similarity: 0.8 },
    { id: "3", title: "Brief 3", kind: "synapse_diff", source_job: "crawler", similarity: 0.7 },
  ];
  const { included, excluded } = applyRecipeExclusions(briefs, recipe);
  assertEquals(included.length, 2);
  assertEquals(excluded.length, 1);
  assertEquals(excluded[0].brief.id, "2");
  assertEquals(excluded[0].reason.includes("Excluded kind: content_coach"), true);
});

Deno.test("Weight rerank test - priority_weights boost adjusted score and sort order", () => {
  const recipe: any = {
    priority_weights: {
      source_job: { "iron-log-sync": 0.2 },
    },
  };
  const briefs: any[] = [
    { id: "A", title: "Brief A", kind: "report", source_job: "crawler", similarity: 0.9 },
    { id: "B", title: "Brief B", kind: "report", source_job: "iron-log-sync", similarity: 0.8 },
  ];
  const ranked = applyRecipeWeights(briefs, recipe);
  assertEquals(ranked.length, 2);
  assertEquals(ranked[0].brief.id, "B");
  assertEquals(ranked[1].brief.id, "A");

  assertEquals(
    ranked[0].inclusion_reason,
    "semantic match (0.8) + source_job boost (iron-log-sync: +0.2) = 1",
  );
  assertEquals(ranked[1].inclusion_reason, "semantic match (0.9) = 0.9");
});

Deno.test("Allowed-list filter test - allowed_kinds keeps only matching briefs", () => {
  const recipe: any = {
    allowed_kinds: ["night_research"],
    allowed_source_jobs: [],
    excluded_kinds: [],
    excluded_source_jobs: [],
  };
  const briefs: any[] = [
    { id: "1", title: "Brief 1", kind: "night_research", source_job: "crawler", similarity: 0.9 },
    { id: "2", title: "Brief 2", kind: "content_coach", source_job: "crawler", similarity: 0.8 },
    { id: "3", title: "Brief 3", kind: "night_research", source_job: "crawler", similarity: 0.7 },
  ];
  const { included, excluded } = applyRecipeExclusions(briefs, recipe);
  assertEquals(included.length, 2);
  assertEquals(included[0].id, "1");
  assertEquals(included[1].id, "3");
  assertEquals(excluded.length, 1);
  assertEquals(excluded[0].brief.id, "2");
  assertEquals(
    excluded[0].reason.includes('Kind "content_coach" is not allowed by recipe'),
    true,
  );
});

Deno.test("Format test - formatRankedManifest contains necessary info", () => {
  const recipe: any = {
    name: "Special Recipe",
  };
  const ranked: any[] = [
    {
      brief: {
        id: "1",
        title: "Brief 1",
        brief_date: "2026-06-15",
        kind: "night_research",
        source_job: "crawler",
      },
      adjusted_score: 1.0,
      inclusion_reason: "semantic match (0.8) + source_job boost (iron-log-sync: +0.2) = 1",
    },
  ];
  const excluded: any[] = [
    {
      brief: {
        id: "2",
        title: "Brief 2",
        brief_date: "2026-06-14",
        kind: "content_coach",
        source_job: "crawler",
      },
      reason: "Excluded kind: content_coach",
    },
  ];
  const output = formatRankedManifest("Test Topic", recipe, ranked, excluded);

  assertEquals(output.includes('Room Manifest for Recipe: "Special Recipe"'), true);
  assertEquals(
    output.includes("semantic match (0.8) + source_job boost (iron-log-sync: +0.2) = 1"),
    true,
  );
  assertEquals(output.includes("Excluded kind: content_coach"), true);
  assertEquals(output.includes("Excluded by recipe"), true);
  assertEquals(output.includes("Top items:"), true);
});
