# Google Health Connect Importer

Imports health data from Google Health Connect into Alexandria.

## How It Works

Samsung Health syncs to Google Health Connect on your phone. Health Connect
can export a backup as a ZIP file containing an SQLite database.

The database contains tables for all health record types that apps have
written to Health Connect -- steps, sleep, exercise, heart rate, weight,
blood pressure, nutrition, and more.

## How to Export

1. Open Android **Settings** -> **Health Connect** -> **Manage data**
2. Enable **Scheduled export** (daily, weekly, or monthly)
3. Pick a cloud storage provider (Google Drive, etc.)
4. Wait for the first export to complete
5. Download the ZIP file to your computer

Note: The first export may be empty (known bug). Subsequent exports work.

## What's Inside the ZIP

The ZIP contains an SQLite database. Tables use Health Connect's internal
schema with record types like:
- StepsRecord (daily step counts)
- SleepSessionRecord (sleep periods)
- ExerciseSessionRecord (workouts)
- HeartRateRecord (BPM samples)
- WeightRecord (body weight)
- BloodPressureRecord (systolic/diastolic)
- NutritionRecord (food/water intake)
- And 40+ more record types

## Usage

```bash
# Unzip the export first
unzip Health\ Connect.zip -d health-connect-export/

# Set your Alexandria credentials
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Run the import
python3 import_health_connect.py health-connect-export/
```

## Supported Record Types

| Health Connect Record | Alexandria entry_type |
|---|---|
| StepsRecord | steps |
| SleepSessionRecord | sleep |
| ExerciseSessionRecord | exercise |
| HeartRateRecord | heart_rate |
| WeightRecord | weight |
| BloodPressureRecord | blood_pressure |
| NutritionRecord (water) | water |
| NutritionRecord (food) | nutrition |
| BodyFatRecord | stress (body composition) |

## For Automated Sync (Future)

To automate without manual exports, you'd build a small Android app that:
1. Requests Health Connect permissions (READ_STEPS, READ_SLEEP, etc.)
2. Uses `healthConnectClient.readRecords()` to pull new data
3. POSTs to the Alexandria MCP Edge Function
4. Runs on a schedule via WorkManager

Or use Tasker/Automate with the Health Connect plugin.

Health Connect API record types (Jetpack SDK):
- `StepsRecord` -- count, startTime, endTime
- `SleepSessionRecord` -- startTime, endTime, stages
- `ExerciseSessionRecord` -- exerciseType, startTime, endTime, segments
- `HeartRateRecord` -- samples[{time, beatsPerMinute}]
- `WeightRecord` -- weight (in kg)
- `BloodPressureRecord` -- systolic, diastolic
- `NutritionRecord` -- nutrients, energy, water
