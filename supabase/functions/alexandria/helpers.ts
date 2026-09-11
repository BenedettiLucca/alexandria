import { supabase } from "./config.ts";
import {
  sanitizeEntities,
  VALID_CATEGORIES,
  VALID_ENTITY_TYPES,
  type ValidatedEntity,
} from "./lib.ts";
import {
  type ClassificationResult,
  type ClassificationStatus,
  type ErrorClass,
  OpenRouterProvider,
  type ProviderConfig,
  ProviderAuthError,
  ProviderError,
  ProviderMalformedResponseError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderTransportError,
} from "./provider.ts";
import type { EntityType } from "./types.ts";

export {
  type ClassificationResult,
  type ClassificationStatus,
  type ErrorClass,
  OpenRouterProvider,
  type ProviderConfig,
  ProviderAuthError,
  ProviderError,
  ProviderMalformedResponseError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderTransportError,
};

export {
  CasConflictError,
  DEFAULT_EMBEDDING_SPACE,
  DimensionMismatchError,
  EMBEDDING_DIMENSION,
  generateSyntheticEmbedding,
  IndexingWorker,
  InvalidBudgetError,
  InvalidSpaceError,
  preflightDimensionCheck,
  preflightSpaceCheck,
  type BackfillOptions,
  type BackfillResult,
  type BatchOptions,
  type IndexingJob,
  type LifecycleStatus,
  type ReconcileResult,
} from "./lifecycle.ts";

const defaultProvider = new OpenRouterProvider();

export async function getEmbedding(
  text: string,
  provider: OpenRouterProvider = defaultProvider,
): Promise<number[]> {
  return await provider.getEmbedding(text);
}

export async function classifyMemory(
  text: string,
  provider: OpenRouterProvider = defaultProvider,
): Promise<ClassificationResult> {
  return await provider.classifyMemory(text);
}

export function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function wrapHandler<Args>(fn: (input: Args) => Promise<string>) {
  return async (input: Args) => {
    try {
      return ok(await fn(input));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const sanitized = msg
        .replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
        .replace(/https:\/\/[a-z0-9-]+\.supabase\.co[^\s]*/g, "[REDACTED_URL]")
        .replace(/sk-[A-Za-z0-9-]+/g, "[REDACTED_KEY]")
        .replace(/status: \d{3}\s/i, "")
        .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[REDACTED_IP]");
      return err(`Error: ${sanitized}`);
    }
  };
}

export function coerceEntityType(value: unknown): EntityType {
  return typeof value === "string" &&
      (VALID_ENTITY_TYPES as readonly string[]).includes(value)
    ? (value as EntityType)
    : "other";
}

export async function processEntities(
  memoryId: string,
  rawEntities: unknown[],
) {
  const validEntities = sanitizeEntities(rawEntities);

  for (const ent of validEntities) {
    const { data: existing, error: lookupErr } = await supabase
      .from("entities")
      .select("id")
      .eq("name", ent.name)
      .eq("entity_type", ent.type)
      .maybeSingle();

    if (lookupErr) continue;

    const entityId = existing?.id;

    if (entityId) {
      await supabase
        .from("entity_mentions")
        .upsert(
          { memory_id: memoryId, entity_id: entityId, context: ent.context },
          { onConflict: "memory_id,entity_id" },
        );
    } else {
      const { data: created, error: insErr } = await supabase
        .from("entities")
        .insert({ name: ent.name, entity_type: ent.type })
        .select("id")
        .single();

      if (insErr || !created) continue;

      await supabase
        .from("entity_mentions")
        .insert({
          memory_id: memoryId,
          entity_id: created.id,
          context: ent.context,
        });
    }
  }
}
