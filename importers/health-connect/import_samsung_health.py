#!/usr/bin/env python3
"""
Samsung Health Export -> Alexandria Importer

Reads Samsung Health personal data export (JSON format) and imports
into Alexandria's Supabase backend.

Samsung Health export structure varies by version but typically includes:
- com.samsung.health.steps.*.json
- com.samsung.health.sleep.*.json
- com.samsung.health.exercise.*.json
- com.samsung.health.heart_rate.*.json
- com.samsung.health.weight.*.json
- com.samsung.health.water_intake.*.json
- com.samsung.health.food_intake.*.json

Requirements: pip install supabase
"""

import json
import sys
import os
import glob
from datetime import datetime, timezone
from hashlib import sha256

try:
    from supabase import create_client
except ImportError:
    print("pip install supabase")
    sys.exit(1)


def connect_supabase():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)
    return create_client(url, key)


def ms_to_iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def dedup(supabase, fingerprint):
    existing = supabase.table("health_entries").select("id").contains(
        "metadata", {"import_fingerprint": fingerprint}
    ).execute()
    return bool(existing.data)


def find_files(export_dir, pattern):
    """Find Samsung Health JSON files matching a pattern."""
    patterns = [
        os.path.join(export_dir, f"com.samsung.health.{pattern}.*.json"),
        os.path.join(export_dir, "**", f"com.samsung.health.{pattern}.*.json"),
    ]
    files = []
    for p in patterns:
        files.extend(glob.glob(p, recursive=True))
    return list(set(files))


