# Indexing Lifecycle Runbook (T05B)

## Overview & Architecture

The indexing lifecycle in Alexandria guarantees that:
1. **Every write has observable state**: Every record in the 4 vector tables (`memories`, `briefs`, `health_entries`, `training_logs`) tracks `embedding_status` (`pending`, `processing`, `ready`, `failed`), `embedding_space`, `embedding_version`, and `embedded_at`.
2. **Incompatible embeddings are never searched together**: All 4 search RPCs (`search_memories`, `search_briefs`, `search_health_entries`, `search_training_logs`) strictly guard by `embedding_space = p_space` and `embedding_status = 'ready'`. Even models sharing the same dimension (e.g. ambos 2048) are strictly isolated.
3. **Importers and MCP tools produce outbox jobs atomically**: Database triggers (`trg_indexing_outbox_after`) automatically enqueue rows without embeddings into `indexing_outbox` with unique constraint `(source_table, source_id, job_type)`.
4. **Compare-And-Swap (CAS) concurrency**: Updates increment `embedding_version`. Late jobs attempting to write an old version are marked `superseded` and do NOT overwrite newer updates.
5. **Entity enrichment is independent**: `memories` has its own `job_type = 'entity_enrichment'` in `indexing_outbox` and `enrichment_status` on the table.
6. **Preflight dimension check**: Verifies dimension (2048) before writes and cold starts without requiring paid OpenRouter requests.

---

## Database Schema & State Transitions

### Lifecycle Columns on Vector Tables

| Column | Type | Default / Constraints | Description |
|---|---|---|---|
| `embedding_status` | `TEXT` | `'pending'` (`pending`, `processing`, `ready`, `failed`) | Lifecycle state |
| `embedding_space` | `TEXT` | `'qwen/qwen3-embedding-8b'` | Target vector model/space |
| `embedding_version` | `INT` | `1` | Incremented on every content update |
| `embedded_at` | `TIMESTAMPTZ` | `NULL` | Timestamp of successful embedding |
| `content_hash` | `TEXT` | SHA256 of canonical fields | Used for CAS validation |
| `enrichment_status` | `TEXT` | `'pending'` (`memories` only) | Entity extraction state |

### Outbox Queue: `indexing_outbox`

- Indexed by `(status, scheduled_at, target_space)`, `(user_id, status)`, and `(source_table, source_id)`.
- RLS enforces owner isolation: only `service_role` or matching `auth.uid()` can read/write.
- Operational RPCs:
  - `claim_indexing_jobs(p_limit, p_target_space, p_owner_id, p_lock_seconds)`: Transactional batch reservation using `FOR UPDATE SKIP LOCKED`.
  - `complete_indexing_job(p_job_id, p_status, p_error, p_error_class, p_backoff_seconds)`: Handles success (`ready`), CAS conflict (`superseded`), and failure with exponential retry backoff.
  - `backfill_indexing_jobs(p_space, p_budget_limit, p_source_table, p_owner_id)`: Enqueues legacy rows requiring explicit target space and positive budget limit.
  - `get_indexing_lifecycle_status(p_owner_id)`: Aggregated counts per status across outbox and tables.

---

## Operational Runbook & CLI Commands

### 1. Inspect Lifecycle Status

Via PostgreSQL:
```sql
SELECT get_indexing_lifecycle_status();
```

Via PostgREST:
```bash
curl -X POST "http://localhost:54321/rest/v1/rpc/get_indexing_lifecycle_status" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "apikey: <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Via MCP Tool:
```json
{
  "name": "get_indexing_status",
  "arguments": {}
}
```

### 2. Run Local Bounded Reconciliation Batch

Via MCP Tool:
```json
{
  "name": "reconcile_indexing",
  "arguments": {
    "cap": 25,
    "deadline_ms": 8000,
    "target_space": "qwen/qwen3-embedding-8b",
    "domain": "all"
  }
}
```

Via Deno TypeScript API:
```ts
import { IndexingWorker } from "./lifecycle.ts";

const worker = new IndexingWorker();
const result = await worker.reconcileBatch({
  cap: 50,
  deadlineMs: 10000,
  targetSpace: "openai/text-embedding-3-small",
});
console.log("Reconciled:", result);
```

### 3. Trigger Legacy Backfill

Backfill requires **explicit target space** and a **strictly positive budget limit** to prevent runaway billing.

Via PostgreSQL:
```sql
SELECT backfill_indexing_jobs(
  p_space := 'openai/text-embedding-3-small',
  p_budget_limit := 100,
  p_source_table := 'health_entries'
);
```

Via MCP Tool:
```json
{
  "name": "trigger_indexing_backfill",
  "arguments": {
    "target_space": "qwen/qwen3-embedding-8b",
    "budget_limit": 50,
    "domain": "memories"
  }
}
```

---

## Recovery & Troubleshooting

### Stuck 'processing' Jobs
Jobs in `'processing'` status have a lease (`locked_until`). If a worker crashes or times out, `claim_indexing_jobs` automatically reclaims expired locks (`locked_until < now()`) on subsequent runs.

### Failed Jobs and Error Classes
When `attempts >= max_attempts`, the outbox job transitions to `'failed'` and sets `embedding_status = 'failed'` on the source table.
Common `error_class` values:
- `invalid_dimension`: Embedding vector length does not match expected 1536. Write was rejected before DB corruption.
- `invalid_space`: Model space string was empty or mismatched.
- `cas_conflict` / `cas_superseded`: Row was updated concurrently during computation; superseded without clobbering.
- `rate_limit`: Provider returned HTTP 429; scheduled with exponential backoff.
- `timeout`: Provider request exceeded attempt/total deadline.
