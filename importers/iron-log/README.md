# Iron-Log Importer

Imports workout data from Iron Log into Alexandria.

Supports two input formats:
- **JSON export** (recommended) — produced by Iron Log's `AlexandriaExportService`
- **SQLite database** (legacy) — direct `ironlog.db` file

## How Iron Log Stores Data

Iron Log uses expo-sqlite (SQLite) with Drizzle ORM. The DB file is `ironlog.db`.

Key tables:
- `sessions` -- workout sessions (routine name, start/end time, body weight, RPE, notes)
- `sets` -- individual sets (exercise name, weight, reps, duration, RIR, warmup flag)
- `exercises` -- exercise library (name, type: strength|duration)
- `routines` -- workout templates
- `body_metrics` -- weight, waist, arm, thigh, chest, calf measurements + photos
- `personal_records` -- PRs (weight, reps, volume, duration)

## JSON Export (Recommended)

Iron Log can export a structured JSON file via `AlexandriaExportService`:

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
      "exercises": [...],
      "duration_s": 3600,
      "volume_kg": 2400,
      "rpe": 8,
      "notes": "Bom treino",
      "tags": ["iron-log", "strength"],
      "metadata": {...}
    }
  ],
  "body_metrics": [
    {
      "external_id": "metric-1700000000000",
      "entry_type": "weight",
      "timestamp": "2023-11-14T22:13:20+00:00",
      "numeric_value": 80.5,
      "value": {"weight_kg": 80.5},
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

### Usage (JSON)

```bash
# Set your Alexandria credentials
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...
export MCP_ACCESS_KEY=your-key

# Run the import
python3 import_ironlog.py ironlog-export.json
```

The JSON import:
- Creates one `training_logs` entry per session
- Creates `health_entries` for body metrics (weight, measurements)
- Creates `health_entries` for personal records (`entry_type: personal_record`)
- Creates `health_entries` for measurement goals (`entry_type: measurement_goal`)
- Tags everything with `source: iron-log`
- Upserts by `external_id` — safe to re-run

## SQLite Export (Legacy)

For older versions of Iron Log that do not support JSON export.

### How to Export from Phone

1. Open Iron Log -> Settings -> Backup
2. Export the database (saves to Downloads or Google Drive)
3. Transfer the `ironlog.db` file to this directory

### Usage (SQLite)

```bash
python3 import_ironlog.py ironlog.db
```

The SQLite import:
- Creates one `training_logs` entry per session with all sets as JSON
- Creates `health_entries` for body metrics (weight, measurements)
- Tags everything with `source: iron-log`
- Skips duplicates (checks by external_id)
- Filters out soft-deleted records (`deleted_at IS NULL`)

