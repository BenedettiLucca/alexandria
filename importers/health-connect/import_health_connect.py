#!/usr/bin/env python3
"""
Google Health Connect -> Alexandria Importer

Reads Health Connect's exported SQLite database and imports
health data into Alexandria's Supabase backend.

Health Connect exports a ZIP containing an SQLite DB with tables
for each record type (StepsRecord, SleepSessionRecord, etc.)

Requirements: pip install supabase
"""

import json
import sys
import os
import sqlite3
import glob
import zipfile
from datetime import datetime, timezone, timedelta
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


def find_db(export_path):
    """Find the SQLite database inside the export directory or ZIP."""
    # Check if it's a zip file
    if export_path.endswith(".zip") or os.path.isfile(export_path):
        if zipfile.is_zipfile(export_path):
            print(f"Extracting ZIP: {export_path}")
            extract_dir = export_path.replace(".zip", "_extracted")
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(export_path, "r") as z:
                z.extractall(extract_dir)
            export_path = extract_dir

    # Search for .db files
    db_files = glob.glob(os.path.join(export_path, "**", "*.db"), recursive=True)
    db_files += glob.glob(os.path.join(export_path, "**", "*.sqlite"), recursive=True)
    db_files += glob.glob(os.path.join(export_path, "**", "*.sqlite3"), recursive=True)

    if not db_files:
        print(f"No SQLite database found in {export_path}")
        print("Contents:")
        for f in glob.glob(os.path.join(export_path, "**", "*"), recursive=True):
            if os.path.isfile(f):
                print(f"  {f}")
        sys.exit(1)

    print(f"Found database: {db_files[0]}")
    return db_files[0]


