import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import {
  DEFAULT_EMBEDDING_SPACE,
  DimensionMismatchError,
  EMBEDDING_DIMENSION,
  generateSyntheticEmbedding,
  IndexingWorker,
  InvalidBudgetError,
  InvalidSpaceError,
  preflightDimensionCheck,
  preflightSpaceCheck,
} from "./lifecycle.ts";

Deno.test("lifecycle: preflightDimensionCheck succeeds on 2048 and throws on mismatch", () => {
  preflightDimensionCheck(2048);
  preflightDimensionCheck(2048, 2048);

  assertThrows(
    () => preflightDimensionCheck(512),
    DimensionMismatchError,
    "Embedding dimension mismatch: expected 2048, got 512",
  );

  assertThrows(
    () => preflightDimensionCheck(3072),
    DimensionMismatchError,
    "Embedding dimension mismatch: expected 2048, got 3072",
  );
});

Deno.test("lifecycle: preflightSpaceCheck validates space and rejects incompatible spaces", () => {
  preflightSpaceCheck("qwen/qwen3-embedding-8b");

  assertThrows(
    () => preflightSpaceCheck(""),
    InvalidSpaceError,
  );

  assertThrows(
    () => preflightSpaceCheck("   "),
    InvalidSpaceError,
  );

  // 3072 dimension space rejected for 2048 schema
  assertThrows(
    () => preflightSpaceCheck("openai/text-embedding-3-large"),
    DimensionMismatchError,
  );
});

Deno.test("lifecycle: generateSyntheticEmbedding is deterministic and normalized", () => {
  const textA = "Workout: Push day 5x5 bench press";
  const vec1 = generateSyntheticEmbedding(textA);
  const vec2 = generateSyntheticEmbedding(textA);

  assertEquals(vec1.length, 2048);
  assertEquals(vec2.length, 2048);
  assertEquals(vec1, vec2);

  const textB = "Workout: Leg day 4x10 squats";
  const vecB = generateSyntheticEmbedding(textB);
  assertEquals(vecB.length, 2048);

  // Different text generates different embeddings
  let differenceCount = 0;
  for (let i = 0; i < 2048; i++) {
    if (Math.abs(vec1[i] - vecB[i]) > 1e-4) {
      differenceCount++;
    }
  }
  assertEquals(differenceCount > 1000, true);

  // Check approximate normalization (L2 norm ~ 1)
  let normSq = 0;
  for (let i = 0; i < 2048; i++) {
    normSq += vec1[i] * vec1[i];
  }
  assertEquals(Math.abs(Math.sqrt(normSq) - 1.0) < 0.05, true);
});

Deno.test("lifecycle: backfillLegacy requires explicit space and positive budget", async () => {
  const worker = new IndexingWorker({ useSynthetic: true });

  await assertRejects(
    async () => {
      await worker.backfillLegacy({ space: "", budget: 10 });
    },
    InvalidSpaceError,
  );

  await assertRejects(
    async () => {
      await worker.backfillLegacy({
        space: "qwen/qwen3-embedding-8b",
        budget: 0,
      });
    },
    InvalidBudgetError,
  );

  await assertRejects(
    async () => {
      await worker.backfillLegacy({
        space: "qwen/qwen3-embedding-8b",
        budget: -5,
      });
    },
    InvalidBudgetError,
  );
});

Deno.test("lifecycle: reconcileBatch respects deadline timeout", async () => {
  let currentTime = 1000;
  const mockNow = () => {
    const t = currentTime;
    currentTime += 1000; // each call advances time by 1s
    return t;
  };

  const worker = new IndexingWorker({
    useSynthetic: true,
    nowFn: mockNow,
  });

  // Mock claimBatch to return synthetic jobs
  worker.claimBatch = async () => {
    return [
      {
        id: "job-1",
        user_id: "user-1",
        source_table: "memories",
        source_id: "mem-1",
        source_version: 1,
        content_hash: "hash-1",
        target_space: DEFAULT_EMBEDDING_SPACE,
        target_dimension: 2048,
        job_type: "embedding",
        status: "pending",
        attempts: 0,
        max_attempts: 5,
      },
      {
        id: "job-2",
        user_id: "user-1",
        source_table: "memories",
        source_id: "mem-2",
        source_version: 1,
        content_hash: "hash-2",
        target_space: DEFAULT_EMBEDDING_SPACE,
        target_dimension: 2048,
        job_type: "embedding",
        status: "pending",
        attempts: 0,
        max_attempts: 5,
      },
    ];
  };

  worker.processJob = async () => "ready";
  worker.getLifecycleStatus = async () => ({
    outbox: { total: 2, pending: 1, processing: 0, ready: 1, failed: 0, oldest_pending_at: null },
    tables: {
      memories: { total: 2, ready: 1, pending: 1, failed: 0 },
      briefs: { total: 0, ready: 0, pending: 0, failed: 0 },
      health_entries: { total: 0, ready: 0, pending: 0, failed: 0 },
      training_logs: { total: 0, ready: 0, pending: 0, failed: 0 },
    },
  });

  const res = await worker.reconcileBatch({
    deadlineMs: 1500, // loop 0: elapsed 1000 < 1500 -> processes job 1; loop 1: elapsed 2000 >= 1500 -> break!
  });

  assertEquals(res.processed, 1);
  assertEquals(res.succeeded, 1);
  assertEquals(res.timedOut, true);
  assertEquals(res.nextCursor, "job-2");
});
