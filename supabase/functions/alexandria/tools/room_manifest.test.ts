import { assertEquals, assertExists } from "jsr:@std/assert@1.0.12";
import { supabase } from "../config.ts";
import { registerBriefsTools } from "./briefs.ts";
import {
  isBriefFresh,
  extractNumbers,
  hasOpposingWords,
  detectConflicts,
  detectProofGaps,
  computeReadOrder,
  computeNextActions,
  formatRoomManifest,
} from "./briefs.ts";

Deno.test("Freshness bucketing - within 14 days is fresh, older is stale", () => {
  const refDate = new Date("2026-06-15T00:00:00Z");
  // 14 days ago is 2026-06-01
  assertEquals(isBriefFresh("2026-06-15", refDate), true);
  assertEquals(isBriefFresh("2026-06-02", refDate), true);
  assertEquals(isBriefFresh("2026-06-01", refDate), true);
  assertEquals(isBriefFresh("2026-05-31", refDate), false);
  assertEquals(isBriefFresh("2026-05-15", refDate), false);
});

Deno.test("Conflict detection by opposing status words", () => {
  const brief1 = {
    id: "1",
    title: "Brief 1",
    brief_date: "2026-06-15",
    kind: "report",
    source_job: "job",
    body_markdown: "The project status is confirmed.",
    similarity: 0.9,
  };
  const brief2 = {
    id: "2",
    title: "Brief 2",
    brief_date: "2026-06-14",
    kind: "report",
    source_job: "job",
    body_markdown: "The project status is rumored.",
    similarity: 0.8,
  };
  const conflicts = detectConflicts([brief1, brief2]);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].reason.includes("confirmed"), true);
  assertEquals(conflicts[0].reason.includes("rumored"), true);
});

Deno.test("Conflict detection by number variance (>20% difference)", () => {
  const brief1 = {
    id: "1",
    title: "Brief 1",
    brief_date: "2026-06-15",
    kind: "report",
    source_job: "job",
    body_markdown: "Revenue: $100,000",
    similarity: 0.9,
  };
  const brief2 = {
    id: "2",
    title: "Brief 2",
    brief_date: "2026-06-14",
    kind: "report",
    source_job: "job",
    body_markdown: "Revenue: 130,000",
    similarity: 0.8,
  };
  const conflicts = detectConflicts([brief1, brief2]);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].reason.includes("revenue"), true);
  assertEquals(conflicts[0].reason.includes("100000 vs 130000"), true);
});

Deno.test("Proof gap - single-source detection", () => {
  const brief = {
    id: "1",
    title: "Brief 1",
    brief_date: "2026-06-15",
    kind: "report",
    source_job: "job",
    body_markdown: "Some content",
    similarity: 0.9,
  };
  const gaps = detectProofGaps([brief], 1, 0);
  const thinEvidenceGap = gaps.find((g) => g.gap_type === "thin_evidence");
  assertEquals(!!thinEvidenceGap, true);
});

Deno.test("Proof gap - stale-only detection", () => {
  const brief1 = {
    id: "1",
    title: "Brief 1",
    brief_date: "2026-05-15",
    kind: "report",
    source_job: "job",
    body_markdown: "Some content",
    similarity: 0.9,
  };
  const brief2 = {
    id: "2",
    title: "Brief 2",
    brief_date: "2026-05-14",
    kind: "report",
    source_job: "job",
    body_markdown: "Some content",
    similarity: 0.8,
  };
  const gaps = detectProofGaps([brief1, brief2], 0, 2);
  const outdatedGap = gaps.find((g) => g.gap_type === "outdated");
  assertEquals(!!outdatedGap, true);
});

Deno.test("Suggested read order - fresh first, then highest-similarity stale, then remaining by similarity descending", () => {
  const f1 = {
    id: "f1",
    title: "Fresh 1",
    brief_date: "2026-06-10",
    kind: "report",
    source_job: "job",
    body_markdown: "A",
    similarity: 0.7,
  };
  const f2 = {
    id: "f2",
    title: "Fresh 2",
    brief_date: "2026-06-12",
    kind: "report",
    source_job: "job",
    body_markdown: "B",
    similarity: 0.8,
  };
  const s1 = {
    id: "s1",
    title: "Stale 1",
    brief_date: "2026-05-01",
    kind: "report",
    source_job: "job",
    body_markdown: "C",
    similarity: 0.9,
  };
  const s2 = {
    id: "s2",
    title: "Stale 2",
    brief_date: "2026-04-15",
    kind: "report",
    source_job: "job",
    body_markdown: "D",
    similarity: 0.6,
  };

  const order = computeReadOrder([f1, f2], [s1, s2]);
  assertEquals(order[0].id, "f2");
  assertEquals(order[1].id, "s1");
  assertEquals(order[2].id, "f1");
  assertEquals(order[3].id, "s2");
});

