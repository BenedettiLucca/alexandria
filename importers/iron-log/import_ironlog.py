#!/usr/bin/env python3
"""
Iron Log -> Alexandria Importer

Reads ironlog.db (SQLite) and imports workout data into Alexandria's
Supabase backend via the REST API.

Requirements: pip install supabase requests
"""

import json
import sys
import os
import sqlite3
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


def epoch_to_iso(epoch_ms):
    """Convert epoch milliseconds to ISO 8601 string."""
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).isoformat()


def epoch_to_date(epoch_ms):
    """Convert epoch milliseconds to YYYY-MM-DD string."""
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def import_sessions(db_path, supabase):
    """Import workout sessions with their sets into training_logs."""
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
        # Get all sets for this session
        sets = conn.execute("""
            SELECT * FROM sets
            WHERE session_id = ?
            ORDER BY exercise_name, set_number
        """, (session["id"],)).fetchall()

        # Build exercises array
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

        # Calculate total volume
        total_volume = sum(
            (s["weight_kg"] or 0) * (s["reps"] or 0)
            for s in sets
            if not s["is_warmup"]
        )

        # Workout date
        workout_date = epoch_to_date(session["start_time"])
        if not workout_date:
            skipped += 1
            continue

        # Dedup fingerprint
        fingerprint = sha256(
            f"ironlog-session-{session['id']}-{workout_date}".encode()
        ).hexdigest()

        # Check if already imported
        existing = supabase.table("training_logs").select("id").contains(
            "metadata", {"import_fingerprint": fingerprint}
        ).execute()

        if existing.data:
            skipped += 1
            continue

        # Determine workout type from exercises
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

        # Duration in seconds
        duration_s = None
        if session["start_time"] and session["end_time"]:
            duration_s = int((session["end_time"] - session["start_time"]) / 1000)
        elif session["duration_minutes"]:
            duration_s = session["duration_minutes"] * 60

        # Insert
        result = supabase.table("training_logs").insert({
            "workout_date": workout_date,
            "workout_type": workout_type,
            "name": name,
            "exercises": exercises,
            "duration_s": duration_s,
            "volume_kg": round(total_volume, 2) if total_volume else None,
            "rpe": session["s_rpe"],
            "notes": session["notes"],
            "tags": ["iron-log", workout_type],
            "metadata": {
                "import_fingerprint": fingerprint,
                "source": "iron-log",
                "original_session_id": session["id"],
                "body_weight": session["body_weight"],
                "set_count": len(sets),
            },
        }).execute()

        imported += 1
        print(f"  Imported: {workout_date} - {name} ({len(sets)} sets)")

    conn.close()
    print(f"\nSessions: {imported} imported, {skipped} skipped (already exist or invalid)")


def import_body_metrics(db_path, supabase):
    """Import body weight and measurements into health_entries."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    metrics = conn.execute(
        "SELECT * FROM body_metrics ORDER BY date"
    ).fetchall()

    imported = 0
    skipped = 0

    for m in metrics:
        ts = epoch_to_iso(m["date"])
        if not ts:
            skipped += 1
            continue

        # Weight entry
        if m["weight"]:
            fingerprint = sha256(
                f"ironlog-weight-{m['date']}".encode()
            ).hexdigest()

            existing = supabase.table("health_entries").select("id").contains(
                "metadata", {"import_fingerprint": fingerprint}
            ).execute()

            if not existing.data:
                supabase.table("health_entries").insert({
                    "entry_type": "weight",
                    "timestamp": ts,
                    "value": {"weight_kg": m["weight"]},
                    "source": "iron-log",
                    "tags": ["iron-log"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1

        # Measurements entry (monthly check-ins)
        if any([m["waist"], m["arm_right"], m["thigh_right"], m["chest"], m["calf"]]):
            fingerprint = sha256(
                f"ironlog-measurements-{m['date']}".encode()
            ).hexdigest()

            existing = supabase.table("health_entries").select("id").contains(
                "metadata", {"import_fingerprint": fingerprint}
            ).execute()

            if not existing.data:
                measurements = {}
                for field in ["waist", "arm_right", "thigh_right", "chest", "calf"]:
                    if m[field]:
                        measurements[field] = m[field]

                supabase.table("health_entries").insert({
                    "entry_type": "nutrition",  # closest type for body measurements
                    "timestamp": ts,
                    "value": measurements,
                    "source": "iron-log",
                    "tags": ["iron-log", "body-measurements"],
                    "metadata": {"import_fingerprint": fingerprint, "type": m["type"]},
                }).execute()
                imported += 1

    conn.close()
    print(f"Body metrics: {imported} imported, {skipped} skipped")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_ironlog.py <path/to/ironlog.db>")
        sys.exit(1)

    db_path = sys.argv[1]
    if not os.path.exists(db_path):
        print(f"File not found: {db_path}")
        sys.exit(1)

    print(f"Importing from {db_path}...")
    supabase = connect_supabase()

    print("\n--- Importing Sessions ---")
    import_sessions(db_path, supabase)

    print("\n--- Importing Body Metrics ---")
    import_body_metrics(db_path, supabase)

    print("\nDone!")


if __name__ == "__main__":
    main()
