"""
Alexandria Shared Import Utilities

Common functions used by all importers: Supabase connection, dedup, upsert,
sync logging, timestamp formatting, and numeric value extraction.
"""

import os
import sys
from datetime import datetime, timezone

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


def dedup_by_external_id(supabase, table, source, external_id):
    if not external_id:
        return False
    existing = (
        supabase.table(table)
        .select("id")
        .eq("source", source)
        .eq("external_id", external_id)
        .execute()
    )
    return bool(existing.data)


def upsert_record(supabase, table, record, source, external_id):
    if external_id:
        existing = (
            supabase.table(table)
            .select("id")
            .eq("source", source)
            .eq("external_id", external_id)
            .execute()
        )
        if existing.data:
            return (
                supabase.table(table)
                .update(record)
                .eq("source", source)
                .eq("external_id", external_id)
                .execute()
            )
    return supabase.table(table).insert(record).execute()


def record_sync(supabase, source, sync_type="full", processed=0, imported=0,
                skipped=0, failed=0, started_at=None, error=None):
    try:
        row = {
            "source": source,
            "sync_type": sync_type,
            "records_processed": processed,
            "records_imported": imported,
            "records_skipped": skipped,
            "records_failed": failed,
            "status": "failed" if error else "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if started_at:
            row["started_at"] = started_at
        if error:
            row["error_message"] = error
        supabase.table("sync_log").insert(row).execute()
    except Exception as e:
        print(f"  Warning: failed to record sync_log: {e}")


def format_timestamp(epoch_ms):
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).isoformat()


def format_date(epoch_ms):
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def extract_numeric_value(entry_type, value):
    if not value or not isinstance(value, dict):
        return None
    mapping = {
        "steps": "count",
        "heart_rate": "bpm",
        "weight": "weight_kg",
        "sleep": "duration_hours",
        "blood_pressure": "systolic",
        "body_composition": "weight_kg",
    }
    key = mapping.get(entry_type)
    if key and key in value:
        val = value[key]
        if val is not None:
            try:
                if entry_type == "sleep":
                    return round(float(val), 1)
                if entry_type == "steps":
                    return int(val)
                if entry_type == "blood_pressure":
                    return float(val)
                return float(val)
            except (ValueError, TypeError):
                return None
    if entry_type == "exercise":
        for k in ("duration_min", "calories", "duration_s"):
            if k in value and value[k] is not None:
                try:
                    return round(float(value[k]), 1) if k != "duration_s" else round(float(value[k]) / 60, 1)
                except (ValueError, TypeError):
                    continue
    return None
