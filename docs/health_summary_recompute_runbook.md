# Health Summary Historical Recompute Runbook (T10)

## Overview & Background

The daily health aggregation engine (`compute_daily_summary`) and associated health tools (`health_summary`, `refresh_summary`, `log_health`, `query_health`) suffered from several core discrepancies:

1. **Steps Double Counting**: The previous SQL implementation summed `COALESCE(SUM(numeric_value), 0) + COALESCE(SUM((value->>'count')::BIGINT), 0)`. Because importers and MCP tools frequently populate both `numeric_value = N` and `value = {"count": N}`, step counts were duplicated (2x actual).
2. **Postgres Session Timezone Reliance**: The query filtered by `timestamp::date = target_date`. In PostgreSQL, casting a `TIMESTAMPTZ` to `DATE` relies on the active session's `TIMEZONE` setting (`current_setting('TIMEZONE')`). Different database connections or client session pools shifted records across civil days.
3. **Absence Converted to Zero**: Days with no recorded steps, sleep, heart rate, or exercise were written with `0` or `0.00` rather than `NULL`, corrupting rolling averages, streaks, and trend analysis.
4. **Exercise Types Using Tags Instead of Domain Types**: Exercise classification parsed generic tags (e.g. `["health-connect", "sync-v1"]`) rather than domain activity types (`name`, `exercise_type`, `activity_type`).
5. **Range Truncation via `limit(days)`**: In `health_summary`, providing a date range (`from`/`to`) was incorrectly clipped by `.limit(days)` (defaulting to 7).
6. **Unbounded Refresh**: `refresh_summary` lacked safety bounds and did not report degradation or errors per date honestly.

The updated migration `20260911050000_fix_health_core_and_daily_summary.sql` and tool refactor `supabase/functions/alexandria/tools/health.ts` resolve these issues. This runbook provides the operational procedure to recompute historical `health_summaries` safely **without executing against production during task implementation**.

---

## Architectural Guarantees & Invariants

| Dimension | Previous Defect | Guaranteed Invariant (T10) |
|---|---|---|
| **Steps Canonical Value** | `SUM(numeric_value) + SUM(value->>'count')` | `COALESCE(numeric_value, (value->>'count')::NUMERIC, (value->>'steps')::NUMERIC)` evaluated once per row |
| **Civil Day Bounds** | `timestamp::date = target_date` (session tz dependent) | UTC half-open interval `[day_start, day_end)` derived from user's IANA timezone (`v_tz`) |
| **Absence vs Zero** | Missing metrics set to `0` or `0.00` | Missing metrics set to `NULL`; zero is reserved strictly for recorded zero |
| **Exercise Types** | Generic tags array | Domain types extracted from `value->>'exercise_type'`, `value->>'type'`, `value->>'name'`, `value->>'activity_type'` |
| **Sleep Attribution** | Duplicated hours / wrong civil day | Canonical sleep duration (duration_s / numeric_value / duration_hours) attributed by sleep end time |
| **Owner Isolation** | Mixed caller context | `v_owner := COALESCE(auth.uid(), p_user_id)` enforced fail-closed |
| **Range Precedence** | Clipped by `limit(days)` | `from`/`to` takes precedence; cap separated with explicit truncation warnings |

---

## Preflight Audit & Dry-Run Verification

Before triggering any recomputation on existing databases, perform an audit dry-run to identify impacted summary dates.

### 1. Discrepancy Audit Query (Read-Only)

This query compares current stored `health_summaries` against what `compute_daily_summary` would compute, identifying dates with double-counted steps or zero-coerced missing metrics:

```sql
WITH recomputed AS (
    SELECT
        s.user_id,
        s.date,
        s.steps_total AS current_steps,
        (
            SELECT COALESCE(SUM(COALESCE(numeric_value, (value->>'count')::NUMERIC, (value->>'steps')::NUMERIC)), 0)::BIGINT
            FROM health_entries
            WHERE user_id = s.user_id
              AND entry_type = 'steps'
              AND timestamp >= (s.date::timestamp AT TIME ZONE 'UTC')
              AND timestamp < ((s.date + 1)::timestamp AT TIME ZONE 'UTC')
        ) AS canonical_steps,
        s.sleep_total_hours AS current_sleep,
        (
            SELECT SUM(
                COALESCE(
                    duration_s / 3600.0,
                    numeric_value,
                    (value->>'duration_hours')::NUMERIC,
                    (value->>'duration_h')::NUMERIC,
                    (value->>'duration_s')::NUMERIC / 3600.0
                )
            )::NUMERIC(4, 2)
            FROM health_entries
            WHERE user_id = s.user_id
              AND entry_type = 'sleep'
              AND COALESCE(NULLIF(value->>'end_time', '')::TIMESTAMPTZ, timestamp) >= (s.date::timestamp AT TIME ZONE 'UTC')
              AND COALESCE(NULLIF(value->>'end_time', '')::TIMESTAMPTZ, timestamp) < ((s.date + 1)::timestamp AT TIME ZONE 'UTC')
        ) AS canonical_sleep
    FROM health_summaries s
)
SELECT
    user_id,
    date,
    current_steps,
    canonical_steps,
    (current_steps - canonical_steps) AS step_inflation,
    current_sleep,
    canonical_sleep
FROM recomputed
WHERE current_steps IS DISTINCT FROM canonical_steps
   OR current_sleep IS DISTINCT FROM canonical_sleep
ORDER BY date DESC
LIMIT 50;
```

