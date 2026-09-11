import {
  AuthContext,
  EMBEDDING_MODEL,
  OWNER_USER_ID,
  supabase,
} from "./config.ts";
import {
  briefToText,
  recordToText,
  workoutToText,
} from "./lib.ts";
import {
  type ClassificationResult,
  type ErrorClass,
  OpenRouterProvider,
  ProviderError,
} from "./provider.ts";
import { processEntities } from "./helpers.ts";

export const EMBEDDING_DIMENSION = 1536;
export const DEFAULT_EMBEDDING_SPACE = EMBEDDING_MODEL || "openai/text-embedding-3-small";

export const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "openai/text-embedding-ada-002": 1536,
};

export class DimensionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number, message?: string) {
    super(
      message ||
        `Embedding dimension mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "DimensionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class InvalidSpaceError extends Error {
  constructor(message: string = "Target embedding space must be explicitly specified and non-empty") {
    super(message);
    this.name = "InvalidSpaceError";
  }
}

export class InvalidBudgetError extends Error {
  constructor(message: string = "Backfill budget limit must be a positive integer") {
    super(message);
    this.name = "InvalidBudgetError";
  }
}

export class CasConflictError extends Error {
  constructor(message: string = "CAS conflict: row content or version advanced during embedding") {
    super(message);
    this.name = "CasConflictError";
  }
}

/**
 * Preflight validation before writes or network calls.
 * Fails fast on dimension or space mismatch WITHOUT requiring a paid API request.
 */
export function preflightDimensionCheck(
  dimension: number,
  expected: number = EMBEDDING_DIMENSION,
): void {
  if (dimension !== expected) {
    throw new DimensionMismatchError(expected, dimension);
  }
}

export function preflightSpaceCheck(space: string): void {
  if (!space || typeof space !== "string" || space.trim() === "") {
    throw new InvalidSpaceError();
  }
  const knownDim = KNOWN_EMBEDDING_DIMENSIONS[space];
  if (knownDim !== undefined && knownDim !== EMBEDDING_DIMENSION) {
    throw new DimensionMismatchError(
      EMBEDDING_DIMENSION,
      knownDim,
      `Space '${space}' has dimension ${knownDim}, but schema requires ${EMBEDDING_DIMENSION}`,
    );
  }
}

export interface IndexingJob {
  id: string;
  user_id: string | null;
  source_table: "memories" | "briefs" | "health_entries" | "training_logs";
  source_id: string;
  source_version: number;
  content_hash: string;
  target_space: string;
  target_dimension: number;
  job_type: "embedding" | "entity_enrichment";
  status: "pending" | "processing" | "ready" | "failed" | "superseded";
  attempts: number;
  max_attempts: number;
}

export interface BatchOptions {
  cap?: number;
  deadlineMs?: number;
  cursor?: string | null;
  targetSpace?: string;
  domain?: "memories" | "briefs" | "health_entries" | "training_logs" | "all";
  authContext?: AuthContext | null;
}

export interface DomainCoverage {
  total: number;
  ready: number;
  pending: number;
  failed: number;
}

export interface ReconcileResult {
  processed: number;
  succeeded: number;
  failed: number;
  skippedCas: number;
  durationMs: number;
  timedOut: boolean;
  nextCursor: string | null;
  coverage: Record<string, DomainCoverage>;
}

export interface BackfillOptions {
  space: string;
  budget: number;
  domain?: "memories" | "briefs" | "health_entries" | "training_logs" | "all";
  authContext?: AuthContext | null;
}

export interface BackfillResult {
  status: string;
  target_space: string;
  budget_requested: number;
  total_queued: number;
  counts_by_table: Record<string, number>;
}

export interface LifecycleStatus {
  outbox: {
    total: number;
    pending: number;
    processing: number;
    ready: number;
    failed: number;
    oldest_pending_at: string | null;
  };
  tables: Record<string, {
    total: number;
    ready: number;
    pending: number;
    failed: number;
    enrichment_pending?: number;
  }>;
}

/**
 * Generate a deterministic synthetic embedding of length 1536 from input text.
 * Used for deterministic smoke testing and local pipelines without paid API calls.
 */
export function generateSyntheticEmbedding(text: string, dimension: number = 1536): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  const vec = new Array(dimension);
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    const val = Math.sin(hash + i * 0.1);
    vec[i] = val;
    norm += val * val;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dimension; i++) {
    vec[i] = Number((vec[i] / norm).toFixed(6));
  }
  return vec;
}

export interface IndexingWorkerConfig {
  provider?: OpenRouterProvider;
  useSynthetic?: boolean;
  nowFn?: () => number;
}

export class IndexingWorker {
  private readonly provider: OpenRouterProvider;
  private readonly useSynthetic: boolean;
  private readonly nowFn: () => number;

  constructor(config?: IndexingWorkerConfig) {
    this.provider = config?.provider || new OpenRouterProvider();
    this.useSynthetic = config?.useSynthetic ?? false;
    this.nowFn = config?.nowFn || (() => performance.now());
  }

  /**
   * Claims a bounded batch of pending jobs from indexing_outbox using FOR UPDATE SKIP LOCKED.
   */
  async claimBatch(options: BatchOptions): Promise<IndexingJob[]> {
    const cap = Math.min(Math.max(options.cap ?? 20, 1), 100);
    const space = options.targetSpace || DEFAULT_EMBEDDING_SPACE;
    const ownerId = options.authContext?.userId || OWNER_USER_ID || null;

    const { data, error } = await supabase.rpc("claim_indexing_jobs", {
      p_limit: cap,
      p_target_space: space,
      p_owner_id: ownerId,
      p_lock_seconds: 60,
    });

    if (error) {
      throw new Error(`Failed to claim indexing jobs: ${error.message}`);
    }

    return (data as IndexingJob[]) || [];
  }

  /**
   * Loads canonical text representation for a source row.
   */
  async getCanonicalText(
    table: IndexingJob["source_table"],
    id: string,
  ): Promise<{ text: string; version: number; content_hash: string } | null> {
    if (table === "memories") {
      const { data } = await supabase
        .from("memories")
        .select("content, embedding_version, content_hash")
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      return {
        text: data.content,
        version: data.embedding_version,
        content_hash: data.content_hash,
      };
    } else if (table === "briefs") {
      const { data } = await supabase
        .from("briefs")
        .select("title, body_markdown, embedding_version, content_hash")
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      return {
        text: briefToText({ title: data.title, body_markdown: data.body_markdown }),
        version: data.embedding_version,
        content_hash: data.content_hash,
      };
    } else if (table === "health_entries") {
      const { data } = await supabase
        .from("health_entries")
        .select("entry_type, timestamp, numeric_value, value, embedding_version, content_hash")
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      return {
        text: recordToText(data.entry_type, {
          entry_type: data.entry_type,
          timestamp: data.timestamp,
          numeric_value: data.numeric_value,
          value: data.value,
        }),
        version: data.embedding_version,
        content_hash: data.content_hash,
      };
    } else if (table === "training_logs") {
      const { data } = await supabase
        .from("training_logs")
        .select("workout_date, workout_type, name, exercises, notes, volume_kg, embedding_version, content_hash")
        .eq("id", id)
        .maybeSingle();
      if (!data) return null;
      return {
        text: workoutToText({
          workout_date: data.workout_date,
          workout_type: data.workout_type,
          name: data.name,
          exercises: data.exercises,
          notes: data.notes,
          volume_kg: data.volume_kg,
        }),
        version: data.embedding_version,
        content_hash: data.content_hash,
      };
    }
    return null;
  }

  /**
   * Process a single job with Compare-And-Swap (CAS) to prevent stale overwrites.
   */
  async processJob(job: IndexingJob): Promise<"ready" | "superseded" | "failed"> {
    try {
      preflightSpaceCheck(job.target_space);

      if (job.job_type === "embedding") {
        const canonical = await this.getCanonicalText(job.source_table, job.source_id);
        if (!canonical) {
          await supabase.rpc("complete_indexing_job", {
            p_job_id: job.id,
            p_status: "failed",
            p_error: `Source row not found in ${job.source_table}`,
            p_error_class: "not_found",
          });
          return "failed";
        }

        // CAS check before computation: has the row version advanced?
        if (
          canonical.version !== job.source_version ||
          canonical.content_hash !== job.content_hash
        ) {
          await supabase.rpc("complete_indexing_job", {
            p_job_id: job.id,
            p_status: "superseded",
            p_error: "Row content or version advanced before embedding started",
            p_error_class: "cas_superseded",
          });
          return "superseded";
        }

        // Compute embedding
        let embedding: number[];
        if (this.useSynthetic) {
          embedding = generateSyntheticEmbedding(canonical.text, job.target_dimension);
        } else {
          embedding = await this.provider.getEmbedding(canonical.text);
        }

        // Preflight dimension check BEFORE attempting any database write
        preflightDimensionCheck(embedding.length, job.target_dimension);

        // Atomic CAS update: only update if version and content_hash still match!
        const { data: updatedRows, error: updateError } = await supabase
          .from(job.source_table)
          .update({
            // @ts-ignore dynamic table update
            embedding,
            embedding_status: "ready",
            embedding_space: job.target_space,
            embedded_at: new Date().toISOString(),
          })
          .eq("id", job.source_id)
          .eq("embedding_version", job.source_version)
          .eq("content_hash", job.content_hash)
          .select("id");

        if (updateError) {
          throw updateError;
        }

        if (!updatedRows || updatedRows.length === 0) {
          // CAS conflict: row was modified by a newer write during embedding!
          await supabase.rpc("complete_indexing_job", {
            p_job_id: job.id,
            p_status: "superseded",
            p_error: "CAS conflict: row was modified concurrently",
            p_error_class: "cas_conflict",
          });
          return "superseded";
        }

        // Mark outbox job ready
        await supabase.rpc("complete_indexing_job", {
          p_job_id: job.id,
          p_status: "ready",
        });
        return "ready";
      } else if (job.job_type === "entity_enrichment" && job.source_table === "memories") {
        // Entity enrichment for memories
        const { data: mem } = await supabase
          .from("memories")
          .select("id, content, embedding_version")
          .eq("id", job.source_id)
          .maybeSingle();

        if (!mem || mem.embedding_version !== job.source_version) {
          await supabase.rpc("complete_indexing_job", {
            p_job_id: job.id,
            p_status: "superseded",
            p_error: "Memory version advanced before entity enrichment",
            p_error_class: "cas_superseded",
          });
          return "superseded";
        }

        let classification: ClassificationResult;
        if (this.useSynthetic) {
          classification = {
            category: "note",
            tags: ["synthetic"],
            people: [],
            importance: 5,
            title: null,
            dates_mentioned: [],
            entities: [],
            status: "model",
            source: "model",
            error_class: null,
          };
        } else {
          classification = await this.provider.classifyMemory(mem.content);
        }

        if (classification.entities && classification.entities.length > 0) {
          await processEntities(mem.id, classification.entities);
        }

        await supabase
          .from("memories")
          .update({
            enrichment_status: "ready",
            enriched_at: new Date().toISOString(),
          })
          .eq("id", mem.id)
          .eq("embedding_version", job.source_version);

        await supabase.rpc("complete_indexing_job", {
          p_job_id: job.id,
          p_status: "ready",
        });
        return "ready";
      }

      return "failed";
    } catch (err: unknown) {
      let errorClass: ErrorClass | string = "transport_error";
      if (err instanceof DimensionMismatchError) {
        errorClass = "invalid_dimension";
      } else if (err instanceof InvalidSpaceError) {
        errorClass = "invalid_space";
      } else if (err instanceof ProviderError) {
        errorClass = err.errorClass;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);

      await supabase.rpc("complete_indexing_job", {
        p_job_id: job.id,
        p_status: "failed",
        p_error: errorMsg,
        p_error_class: errorClass,
      });

      return "failed";
    }
  }

  /**
   * Reconciles a bounded batch of indexing jobs within a strict cap and deadline.
   */
  async reconcileBatch(options: BatchOptions = {}): Promise<ReconcileResult> {
    const startTime = this.nowFn();
    const deadlineMs = options.deadlineMs ?? 10000;
    const jobs = await this.claimBatch(options);

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skippedCas = 0;
    let timedOut = false;
    let nextCursor: string | null = null;

    for (let i = 0; i < jobs.length; i++) {
      const elapsed = this.nowFn() - startTime;
      if (elapsed >= deadlineMs) {
        timedOut = true;
        nextCursor = jobs[i].id;
        break;
      }

      const job = jobs[i];
      if (options.domain && options.domain !== "all" && job.source_table !== options.domain) {
        continue;
      }

      const outcome = await this.processJob(job);
      processed++;
      if (outcome === "ready") succeeded++;
      else if (outcome === "superseded") skippedCas++;
      else if (outcome === "failed") failed++;

      nextCursor = job.id;
    }

    const durationMs = Math.round(this.nowFn() - startTime);
    const lifecycleStatus = await this.getLifecycleStatus(options.authContext);

    return {
      processed,
      succeeded,
      failed,
      skippedCas,
      durationMs,
      timedOut,
      nextCursor: timedOut ? nextCursor : null,
      coverage: lifecycleStatus.tables,
    };
  }

  /**
   * Legacy backfill with strict requirement of explicit space and budget.
   */
  async backfillLegacy(options: BackfillOptions): Promise<BackfillResult> {
    if (!options.space || typeof options.space !== "string" || options.space.trim() === "") {
      throw new InvalidSpaceError();
    }
    if (!options.budget || typeof options.budget !== "number" || options.budget <= 0) {
      throw new InvalidBudgetError();
    }
    preflightSpaceCheck(options.space);

    const ownerId = options.authContext?.userId || OWNER_USER_ID || null;
    const domain = options.domain && options.domain !== "all" ? options.domain : null;

    const { data, error } = await supabase.rpc("backfill_indexing_jobs", {
      p_space: options.space,
      p_budget_limit: Math.min(options.budget, 1000),
      p_source_table: domain,
      p_owner_id: ownerId,
    });

    if (error) {
      throw new Error(`Backfill failed: ${error.message}`);
    }

    return data as BackfillResult;
  }

  /**
   * Fetches the current observable status across outbox and the four tables.
   */
  async getLifecycleStatus(authContext?: AuthContext | null): Promise<LifecycleStatus> {
    const ownerId = authContext?.userId || OWNER_USER_ID || null;
    const { data, error } = await supabase.rpc("get_indexing_lifecycle_status", {
      p_owner_id: ownerId,
    });

    if (error) {
      throw new Error(`Failed to retrieve lifecycle status: ${error.message}`);
    }

    return data as LifecycleStatus;
  }
}
