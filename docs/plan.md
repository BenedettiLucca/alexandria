# Alexandria Improvement Plan

Architecture review conducted April 2026. Benchmarked against ~15 comparable
systems (Mem0, Graphiti/Zep, Terra, Vital, Fulcra Context MCP, Open Wearables,
supabase-mcp-template, ContextOS, Limitless, Reor, and others).

---

## Summary

The core architecture is sound: Supabase Edge Function + MCP + pgvector is the
right stack. The main gaps are data-modeling details (temporal tracking, typed
values) and missing operational features (CRUD tools, sync state).

---

## Phase 1 — Critical ✅ DONE

### 1.1 Bi-temporal timestamps ✅

**Problem:** `health_entries.timestamp` was ambiguous — event time and ingestion
time were conflated.

**Solution:** `event_time` was added then consolidated into the `timestamp` column.
`created_at` already serves as ingestion time.

### 1.2 Typed numeric value on health entries ✅

**Problem:** Everything dumped into `value JSONB`. Couldn't efficiently query numeric ranges.

**Solution:** Added `numeric_value NUMERIC` column with index on
`(entry_type, numeric_value DESC)` for range queries.

### 1.3 Remove Samsung Health dead code ✅

**Solution:** Deleted `import_samsung_health.py`, removed `'samsung-health'` from
source enum.

> **Note:** The plan originally referenced `event_time` and `ingestion_source` columns.
> These were removed during the schema audit — the `timestamp` column serves the
> event time role and `created_at` serves as ingestion time. The `source` column
> replaces `ingestion_source`.

---

## Phase 2 — Important ✅ DONE

### 2.1 Fix body_metrics mislabel ✅

**Solution:** Added `'body_composition'` to `entry_type` CHECK constraint.
Iron Log importer now uses `body_composition` for measurements.

### 2.2 Validate LLM classification output ✅

**Solution:** Added `sanitizeClassification()` in `lib.ts` that validates category
against allowed list and falls back to `'note'` for invalid categories.

### 2.3 Add CRUD tools ✅

**Solution:** Added `update_memory`, `delete_memory`, `delete_health_entry`,
`update_workout` tools.

### 2.4 Sync state tracking ✅

**Solution:** Added `sync_log` table with source, type, record counts, status,
timestamps, and error tracking. Importers log sync results.

---

## Phase 3 — Medium Priority ✅ DONE

### 3.1 Unified import path (shared.py) ✅

**Solution:** Extracted shared logic (dedup, validation, config loading) into
`importers/shared.py`.

### 3.2 Cheaper embeddings (keyword classify) ✅

**Solution:** Added `simpleClassify()` for short memories (<200 chars). LLM
classification is only used for longer content.

### 3.3 External ID for upsert ✅

**Solution:** Added `external_id TEXT` column to `health_entries` and
`training_logs`. Importers use upsert-by-external-id.

> **Note:** The plan referenced an `ingestion_source` column. This was removed
> during the schema audit — the existing `source` column serves the same role.

---

## Phase 4 — Future ✅ DONE

### 4.1 Derived metrics ✅

**Solution:** Added `health_summaries` table and `compute_daily_summary()` RPC
that aggregates sleep, steps, heart rate, weight, exercise, and training data.

### 4.2 Knowledge graph ✅

**Solution:** Added `entities` and `entity_mentions` tables. LLM classification
extracts entities (people, concepts, technologies, etc.) from memories.

### 4.3 OAuth2 auth ✅

**Solution:** Implemented JWT Bearer auth via Supabase Auth. Supports per-user
scoping with profile isolation. Static API key auth retained as fallback.

### 4.4 Vector search on health/training data ✅

**Solution:** Added embeddings to `health_entries` and `training_logs`. Created
`search_health_entries()` and `search_training_logs()` RPC functions with
HNSW indexes.

---

## Post-Phase ✅ DONE

- Schema audit: consolidated all migrations into `schema/schema.sql`
- Lint/format: `deno lint` and `ruff check` pass clean
- Test suite: 121 tests (73 Python + 48 Deno)
