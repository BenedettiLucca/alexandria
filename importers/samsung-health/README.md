# Samsung Health Importer (via Google Health Connect)

Imports health data from Samsung Health into Alexandria.

## How It Works

Samsung Health syncs data to Google Health Connect on Android.
From there, data can be exported or accessed via the Health Connect API.

## Option A: Export from Samsung Health App

1. Open Samsung Health -> Settings -> Download personal data
2. Wait for the email with download link
3. Download and extract the ZIP
4. The data includes JSON/CSV files for: steps, sleep, exercise, heart rate, etc.

## Option B: Google Health Connect Export

1. Open Android Settings -> Apps -> Health Connect
2. Tap "Export data" 
3. Exported data lands in your Downloads folder as JSON

## Usage

```bash
# Point to your extracted Samsung Health export directory
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...

python3 import_samsung_health.py /path/to/samsung-health-export/
```

## Supported Data Types

- Steps (daily totals)
- Sleep sessions (start, end, duration)
- Exercise sessions (type, duration, calories, distance)
- Heart rate samples
- Weight entries
- Water intake
- Nutrition

## For Automated Sync (Future)

To automate this, you'd build an Android app (or Tasker automation) that:
1. Reads from Health Connect API
2. POSTs to your Alexandria Edge Function
3. Runs on a schedule (daily)

The Health Connect API provides:
- `HealthConnectClient.readRecords()`
- Data types: Steps, Sleep, Exercise, HeartRate, Weight, etc.