def list_tables(conn):
    """List all tables in the database."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def dedup(supabase, fingerprint):
    existing = supabase.table("health_entries").select("id").contains(
        "metadata", {"import_fingerprint": fingerprint}
    ).execute()
    return bool(existing.data)


def ms_to_iso(ms):
    """Health Connect stores timestamps as epoch milliseconds."""
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def epoch_to_date(epoch_ms):
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


# ====================================================================
# RECORD TYPE IMPORTERS
# Each handles a specific Health Connect record type/table
# ====================================================================


def import_steps(conn, supabase):
    """Import StepsRecord -> health_entries as 'steps'."""
    tables = [t for t in list_tables(conn) if "step" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            count = rec.get("count") or rec.get("steps")
            start = rec.get("start_time") or rec.get("starttime")
            end = rec.get("end_time") or rec.get("endtime")

            if not count or not start:
                continue

            ts = ms_to_iso(start)
            date_str = epoch_to_date(start)
            fingerprint = sha256(f"hc-steps-{date_str}".encode()).hexdigest()

            if dedup(supabase, fingerprint):
                continue

            duration_s = None
            if end and start:
                duration_s = int((end - start) / 1000)

            supabase.table("health_entries").insert({
                "entry_type": "steps",
                "timestamp": ts,
                "duration_s": duration_s,
                "value": {"count": int(count)},
                "source": "health-connect",
                "tags": ["health-connect", "steps"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Steps: {imported} entries imported")


def import_sleep(conn, supabase):
    """Import SleepSessionRecord -> health_entries as 'sleep'."""
    tables = [t for t in list_tables(conn) if "sleep" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            start = rec.get("start_time") or rec.get("starttime")
            end = rec.get("end_time") or rec.get("endtime")
            if not start or not end:
                continue

            start_iso = ms_to_iso(start)
            end_iso = ms_to_iso(end)
            duration_s = int((end - start) / 1000)

            fingerprint = sha256(f"hc-sleep-{start}-{end}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                continue

            value = {"end_time": end_iso, "duration_hours": round(duration_s / 3600, 1)}
            # Sleep stages if present
            if rec.get("stages") or rec.get("sleep_stage"):
                value["stages"] = rec.get("stages") or rec.get("sleep_stage")

            supabase.table("health_entries").insert({
                "entry_type": "sleep",
                "timestamp": start_iso,
                "duration_s": duration_s,
                "value": value,
                "source": "health-connect",
                "tags": ["health-connect", "sleep"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Sleep: {imported} entries imported")


def import_exercise(conn, supabase):
    """Import ExerciseSessionRecord -> health_entries as 'exercise'."""
    tables = [t for t in list_tables(conn) if "exercise" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            start = rec.get("start_time") or rec.get("starttime")
            end = rec.get("end_time") or rec.get("endtime")
            if not start:
                continue

            start_iso = ms_to_iso(start)
            exercise_type = str(rec.get("exercise_type", rec.get("type", "other")))

            fingerprint = sha256(f"hc-exercise-{start}-{exercise_type}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                continue

            duration_s = None
            if end and start:
                duration_s = int((end - start) / 1000)

            value = {"type": exercise_type}
            for field in ["calories", "calorie", "distance", "distance_m",
                          "heart_rate_avg", "heart_rate_max", "heart_rate_min",
                          "title", "notes"]:
                if rec.get(field):
                    value[field] = rec[field]

            supabase.table("health_entries").insert({
                "entry_type": "exercise",
                "timestamp": start_iso,
                "duration_s": duration_s,
                "value": {k: v for k, v in value.items() if v is not None},
                "source": "health-connect",
                "tags": ["health-connect", "exercise"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Exercise: {imported} entries imported")


def import_heart_rate(conn, supabase):
    """Import HeartRateRecord -> health_entries as 'heart_rate'."""
    tables = [t for t in list_tables(conn) if "heart" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            bpm = rec.get("beats_per_minute") or rec.get("bpm") or rec.get("heart_rate")
            ts_raw = rec.get("time") or rec.get("start_time") or rec.get("timestamp")
            if not bpm or not ts_raw:
                continue

            ts = ms_to_iso(ts_raw)
            fingerprint = sha256(f"hc-hr-{ts_raw}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                continue

            supabase.table("health_entries").insert({
                "entry_type": "heart_rate",
                "timestamp": ts,
                "value": {"bpm": int(bpm)},
                "source": "health-connect",
                "tags": ["health-connect", "heart-rate"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Heart rate: {imported} entries imported")


def import_weight(conn, supabase):
    """Import WeightRecord -> health_entries as 'weight'."""
    tables = [t for t in list_tables(conn) if "weight" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            weight = rec.get("weight") or rec.get("weight_kg")
            ts_raw = rec.get("time") or rec.get("start_time") or rec.get("timestamp")
            if not weight or not ts_raw:
                continue

            ts = ms_to_iso(ts_raw)
            fingerprint = sha256(f"hc-weight-{ts_raw}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                continue

            supabase.table("health_entries").insert({
                "entry_type": "weight",
                "timestamp": ts,
                "value": {"weight_kg": float(weight)},
                "source": "health-connect",
                "tags": ["health-connect", "weight"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Weight: {imported} entries imported")


def import_blood_pressure(conn, supabase):
    """Import BloodPressureRecord -> health_entries as 'blood_pressure'."""
    tables = [t for t in list_tables(conn) if "blood_pressure" in t.lower()]
    imported = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))

            systolic = rec.get("systolic") or rec.get("systolic_avg")
            diastolic = rec.get("diastolic") or rec.get("diastolic_avg")
            ts_raw = rec.get("time") or rec.get("start_time")
            if not ts_raw:
                continue

            ts = ms_to_iso(ts_raw)
            fingerprint = sha256(f"hc-bp-{ts_raw}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                continue

            value = {}
            if systolic: value["systolic"] = float(systolic)
            if diastolic: value["diastolic"] = float(diastolic)

            supabase.table("health_entries").insert({
                "entry_type": "blood_pressure",
                "timestamp": ts,
                "value": value,
                "source": "health-connect",
                "tags": ["health-connect", "blood-pressure"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Blood pressure: {imported} entries imported")


def import_nutrition(conn, supabase):
    """Import NutritionRecord -> health_entries as 'water' or 'nutrition'."""
    tables = [t for t in list_tables(conn) if "nutrition" in t.lower() or "water" in t.lower() or "hydration" in t.lower()]
    imported_water = 0
    imported_food = 0

    for table in tables:
        try:
            rows = conn.execute(f"SELECT * FROM [{table}]").fetchall()
            cols = [d[0].lower() for d in conn.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
        except Exception as e:
            print(f"  Skipping {table}: {e}")
            continue

        for row in rows:
            rec = dict(zip(cols, row))
            ts_raw = rec.get("start_time") or rec.get("time")
            if not ts_raw:
                continue

            ts = ms_to_iso(ts_raw)

            # Water intake
            volume = rec.get("volume") or rec.get("water") or rec.get("hydration")
            if volume:
                fingerprint = sha256(f"hc-water-{ts_raw}".encode()).hexdigest()
                if not dedup(supabase, fingerprint):
                    supabase.table("health_entries").insert({
                        "entry_type": "water",
                        "timestamp": ts,
                        "value": {"volume_ml": float(volume)},
                        "source": "health-connect",
                        "tags": ["health-connect", "water"],
                        "metadata": {"import_fingerprint": fingerprint},
                    }).execute()
                    imported_water += 1

            # Nutrition (food)
            energy = rec.get("energy") or rec.get("calories") or rec.get("energy_total")
            if energy:
                fingerprint = sha256(f"hc-nutrition-{ts_raw}".encode()).hexdigest()
                if not dedup(supabase, fingerprint):
                    value = {"energy_kcal": float(energy)}
                    for field in ["protein", "fat_total", "carbs_total", "fiber",
                                  "sugar", "sodium", "caffeine"]:
                        if rec.get(field):
                            value[field] = float(rec[field])

                    supabase.table("health_entries").insert({
                        "entry_type": "nutrition",
                        "timestamp": ts,
                        "value": value,
                        "source": "health-connect",
                        "tags": ["health-connect", "nutrition"],
                        "metadata": {"import_fingerprint": fingerprint},
                    }).execute()
                    imported_food += 1

    print(f"  Water: {imported_water} entries imported")
    print(f"  Nutrition: {imported_food} entries imported")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_health_connect.py <path/to/export/>")
        print("       python3 import_health_connect.py <path/to/Health Connect.zip>")
        print()
        print("Export your data: Android Settings -> Health Connect -> Manage data -> Scheduled export")
        sys.exit(1)

    export_path = sys.argv[1]
    if not os.path.exists(export_path):
        print(f"Path not found: {export_path}")
        sys.exit(1)

    db_path = find_db(export_path)
    conn = sqlite3.connect(db_path)

    tables = list_tables(conn)
    print(f"\nDatabase has {len(tables)} tables:")
    for t in tables:
        try:
            count = conn.execute(f"SELECT COUNT(*) FROM [{t}]").fetchone()[0]
            if count > 0:
                print(f"  {t}: {count} rows")
        except:
            print(f"  {t}: (error reading)")

    print("\n--- Importing ---")
    supabase = connect_supabase()

    import_steps(conn, supabase)
    import_sleep(conn, supabase)
    import_exercise(conn, supabase)
    import_heart_rate(conn, supabase)
    import_weight(conn, supabase)
    import_blood_pressure(conn, supabase)
    import_nutrition(conn, supabase)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
