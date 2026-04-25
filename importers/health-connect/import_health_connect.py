#!/usr/bin/env python3
"""
Google Health Connect -> Alexandria Importer

Reads Health Connect's exported SQLite database and imports
health data into Alexandria's Supabase backend.

Health Connect exports a ZIP containing an SQLite DB with tables
for each record type (StepsRecord, SleepSessionRecord, etc)

Requirements: pip install supabase
"""

import sys
import os
import sqlite3
import glob
import zipfile
from datetime import datetime, timezone
from hashlib import sha256

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.shared import (
    connect_supabase,
    dedup_by_external_id,
    upsert_record,
    record_sync,
    format_timestamp,
    format_date,
    extract_numeric_value,
)


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


def import_records(conn, supabase, config):
    tables = [t for t in list_tables(conn)
              if any(kw in t.lower() for kw in config["table_keywords"])]
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

            ts_raw = config.get("get_timestamp")(rec)
            if ts_raw is None:
                continue

            ts = format_timestamp(ts_raw)
            external_id = config["build_external_id"](rec)

            if dedup_by_external_id(supabase, "health_entries", "health-connect", external_id):
                skipped += 1
                continue

            value = config["build_value"](rec)
            numeric_value = config.get("extract_numeric", lambda r, v: extract_numeric_value(config["entry_type"], v))(rec, value)

            record = {
                "entry_type": config["entry_type"],
                "timestamp": ts,
                "numeric_value": numeric_value,
                "value": value,
                "source": "health-connect",
                "external_id": external_id,
                "tags": ["health-connect"] + config["tags"],
                "metadata": {"import_fingerprint": external_id},
            }

            end_raw = rec.get("end_time") or rec.get("endtime")
            if end_raw and ts_raw:
                record["duration_s"] = int((end_raw - ts_raw) / 1000)

            if config.get("omit_none_values"):
                record["value"] = {k: v for k, v in value.items() if v is not None}

            upsert_record(supabase, "health_entries", record, "health-connect", external_id)
            imported += 1

    label = config["label"]
    print(f"  {label}: {imported} entries imported, {skipped} skipped")
    return imported, skipped


