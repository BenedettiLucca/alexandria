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

## Phase 1 — Critical (Now)

### 1.1 Bi-temporal timestamps

**Problem:** `health_entries.timestamp` is ambiguous — event time and ingestion
time are conflated. Can't distinguish "when did this happen" from "when was this
recorded/imported". Every serious health platform (Graphiti, Terra, Vital) uses
a bi-temporal model.

**Changes:**
- Add `event_time TIMESTAMPTZ` to `health_entries` (when the event happened)
- Add `event_time TIMESTAMPTZ` to `training_logs` (when the workout happened)
- Add index on `(event_time DESC)` for queries
- Rename existing `timestamp` → keep as-is but clarify in docs that it's the
  event time; `created_at` already serves as ingestion time
- Update importers to populate `event_time` from source data

**Files:** `schema/003_improvements.sql`, importers

### 1.2 Typed numeric value on health entries

**Problem:** Everything dumps into `value JSONB`. Can't efficiently query
"show me heart rates above 100" or "average weight last 30 days" without JSON
parsing.

**Changes:**
- Add `numeric_value NUMERIC` to `health_entries`
- steps: count, heart_rate: bpm, weight: kg, sleep: duration_hours, etc.
- Add index on `(entry_type, numeric_value DESC)` for range queries
- Update importers and MCP tools to populate this field

**Files:** `schema/003_improvements.sql`, `server/index.ts`, importers

### 1.3 Remove Samsung Health dead code

**Problem:** Lucca uses Google Health Connect, not Samsung Health directly.
`import_samsung_health.py` (12KB) is dead code. The `source` enum still
includes `'samsung-health'`.

**Changes:**
- Delete `importers/health-connect/import_samsung_health.py`
- Clean `source` CHECK to remove `'samsung-health'`
- Update any references in docs/README

**Files:** delete file, `schema/001_core.sql`, `README.md`

---

## Phase 2 — Important (Soon)

### 2.1 Fix body_metrics mislabel

**Problem:** Iron Log body measurements (waist, arm, thigh) are imported as
`entry_type: 'nutrition'` — the closest match. This pollutes nutrition queries.

**Changes:**
- Add `'body_composition'` to `entry_type` CHECK constraint
- Update `import_ironlog.py` to use `body_composition` for measurements

**Files:** `schema/003_improvements.sql`, `importers/iron-log/import_ironlog.py`

### 2.2 Validate LLM classification output

**Problem:** `classifyMemory()` calls GPT-4o-mini and blindly uses the result.
If it returns an invalid category (not in the CHECK constraint), the DB insert
fails with a cryptic error.

**Changes:**
- Add validation function that checks category against allowed list
- Fall back to `'note'` for invalid categories
- Add `INGESTION_STATUS` enum: `pending`, `classified`, `embedded`, `complete`
- Make classification failure non-fatal

**Files:** `server/index.ts`

### 2.3 Add CRUD tools

**Problem:** MCP server only supports create + read. No way to delete a memory,
update health data, or correct a workout.

**Changes:**
- Add `update_memory` tool (edit content, category, tags, importance)
- Add `delete_memory` tool (with confirmation pattern)
- Add `delete_health_entry` tool
- Add `update_workout` tool

**Files:** `server/index.ts`

### 2.4 Sync state tracking

**Problem:** No record of when the last sync was, what was processed, or what
failed. Each sync re-checks everything.

**Changes:**
- Add `sync_log` table (source, type, records_processed/imported/skipped,
  started_at, completed_at, status, error_message)
- Update importers to log sync results
- Enable incremental sync (only fetch data since last successful sync)

**Files:** `schema/003_improvements.sql`, importers

---

## Phase 3 — Medium Priority

### 3.1 Unified import path

**Problem:** Importers write directly to Supabase, bypassing the MCP server.
This means no embeddings, no classification, no validation consistency.

**Changes:**
- Extract shared logic (dedup, validation, embedding) into a shared module
- Have importers use the MCP server's HTTP endpoint OR share the same code

### 3.2 Cheaper embeddings

**Problem:** Every `capture_memory` makes 2 API calls to OpenRouter (embedding +
classification). At scale this is slow and expensive.

**Changes:**
- Use Supabase `pgai` extension for in-DB embeddings (free)
- Make classification optional / keyword-based for simple memories
- Batch embed on import

### 3.3 External ID for upsert

**Problem:** Dedup uses content fingerprints. If source data changes (edited
sleep entry), a new record is created instead of updating the existing one.

**Changes:**
- Add `external_id TEXT` column (the original record ID from source system)
- Add `ingestion_source TEXT` column
- Update importers to use upsert-by-external-id

---

## Phase 4 — Future

### 4.1 Derived metrics / trend analysis

Compute daily/weekly aggregations: rolling average weight, training volume
trends, sleep consistency score, HR recovery trends. Materialized view or
Supabase cron.

### 4.2 Knowledge graph / entity extraction

Add `entities` and `entity_mentions` tables. Extend classification to extract
people, concepts, projects, locations. Link memories by shared entities.

### 4.3 OAuth2 auth model

Replace static `MCP_ACCESS_KEY` with Supabase Auth + per-user JWT. Per-client
scoping (read-only Claude, read-write Hermes). OAuth2 proxy pattern.

### 4.4 Vector search on health/training data

Embed health and training records for semantic search ("hardest workouts",
"when was I sleeping poorly").

---

## Implementation Order

| # | Item | Status | Commit |
|---|------|--------|--------|
| 1.1 | Bi-temporal timestamps | ✅ | 7b9049b |
| 1.2 | Typed numeric_value | ✅ | 7b9049b |
| 1.3 | Remove Samsung Health dead code | ✅ | 7b9049b |
| 2.1 | Fix body_metrics mislabel | ✅ | 7b9049b |
| 2.2 | Validate LLM classification | ✅ | 7b9049b |
| 2.3 | Add CRUD tools | ✅ | 7b9049b |
| 2.4 | Sync state tracking | ✅ | 7b9049b |
| 3.1 | Unified import path (shared.py) | ✅ | 0dc6788 |
| 3.2 | Cheaper embeddings (keyword classify) | ✅ | 0dc6788 |
| 3.3 | External ID for upsert | ✅ | 0dc6788 |
| 4.1 | Derived metrics | ✅ | f9d5d93 |
| 4.2 | Knowledge graph | ✅ | f9d5d93 |
| 4.3 | OAuth2 auth | ✅ | f9d5d93 |
| 4.4 | Vector search on health data | ✅ | f9d5d93 |
