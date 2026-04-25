# Iron-Log Importer

Imports workout data from Iron Log's local SQLite database into Alexandria.

## How Iron Log Stores Data

Iron Log uses expo-sqlite (SQLite) with Drizzle ORM. The DB file is `ironlog.db`.

Key tables:
- `sessions` -- workout sessions (routine name, start/end time, body weight, RPE, notes)
- `sets` -- individual sets (exercise name, weight, reps, duration, RIR, warmup flag)
- `exercises` -- exercise library (name, type: strength|duration)
- `routines` -- workout templates
- `body_metrics` -- weight, waist, arm, thigh, chest, calf measurements + photos
- `personal_records` -- PRs (weight, reps, volume, duration)

## How to Export from Phone

1. Open Iron Log -> Settings -> Backup
2. Export the database (saves to Downloads or Google Drive)
3. Transfer the `ironlog.db` file to this directory

## Usage

```bash
# Set your Alexandria credentials
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...
export MCP_ACCESS_KEY=your-key

# Run the import
python3 import_ironlog.py ironlog.db
```

The import:
- Creates one `training_logs` entry per session with all sets as JSON
- Creates `health_entries` for body metrics (weight, measurements)
- Tags everything with `source: iron-log`
- Skips duplicates (checks by date + workout name)