---

## Historical Recompute Procedures

### Method A: Bounded Batch Recompute via MCP Tool

The `refresh_summary` tool supports date ranges up to 365 days with per-date error tracking:

```json
{
  "name": "refresh_summary",
  "arguments": {
    "from": "2026-01-01",
    "to": "2026-06-30"
  }
}
```

The response provides honest status and failure reporting:
```
Refreshed 181 of 181 summary(s).
```
If errors occur on specific dates, they are detailed without halting progress:
```
Refreshed 179 of 181 summary(s).

Errors (2):
2026-02-15: Database lock timeout
2026-04-10: Invalid timestamp format
```

---

### Method B: Automated Python Batch Recompute Script (CLI / Admin)

For large backfills across multiple users or multi-year histories, execute this batch script during a low-traffic maintenance window.

```python
#!/usr/bin/env python3
"""
scripts/recompute_health_summaries.py
Safe, rate-limited, owner-scoped batch recomputation for historical health summaries.
"""

import argparse
import datetime
import sys
import time
from supabase import create_client

def recompute_user_range(supabase_url: str, service_role_key: str, user_id: str, start_date: str, end_date: str, delay_s: float = 0.05):
    client = create_client(supabase_url, service_role_key)
    
    start = datetime.date.fromisoformat(start_date)
    end = datetime.date.fromisoformat(end_date)
    total_days = (end - start).days + 1
    
    print(f"[*] Starting recompute for user {user_id} from {start_date} to {end_date} ({total_days} days)")
    
    success_count = 0
    error_count = 0
    current = start
    
    while current <= end:
        dt_str = current.isoformat()
        try:
            res = client.rpc("compute_daily_summary", {
                "target_date": dt_str,
                "p_user_id": user_id,
            }).execute()
            
            if res.data:
                steps = res.data.get("steps_total")
                sleep = res.data.get("sleep_hours")
                print(f"[{dt_str}] OK - Steps: {steps}, Sleep: {sleep}h")
                success_count += 1
            else:
                print(f"[{dt_str}] Warning: No data returned")
                error_count += 1
        except Exception as e:
            print(f"[{dt_str}] ERROR: {e}", file=sys.stderr)
            error_count += 1
            
        current += datetime.timedelta(days=1)
        if delay_s > 0:
            time.sleep(delay_s)
            
    print(f"\n[+] Recompute Complete: {success_count} succeeded, {error_count} failed out of {total_days} days.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recompute historical health summaries")
    parser.add_argument("--url", required=True, help="Supabase URL")
    parser.add_argument("--key", required=True, help="Supabase Service Role Key")
    parser.add_argument("--user-id", required=True, help="Target user UUID")
    parser.add_argument("--from-date", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--to-date", required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--delay", type=float, default=0.05, help="Throttle delay between RPCs in seconds")
    
    args = parser.parse_args()
    recompute_user_range(args.url, args.key, args.user_id, args.from_date, args.to_date, args.delay)
```

---

## Rollback & Disaster Recovery

Because `compute_daily_summary` performs atomic upserts on `health_summaries (user_id, date)`:

1. **Non-Destructive Overwrites**: Each call executes `ON CONFLICT (user_id, date) DO UPDATE`. It updates only derived values; raw `health_entries` and `training_logs` are never modified or deleted.
2. **Snapshot Prior to Bulk Execution**:
   Prior to running backfill on production, dump the existing table:
   ```bash
   pg_dump -h <host> -U postgres -d postgres -t health_summaries > /tmp/health_summaries_backup_$(date +%Y%m%d).sql
   ```
3. **Restore from Snapshot (if necessary)**:
   ```bash
   psql -h <host> -U postgres -d postgres -c "TRUNCATE health_summaries;"
   psql -h <host> -U postgres -d postgres < /tmp/health_summaries_backup_$(date +%Y%m%d).sql
   ```
4. **Idempotence**: Running `compute_daily_summary` multiple times for the same date produces the exact same deterministic summary row.