Deno.test("Next actions generation based on manifest state", () => {
  // Scenario 1: Clean
  const actionsClean = computeNextActions(3, 2, false);
  assertEquals(actionsClean, ["Room is ready — proceed to draft"]);

  // Scenario 2: Conflicts
  const actionsConflict = computeNextActions(3, 2, true);
  assertEquals(actionsConflict.includes("Review conflicting briefs before drafting"), true);

  // Scenario 3: Stale only
  const actionsStale = computeNextActions(2, 0, false);
  assertEquals(actionsStale.includes("Refresh research — all inputs are >14 days old"), true);

  // Scenario 4: Thin evidence
  const actionsThin = computeNextActions(1, 1, false);
  assertEquals(actionsThin.includes("Gather additional sources before drafting"), true);
});

Deno.test("Full build_room_manifest integration with mocked database", async () => {
  // Save original supabase methods
  const originalRpc = supabase.rpc;
  const originalFrom = supabase.from;
  const originalFetch = globalThis.fetch;

  // Setup mocks
  let rpcCalled = false;
  let selectCalled = false;
  let insertCalled = false;

  // Mock global fetch to intercept OpenRouter embeddings API calls
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/embeddings")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }
    return originalFetch(input, init);
  };

  supabase.rpc = function (fnName: string, params: any) {
    rpcCalled = true;
    assertEquals(fnName, "search_briefs");
    assertExists(params.query_embedding);
    return Promise.resolve({
      data: [
        {
          id: "b1",
          title: "Fresh Brief",
          brief_date: new Date().toISOString().split("T")[0],
          kind: "night_research",
          source_job: "crawler",
          body_markdown: "Revenue: 100",
          similarity: 0.95,
        },
        {
          id: "b2",
          title: "Stale Brief",
          brief_date: "2026-05-01",
          kind: "report",
          source_job: "manual",
          body_markdown: "Revenue: 150",
          similarity: 0.85,
        }
      ],
      error: null,
    }) as any;
  };

  supabase.from = function (table: string) {
    assertEquals(table, "briefs");
    return {
      select: function () {
        selectCalled = true;
        return {
          eq: function () {
            return {
              maybeSingle: function () {
                // Return no existing to trigger insertion
                return Promise.resolve({ data: null, error: null });
              }
            };
          }
        };
      },
      insert: function (row: any) {
        insertCalled = true;
        assertEquals(row.kind, "draft_room");
        assertEquals(row.source_job, "room-builder");
        return {
          select: function () {
            return {
              single: function () {
                return Promise.resolve({ data: { id: "new_manifest_brief" }, error: null });
              }
            };
          }
        };
      }
    } as any;
  };

  try {
    // Capture registered tool handler
    let capturedHandler: any = null;
    const mockServer = {
      registerTool: (name: string, _config: any, handler: any) => {
        if (name === "build_room_manifest") {
          capturedHandler = handler;
        }
      }
    } as any;

    registerBriefsTools(mockServer, () => undefined);
    assertExists(capturedHandler);

    const resultOk = await capturedHandler({
      topic: "Revenue status",
      persist: true,
    });

    assertEquals(resultOk.isError, undefined);
    assertExists(resultOk.content);
    const text = resultOk.content[0].text;
    
    // Verify integration results
    assertEquals(rpcCalled, true);
    assertEquals(selectCalled, true);
    assertEquals(insertCalled, true);
    assertEquals(text.includes("Room Manifest for Topic"), true);
    assertEquals(text.includes("Potential Conflicts (1)"), true);
    assertEquals(text.includes("Number variance for 'revenue': 100 vs 150"), true);
    assertEquals(text.includes("Persisted draft room brief as ID new_manifest_brief"), true);
  } finally {
    // Cleanup mocks
    supabase.rpc = originalRpc;
    supabase.from = originalFrom;
    globalThis.fetch = originalFetch;
  }
});