STEPS_CONFIG = {
    "table_keywords": ["step"],
    "entry_type": "steps",
    "tags": ["steps"],
    "label": "Steps",
    "build_value": lambda r: {"count": int(r.get("count") or r.get("steps") or 0)},
    "extract_numeric": lambda r, v: extract_numeric_value("steps", v),
    "build_external_id": lambda r: sha256(f"hc-steps-{format_date(r.get('start_time') or r.get('starttime'))}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("start_time") or r.get("starttime"),
}

SLEEP_CONFIG = {
    "table_keywords": ["sleep"],
    "entry_type": "sleep",
    "tags": ["sleep"],
    "label": "Sleep",
    "build_value": lambda r: (
        {**{"end_time": format_timestamp(r.get("end_time") or r.get("endtime")),
           "duration_hours": round(int(((r.get("end_time") or r.get("endtime")) - (r.get("start_time") or r.get("starttime"))) / 1000) / 3600, 1)},
         **({"stages": r.get("stages") or r.get("sleep_stage")}
            if r.get("stages") or r.get("sleep_stage") else {})}
    ),
    "extract_numeric": lambda r, v: extract_numeric_value("sleep", v),
    "build_external_id": lambda r: sha256(f"hc-sleep-{r.get('start_time') or r.get('starttime')}-{r.get('end_time') or r.get('endtime')}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("start_time") or r.get("starttime"),
}

EXERCISE_CONFIG = {
    "table_keywords": ["exercise"],
    "entry_type": "exercise",
    "tags": ["exercise"],
    "label": "Exercise",
    "build_value": lambda r: {
        "type": str(r.get("exercise_type", r.get("type", "other"))),
        **{f: r[f] for f in ["calories", "calorie", "distance", "distance_m",
                              "heart_rate_avg", "heart_rate_max", "heart_rate_min",
                              "title", "notes"] if r.get(f)},
    },
    "extract_numeric": lambda r, v: (
        round(int(((r.get("end_time") or r.get("endtime")) - (r.get("start_time") or r.get("starttime"))) / 1000) / 60, 1)
        if (r.get("end_time") or r.get("endtime")) and (r.get("start_time") or r.get("starttime"))
        else (round(float(r.get("calories") or r.get("calorie")), 1) if r.get("calories") or r.get("calorie") else None)
    ),
    "build_external_id": lambda r: sha256(f"hc-exercise-{r.get('start_time') or r.get('starttime')}-{r.get('exercise_type', r.get('type', 'other'))}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("start_time") or r.get("starttime"),
    "omit_none_values": True,
}

HEART_RATE_CONFIG = {
    "table_keywords": ["heart"],
    "entry_type": "heart_rate",
    "tags": ["heart-rate"],
    "label": "Heart rate",
    "build_value": lambda r: {"bpm": int(r.get("beats_per_minute") or r.get("bpm") or r.get("heart_rate") or 0)},
    "extract_numeric": lambda r, v: extract_numeric_value("heart_rate", v),
    "build_external_id": lambda r: sha256(f"hc-hr-{r.get('time') or r.get('start_time') or r.get('timestamp')}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("time") or r.get("start_time") or r.get("timestamp"),
}

WEIGHT_CONFIG = {
    "table_keywords": ["weight"],
    "entry_type": "weight",
    "tags": ["weight"],
    "label": "Weight",
    "build_value": lambda r: {"weight_kg": float(r.get("weight") or r.get("weight_kg") or 0)},
    "extract_numeric": lambda r, v: extract_numeric_value("weight", v),
    "build_external_id": lambda r: sha256(f"hc-weight-{r.get('time') or r.get('start_time') or r.get('timestamp')}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("time") or r.get("start_time") or r.get("timestamp"),
}

BLOOD_PRESSURE_CONFIG = {
    "table_keywords": ["blood_pressure", "bloodpressure"],
    "entry_type": "blood_pressure",
    "tags": ["blood-pressure"],
    "label": "Blood pressure",
    "build_value": lambda r: {
        **({"systolic": float(r.get("systolic") or r.get("systolic_avg") or 0)}
           if r.get("systolic") or r.get("systolic_avg") else {}),
        **({"diastolic": float(r.get("diastolic") or r.get("diastolic_avg") or 0)}
           if r.get("diastolic") or r.get("diastolic_avg") else {}),
    },
    "extract_numeric": lambda r, v: extract_numeric_value("blood_pressure", v),
    "build_external_id": lambda r: sha256(f"hc-bp-{r.get('time') or r.get('start_time')}".encode()).hexdigest(),
    "get_timestamp": lambda r: r.get("time") or r.get("start_time"),
}


def import_nutrition(conn, supabase):
    tables = [t for t in list_tables(conn)
              if any(kw in t.lower() for kw in ["nutrition", "water", "hydration"])]
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
            ts_raw = rec.get("start_time") or rec.get("time")
            if not ts_raw:
                continue
            ts = format_timestamp(ts_raw)

            volume = rec.get("volume") or rec.get("water") or rec.get("hydration")
            if volume:
                fp = sha256(f"hc-water-{ts_raw}".encode()).hexdigest()
                if dedup_by_external_id(supabase, "health_entries", "health-connect", fp):
                    skipped += 1
                else:
                    upsert_record(supabase, "health_entries", {
                        "entry_type": "water",
                        "timestamp": ts,
                        "numeric_value": float(volume),
                        "value": {"volume_ml": float(volume)},
                        "source": "health-connect",
                        "external_id": fp,
                        "tags": ["health-connect", "water"],
                        "metadata": {"import_fingerprint": fp},
                    }, "health-connect", fp)
                    imported += 1

            energy = rec.get("energy") or rec.get("calories") or rec.get("energy_total")
            if energy:
                fp = sha256(f"hc-nutrition-{ts_raw}".encode()).hexdigest()
                if dedup_by_external_id(supabase, "health_entries", "health-connect", fp):
                    skipped += 1
                else:
                    value = {"energy_kcal": float(energy)}
                    for field in ["protein", "fat_total", "carbs_total", "fiber",
                                  "sugar", "sodium", "caffeine"]:
                        if rec.get(field):
                            value[field] = float(rec[field])
                    upsert_record(supabase, "health_entries", {
                        "entry_type": "nutrition",
                        "timestamp": ts,
                        "numeric_value": float(energy),
                        "value": value,
                        "source": "health-connect",
                        "external_id": fp,
                        "tags": ["health-connect", "nutrition"],
                        "metadata": {"import_fingerprint": fp},
                    }, "health-connect", fp)
                    imported += 1

    print(f"  Nutrition/Water: {imported} entries imported, {skipped} skipped")
    return imported, skipped


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

    configs = [
        STEPS_CONFIG,
        SLEEP_CONFIG,
        EXERCISE_CONFIG,
        HEART_RATE_CONFIG,
        WEIGHT_CONFIG,
        BLOOD_PRESSURE_CONFIG,
    ]

    total_imported = 0
    total_skipped = 0
    for config in configs:
        imp, skp = import_records(conn, supabase, config)
        total_imported += imp
        total_skipped += skp

    n_imp, n_skip = import_nutrition(conn, supabase)
    total_imported += n_imp
    total_skipped += n_skip

    total_processed = total_imported + total_skipped

    record_sync(supabase, "health-connect", started_at=start_time, processed=total_processed,
                imported=total_imported, skipped=total_skipped)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
