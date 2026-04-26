# Alexandria-side Changes for Iron Log Integration v2

## Context

Iron Log is adding a native Alexandria JSON exporter (`AlexandriaExportService.ts`) that
outputs a structured JSON file. The Python importer needs to support this new format
alongside the existing SQLite-based import.

The JSON export includes data that the current SQLite importer does not handle:
- Soft-delete filtering (only active records)
- Personal records (PRs)
- Measurement goals
- Richer routine context per session

---

## Step 1 — Accept JSON input in `import_ironlog.py`

**File:** `importers/iron-log/import_ironlog.py`

Add a new entry point that accepts a `.json` file instead of `.db`:

```python
def import_from_json(json_path, supabase):
    with open(json_path) as f:
        data = json.load(f)

    # Import sessions (already deduped + filtered on Iron Log side)
    for session in data.get("sessions", []):
        upsert_record(supabase, "training_logs", session, "iron-log", session["external_id"])

    # Import body metrics
    for metric in data.get("body_metrics", []):
        upsert_record(supabase, "health_entries", metric, "iron-log", metric["external_id"])

    # Import personal records
    for pr in data.get("personal_records", []):
        upsert_record(supabase, "health_entries", pr, "iron-log", pr["external_id"])

    # Import measurement goals
    for goal in data.get("measurement_goals", []):
        upsert_record(supabase, "health_entries", goal, "iron-log", goal["external_id"])
```

Update `main()` to detect file type by extension:

```python
if db_path.endswith('.json'):
    import_from_json(db_path, supabase)
else:
    # existing SQLite import (legacy)
    import_sessions(db_path, supabase)
    import_body_metrics(db_path, supabase)
```

## Step 2 — Update `shared.py` dedup logic

**File:** `importers/shared.py`

No changes needed — `upsert_record` already handles external_id-based upsert.
The JSON records come with pre-set `external_id` and `source` fields.

## Step 3 — Add personal_records import

**File:** `importers/iron-log/import_ironlog.py`

New function to map Iron Log PRs to Alexandria `health_entries`:

```python
def import_personal_records(prs, supabase):
    for pr in prs:
        record = {
            "entry_type": "exercise",  # or a new type
            "timestamp": pr["date"],
            "numeric_value": pr["value"],
            "value": {
                "exercise_name": pr["exercise_name"],
                "record_type": pr["record_type"],  # weight, reps, volume
                "weight_kg": pr.get("weight_kg"),
                "reps": pr.get("reps"),
                "estimated_1rm": pr.get("estimated_1rm"),
            },
            "source": "iron-log",
            "external_id": pr["external_id"],
            "tags": ["iron-log", "personal-record", pr["record_type"]],
        }
        upsert_record(supabase, "health_entries", record, "iron-log", pr["external_id"])
```

## Step 4 — Add measurement_goals import

**File:** `importers/iron-log/import_ironlog.py`

Map goals to Alexandria `health_entries`:

```python
def import_measurement_goals(goals, supabase):
    for goal in goals:
        record = {
            "entry_type": "body_composition",
            "timestamp": goal["target_date"],
            "numeric_value": goal["target_value"],
            "value": {
                "goal_type": goal["type"],
                "target_value": goal["target_value"],
                "start_date": goal["start_date"],
                "target_date": goal["target_date"],
                "achieved": goal["achieved"],
            },
            "source": "iron-log",
            "external_id": goal["external_id"],
            "tags": ["iron-log", "measurement-goal"],
        }
        upsert_record(supabase, "health_entries", record, "iron-log", goal["external_id"])
```

## Step 5 — Fix SQLite importer: filter soft-deleted records

**File:** `importers/iron-log/import_ironlog.py`

Add `WHERE deleted_at IS NULL` to existing SQLite queries (legacy path):

```sql
-- sessions query
SELECT s.*, r.name as routine_name
FROM sessions s
LEFT JOIN routines r ON s.routine_id = r.id
WHERE s.deleted_at IS NULL
ORDER BY s.start_time

-- sets query
SELECT * FROM sets
WHERE session_id = ? AND deleted_at IS NULL
ORDER BY exercise_name, set_number
```

## Step 6 — Update tests

**File:** `importers/test_import_ironlog.py`

Add test class `TestImportFromJson`:
- Test valid JSON import with sessions, metrics, PRs, goals
- Test dedup on re-import
- Test empty JSON
- Test malformed JSON

Add test class `TestSoftDeleteFiltering`:
- Insert session with `deleted_at` set → assert skipped
- Insert set with `deleted_at` set → assert excluded from volume

## Step 7 — Update schema.sql (optional)

If we want PRs and goals as first-class entities, consider:

- Add `'personal_record'` to `health_entries.entry_type` CHECK constraint
- Add `'measurement_goal'` to `health_entries.entry_type` CHECK constraint

Or keep them as `exercise` and `body_composition` with tags for filtering.

## Step 8 — Update README

**File:** `importers/iron-log/README.md`

- Document JSON import mode
- Show example JSON structure
- Mark SQLite mode as legacy

---

## JSON Export Format Reference

The Iron Log `AlexandriaExportService` will produce this structure:

```json
{
  "export_version": 1,
  "exported_at": "2026-04-26T15:30:00Z",
  "sessions": [
    {
      "external_id": "session-42",
      "workout_date": "2026-04-25",
      "workout_type": "strength",
      "name": "Upper A",
      "exercises": [
        {
          "name": "Supino Reto (Barra)",
          "sets": [
            { "set_number": 1, "weight_kg": 80, "reps": 8, "rir": 1, "is_warmup": false }
          ]
        }
      ],
      "duration_s": 3600,
      "volume_kg": 2400,
      "rpe": 8,
      "notes": "Bom treino",
      "tags": ["iron-log", "strength"],
      "metadata": {
        "routine_id": 1,
        "routine_name": "Upper A",
        "body_weight": 80.5,
        "set_count": 18
      }
    }
  ],
  "body_metrics": [
    {
      "external_id": "metric-1700000000000",
      "entry_type": "weight",
      "timestamp": "2023-11-14T22:13:20+00:00",
      "numeric_value": 80.5,
      "value": { "weight_kg": 80.5 },
      "source": "iron-log",
      "tags": ["iron-log"]
    }
  ],
  "personal_records": [
    {
      "external_id": "pr-weight-1",
      "exercise_name": "Supino Reto (Barra)",
      "record_type": "weight",
      "value": 100,
      "weight_kg": 100,
      "reps": 1,
      "estimated_1rm": 100,
      "date": "2026-04-20T10:00:00+00:00"
    }
  ],
  "measurement_goals": [
    {
      "external_id": "goal-waist-1",
      "type": "waist",
      "target_value": 80.0,
      "start_date": "2026-01-01T00:00:00+00:00",
      "target_date": "2026-06-30T00:00:00+00:00",
      "achieved": false
    }
  ]
}
```

---

## Priority Order

1. **Step 1** (JSON import) — unblocks the new Iron Log exporter
2. **Step 5** (soft-delete filter) — data quality fix, quick win
3. **Step 3** (PRs) — high-value data
4. **Step 4** (goals) — nice to have
5. **Step 6** (tests) — always
6. **Steps 7-8** (schema + docs) — cleanup
