#!/usr/bin/env python3
"""
Google Health Connect -> Alexandria Importer

Reads Health Connect's exported SQLite database and imports
health data into Alexandria's Supabase backend.

Health Connect exports a ZIP containing an SQLite DB with tables
for each record type (StepsRecord, SleepSessionRecord, etc)

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
    if export_path.endswith(".zip") or os.path.isfile(export_path):
        if zipfile.is_zipfile(export_path):
            print(f"Extracting ZIP: {export_path}")
            extract_dir = export_path.replace(".zip", "_extracted")
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(export_path, "r") as z:
                z.extractall(extract_dir)
            export_path = extract_dir

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
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def epoch_to_date(epoch_ms):
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def record_sync(supabase, source, started_at, processed, imported, skipped):
    try:
        supabase.table("sync_log").insert({
            "source": source,
            "sync_type": "full",
            "records_processed": processed,
            "records_imported": imported,
            "records_skipped": skipped,
            "status": "completed",
            "started_at": started_at,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
    except Exception as e:
        print(f"  Warning: failed to record sync_log: {e}")


# ====================================================================
# RECORD TYPE IMPORTERS
# ====================================================================


def import_steps(conn, supabase):
    tables = [t for t in list_tables(conn) if "step" in t.lower()]
    imported = 0
    skipped = 0

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
                skipped += 1
                continue

            duration_s = None
            if end and start:
                duration_s = int((end - start) / 1000)

            supabase.table("health_entries").insert({
                "entry_type": "steps",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": int(count),
                "duration_s": duration_s,
                "value": {"count": int(count)},
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "steps"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Steps: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_sleep(conn, supabase):
    tables = [t for t in list_tables(conn) if "sleep" in t.lower()]
    imported = 0
    skipped = 0

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
            duration_hours = round(duration_s / 3600, 1)

            fingerprint = sha256(f"hc-sleep-{start}-{end}".encode()).hexdigest()
            if dedup(supabase, fingerprint):
                skipped += 1
                continue

            value = {"end_time": end_iso, "duration_hours": duration_hours}
            if rec.get("stages") or rec.get("sleep_stage"):
                value["stages"] = rec.get("stages") or rec.get("sleep_stage")

            supabase.table("health_entries").insert({
                "entry_type": "sleep",
                "timestamp": start_iso,
                "event_time": start_iso,
                "numeric_value": duration_hours,
                "duration_s": duration_s,
                "value": value,
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "sleep"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Sleep: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_exercise(conn, supabase):
    tables = [t for t in list_tables(conn) if "exercise" in t.lower()]
    imported = 0
    skipped = 0

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
                skipped += 1
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

            calories = rec.get("calories") or rec.get("calorie")
            numeric_value = round(duration_s / 60, 1) if duration_s else (float(calories) if calories else None)

            supabase.table("health_entries").insert({
                "entry_type": "exercise",
                "timestamp": start_iso,
                "event_time": start_iso,
                "numeric_value": numeric_value,
                "duration_s": duration_s,
                "value": {k: v for k, v in value.items() if v is not None},
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "exercise"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Exercise: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_heart_rate(conn, supabase):
    tables = [t for t in list_tables(conn) if "heart" in t.lower()]
    imported = 0
    skipped = 0

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
                skipped += 1
                continue

            supabase.table("health_entries").insert({
                "entry_type": "heart_rate",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": int(bpm),
                "value": {"bpm": int(bpm)},
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "heart-rate"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Heart rate: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_weight(conn, supabase):
    tables = [t for t in list_tables(conn) if "weight" in t.lower()]
    imported = 0
    skipped = 0

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
                skipped += 1
                continue

            supabase.table("health_entries").insert({
                "entry_type": "weight",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": float(weight),
                "value": {"weight_kg": float(weight)},
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "weight"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Weight: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_blood_pressure(conn, supabase):
    tables = [t for t in list_tables(conn) if "blood_pressure" in t.lower()]
    imported = 0
    skipped = 0

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
                skipped += 1
                continue

            value = {}
            if systolic:
                value["systolic"] = float(systolic)
            if diastolic:
                value["diastolic"] = float(diastolic)

            supabase.table("health_entries").insert({
                "entry_type": "blood_pressure",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": float(systolic) if systolic else float(diastolic) if diastolic else None,
                "value": value,
                "source": "health-connect",
                "ingestion_source": "health-connect",
                "external_id": fingerprint,
                "tags": ["health-connect", "blood-pressure"],
                "metadata": {"import_fingerprint": fingerprint},
            }).execute()
            imported += 1

    print(f"  Blood pressure: {imported} entries imported, {skipped} skipped")
    return imported, skipped


def import_nutrition(conn, supabase):
    tables = [t for t in list_tables(conn)
              if "nutrition" in t.lower() or "water" in t.lower() or "hydration" in t.lower()]
    imported_water = 0
    imported_food = 0
    skipped = 0

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

            volume = rec.get("volume") or rec.get("water") or rec.get("hydration")
            if volume:
                fingerprint = sha256(f"hc-water-{ts_raw}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    skipped += 1
                else:
                    supabase.table("health_entries").insert({
                        "entry_type": "water",
                        "timestamp": ts,
                        "event_time": ts,
                        "numeric_value": float(volume),
                        "value": {"volume_ml": float(volume)},
                        "source": "health-connect",
                        "ingestion_source": "health-connect",
                        "external_id": fingerprint,
                        "tags": ["health-connect", "water"],
                        "metadata": {"import_fingerprint": fingerprint},
                    }).execute()
                    imported_water += 1

            energy = rec.get("energy") or rec.get("calories") or rec.get("energy_total")
            if energy:
                fingerprint = sha256(f"hc-nutrition-{ts_raw}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    skipped += 1
                else:
                    value = {"energy_kcal": float(energy)}
                    for field in ["protein", "fat_total", "carbs_total", "fiber",
                                  "sugar", "sodium", "caffeine"]:
                        if rec.get(field):
                            value[field] = float(rec[field])

                    supabase.table("health_entries").insert({
                        "entry_type": "nutrition",
                        "timestamp": ts,
                        "event_time": ts,
                        "numeric_value": float(energy),
                        "value": value,
                        "source": "health-connect",
                        "ingestion_source": "health-connect",
                        "external_id": fingerprint,
                        "tags": ["health-connect", "nutrition"],
                        "metadata": {"import_fingerprint": fingerprint},
                    }).execute()
                    imported_food += 1

    print(f"  Water: {imported_water} entries imported")
    print(f"  Nutrition: {imported_food} entries imported")
    return imported_water + imported_food, skipped


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

    start_time = datetime.now(timezone.utc).isoformat()
    print("\n--- Importing ---")
    supabase = connect_supabase()

    s_imp, s_skip = import_steps(conn, supabase)
    sl_imp, sl_skip = import_sleep(conn, supabase)
    e_imp, e_skip = import_exercise(conn, supabase)
    hr_imp, hr_skip = import_heart_rate(conn, supabase)
    w_imp, w_skip = import_weight(conn, supabase)
    bp_imp, bp_skip = import_blood_pressure(conn, supabase)
    n_imp, n_skip = import_nutrition(conn, supabase)

    total_imported = s_imp + sl_imp + e_imp + hr_imp + w_imp + bp_imp + n_imp
    total_skipped = s_skip + sl_skip + e_skip + hr_skip + w_skip + bp_skip + n_skip
    total_processed = total_imported + total_skipped

    record_sync(supabase, "health-connect", start_time, total_processed, total_imported, total_skipped)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
