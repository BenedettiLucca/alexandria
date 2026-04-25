#!/usr/bin/env python3
"""
Iron Log -> Alexandria Importer

Reads ironlog.db (SQLite) and imports workout data into Alexandria's
Supabase backend via the REST API.

Requirements: pip install supabase requests
"""

import sys
import os
import sqlite3
from datetime import datetime, timezone
from hashlib import sha256

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.shared import (
    connect_supabase,
    upsert_record,
    record_sync,
    format_timestamp,
    format_date,
)


def import_sessions(db_path, supabase):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    sessions = conn.execute("""
        SELECT s.*, r.name as routine_name
        FROM sessions s
        LEFT JOIN routines r ON s.routine_id = r.id
        ORDER BY s.start_time
    """).fetchall()

    imported = 0
    skipped = 0

    for session in sessions:
        sets = conn.execute("""
            SELECT * FROM sets
            WHERE session_id = ?
            ORDER BY exercise_name, set_number
        """, (session["id"],)).fetchall()

        exercises_by_name = {}
        for s in sets:
            name = s["exercise_name"] or "Unknown"
            if name not in exercises_by_name:
                exercises_by_name[name] = {
                    "name": name,
                    "sets": [],
                }
            exercises_by_name[name]["sets"].append({
                "set_number": s["set_number"],
                "weight_kg": s["weight_kg"],
                "reps": s["reps"],
                "duration_s": s["duration_seconds"],
                "rir": s["rir"],
                "is_warmup": bool(s["is_warmup"]),
            })

        exercises = list(exercises_by_name.values())

        total_volume = sum(
            (s["weight_kg"] or 0) * (s["reps"] or 0)
            for s in sets
            if not s["is_warmup"]
        )

        workout_date = format_date(session["start_time"])
        if not workout_date:
            skipped += 1
            continue

        external_id = str(session["id"])

        if upsert_record(supabase, "training_logs", {}, "iron-log", external_id).data:
            # Existing record found by upsert, skip
            skipped += 1
            continue

        exercise_types = conn.execute("""
            SELECT DISTINCT e.type
            FROM sets s
            JOIN exercises e ON s.exercise_id = e.id
            WHERE s.session_id = ?
        """, (session["id"],)).fetchall()

        has_cardio = any(t["type"] == "duration" for t in exercise_types)
        has_strength = any(t["type"] == "strength" for t in exercise_types)
        workout_type = "strength"
        if has_cardio and has_strength:
            workout_type = "other"
        elif has_cardio:
            workout_type = "cardio"

        name = session["routine_name"] or session["notes"] or "Workout"

        duration_s = None
        if session["start_time"] and session["end_time"]:
            duration_s = int((session["end_time"] - session["start_time"]) / 1000)
        elif session["duration_minutes"]:
            duration_s = session["duration_minutes"] * 60

        fingerprint = sha256(
            f"ironlog-session-{session['id']}-{workout_date}".encode()
        ).hexdigest()

        record = {
            "workout_date": workout_date,
            "workout_type": workout_type,
            "name": name,
            "exercises": exercises,
            "duration_s": duration_s,
            "volume_kg": round(total_volume, 2) if total_volume else None,
            "rpe": session["s_rpe"],
            "notes": session["notes"],
            "tags": ["iron-log", workout_type],
            "event_time": format_timestamp(session["start_time"]),
            "ingestion_source": "iron-log",
            "external_id": external_id,
            "metadata": {
                "import_fingerprint": fingerprint,
                "source": "iron-log",
                "original_session_id": session["id"],
                "body_weight": session["body_weight"],
                "set_count": len(sets),
            },
        }

        upsert_record(supabase, "training_logs", record, "iron-log", external_id)
        imported += 1
        print(f"  Imported: {workout_date} - {name} ({len(sets)} sets)")

    conn.close()
    print(f"\nSessions: {imported} imported, {skipped} skipped (already exist or invalid)")
    return imported, skipped


def import_body_metrics(db_path, supabase):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    metrics = conn.execute(
        "SELECT * FROM body_metrics ORDER BY date"
    ).fetchall()

    imported = 0
    skipped = 0

    for m in metrics:
        ts = format_timestamp(m["date"])
        if not ts:
            skipped += 1
            continue

        ext_id = str(m["date"])

        if m["weight"]:
            fingerprint = sha256(
                f"ironlog-weight-{m['date']}".encode()
            ).hexdigest()

            record = {
                "entry_type": "weight",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": m["weight"],
                "value": {"weight_kg": m["weight"]},
                "source": "iron-log",
                "ingestion_source": "iron-log",
                "external_id": ext_id,
                "tags": ["iron-log"],
                "metadata": {"import_fingerprint": fingerprint},
            }

            upsert_record(supabase, "health_entries", record, "iron-log", ext_id)
            imported += 1

        if any([m["waist"], m["arm_right"], m["thigh_right"], m["chest"], m["calf"]]):
            fingerprint = sha256(
                f"ironlog-measurements-{m['date']}".encode()
            ).hexdigest()

            measurements = {}
            for field in ["waist", "arm_right", "thigh_right", "chest", "calf"]:
                if m[field]:
                    measurements[field] = m[field]

            measurements_ext_id = f"{ext_id}-measurements"
            record = {
                "entry_type": "body_composition",
                "timestamp": ts,
                "event_time": ts,
                "numeric_value": m["weight"] if m["weight"] else None,
                "value": measurements,
                "source": "iron-log",
                "ingestion_source": "iron-log",
                "external_id": measurements_ext_id,
                "tags": ["iron-log", "body-measurements"],
                "metadata": {"import_fingerprint": fingerprint, "type": m["type"]},
            }

            upsert_record(supabase, "health_entries", record, "iron-log", measurements_ext_id)
            imported += 1

    conn.close()
    print(f"Body metrics: {imported} imported, {skipped} skipped")
    return imported, skipped


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_ironlog.py <path/to/ironlog.db>")
        sys.exit(1)

    db_path = sys.argv[1]
    if not os.path.exists(db_path):
        print(f"File not found: {db_path}")
        sys.exit(1)

    start_time = datetime.now(timezone.utc).isoformat()
    print(f"Importing from {db_path}...")
    supabase = connect_supabase()

    print("\n--- Importing Sessions ---")
    s_imported, s_skipped = import_sessions(db_path, supabase)

    print("\n--- Importing Body Metrics ---")
    m_imported, m_skipped = import_body_metrics(db_path, supabase)

    total_imported = s_imported + m_imported
    total_skipped = s_skipped + m_skipped
    total_processed = total_imported + total_skipped

    record_sync(supabase, "iron-log", started_at=start_time, processed=total_processed,
                imported=total_imported, skipped=total_skipped)

    print("\nDone!")


if __name__ == "__main__":
    main()