def load_json(filepath):
    """Load Samsung Health JSON, handling various formats."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read().strip()
    
    # Samsung Health sometimes prepends metadata comments
    # Find the first [ or { and parse from there
    for i, char in enumerate(content):
        if char in '[{':
            try:
                return json.loads(content[i:])
            except json.JSONDecodeError:
                continue
    
    # Try direct parse
    return json.loads(content)


def import_steps(export_dir, supabase):
    """Import daily step counts."""
    files = find_files(export_dir, "steps")
    imported = 0

    for filepath in files:
        try:
            data = load_json(filepath)
            if not isinstance(data, list):
                data = [data]
            
            for entry in data:
                count = entry.get("count") or entry.get("step_count") or entry.get("steps")
                ts_raw = entry.get("start_time") or entry.get("create_time") or entry.get("time_stamp")
                
                if not count or not ts_raw:
                    continue

                # Handle various timestamp formats
                if isinstance(ts_raw, (int, float)):
                    ts = ms_to_iso(ts_raw)
                else:
                    ts = ts_raw

                date_str = ts[:10] if ts else None
                if not date_str:
                    continue

                fingerprint = sha256(f"shealth-steps-{date_str}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "steps",
                    "timestamp": ts,
                    "value": {"count": int(count)},
                    "source": "samsung-health",
                    "tags": ["samsung-health", "steps"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}")

    print(f"  Steps: {imported} entries imported")


def import_sleep(export_dir, supabase):
    """Import sleep sessions."""
    files = find_files(export_dir, "sleep")
    imported = 0

    for filepath in files:
        try:
            data = load_json(filepath)
            if not isinstance(data, list):
                data = [data]

            for entry in data:
                start = entry.get("start_time") or entry.get("start_date_time")
                end = entry.get("end_time") or entry.get("end_date_time")

                if not start or not end:
                    continue

                if isinstance(start, (int, float)):
                    start = ms_to_iso(start)
                if isinstance(end, (int, float)):
                    end = ms_to_iso(end)

                start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
                duration_s = int((end_dt - start_dt).total_seconds())

                fingerprint = sha256(
                    f"shealth-sleep-{start}-{end}".encode()
                ).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "sleep",
                    "timestamp": start,
                    "duration_s": duration_s,
                    "value": {
                        "end_time": end,
                        "duration_hours": round(duration_s / 3600, 1),
                        "quality": entry.get("quality"),
                    },
                    "source": "samsung-health",
                    "tags": ["samsung-health", "sleep"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}")

    print(f"  Sleep: {imported} entries imported")


def import_exercise(export_dir, supabase):
    """Import exercise sessions."""
    files = find_files(export_dir, "exercise")
    imported = 0

    type_map = {
        "running": "cardio",
        "walking": "cardio",
        "cycling": "cardio",
        "swimming": "cardio",
        "hiking": "cardio",
        "elliptical": "cardio",
        "strength": "strength",
        "weight_training": "strength",
        "yoga": "flexibility",
        "stretching": "flexibility",
    }

    for filepath in files:
        try:
            data = load_json(filepath)
            if not isinstance(data, list):
                data = [data]

            for entry in data:
                start = entry.get("start_time") or entry.get("start_date_time")
                if not start:
                    continue
                if isinstance(start, (int, float)):
                    start = ms_to_iso(start)

                exercise_type = entry.get("exercise_type") or entry.get("type") or entry.get("comment", "other")
                duration = entry.get("duration") or entry.get("duration_sec") or entry.get("exercise_custom_type")

                fingerprint = sha256(
                    f"shealth-exercise-{start}-{exercise_type}".encode()
                ).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                value = {
                    "type": exercise_type,
                    "calories": entry.get("calorie") or entry.get("calories"),
                    "distance_m": entry.get("distance") or entry.get("distance_unit"),
                    "heart_rate_avg": entry.get("heart_rate") or entry.get("mean_heart_rate"),
                    "heart_rate_max": entry.get("max_heart_rate"),
                    "heart_rate_min": entry.get("min_heart_rate"),
                }
                # Remove None values
                value = {k: v for k, v in value.items() if v is not None}

                supabase.table("health_entries").insert({
                    "entry_type": "exercise",
                    "timestamp": start,
                    "duration_s": int(duration) if duration else None,
                    "value": value,
                    "source": "samsung-health",
                    "tags": ["samsung-health", "exercise", type_map.get(exercise_type, exercise_type)],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}")

    print(f"  Exercise: {imported} entries imported")


def import_weight(export_dir, supabase):
    """Import weight entries."""
    files = find_files(export_dir, "weight")
    imported = 0

    for filepath in files:
        try:
            data = load_json(filepath)
            if not isinstance(data, list):
                data = [data]

            for entry in data:
                weight = entry.get("weight") or entry.get("weight_value")
                ts_raw = entry.get("start_time") or entry.get("create_time") or entry.get("time_stamp")
                if not weight or not ts_raw:
                    continue

                if isinstance(ts_raw, (int, float)):
                    ts = ms_to_iso(ts_raw)
                else:
                    ts = ts_raw

                fingerprint = sha256(f"shealth-weight-{ts}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "weight",
                    "timestamp": ts,
                    "value": {"weight_kg": float(weight)},
                    "source": "samsung-health",
                    "tags": ["samsung-health", "weight"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}")

    print(f"  Weight: {imported} entries imported")


def import_heart_rate(export_dir, supabase):
    """Import heart rate samples."""
    files = find_files(export_dir, "heart_rate")
    imported = 0

    for filepath in files:
        try:
            data = load_json(filepath)
            if not isinstance(data, list):
                data = [data]

            for entry in data:
                hr = entry.get("heart_rate") or entry.get("bpm") or entry.get("rate")
                ts_raw = entry.get("start_time") or entry.get("create_time") or entry.get("time_stamp")
                if not hr or not ts_raw:
                    continue

                if isinstance(ts_raw, (int, float)):
                    ts = ms_to_iso(ts_raw)
                else:
                    ts = ts_raw

                fingerprint = sha256(f"shealth-hr-{ts}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "heart_rate",
                    "timestamp": ts,
                    "value": {"bpm": int(hr)},
                    "source": "samsung-health",
                    "tags": ["samsung-health", "heart-rate"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}")

    print(f"  Heart rate: {imported} entries imported")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_samsung_health.py <path/to/samsung-health-export/>")
        print("\nExport your data from Samsung Health: Settings -> Download personal data")
        sys.exit(1)

    export_dir = sys.argv[1]
    if not os.path.isdir(export_dir):
        print(f"Directory not found: {export_dir}")
        sys.exit(1)

    print(f"Importing Samsung Health data from {export_dir}...")
    supabase = connect_supabase()

    print("\n--- Scanning for data files ---")
    all_files = glob.glob(os.path.join(export_dir, "**", "com.samsung.health.*.json"), recursive=True)
    print(f"Found {len(all_files)} Samsung Health JSON files")

    print("\n--- Importing Steps ---")
    import_steps(export_dir, supabase)

    print("\n--- Importing Sleep ---")
    import_sleep(export_dir, supabase)

    print("\n--- Importing Exercise ---")
    import_exercise(export_dir, supabase)

    print("\n--- Importing Weight ---")
    import_weight(export_dir, supabase)

    print("\n--- Importing Heart Rate ---")
    import_heart_rate(export_dir, supabase)

    print("\nDone!")


if __name__ == "__main__":
    main()
