"""
Alexandria Shared Import Utilities

Common functions used by all importers: Supabase connection, dedup, upsert,
sync logging, timestamp formatting, and numeric value extraction.
"""

import os
import sys
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

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
    if table == "briefs":
        query = supabase.table(table).select("id").eq("content_hash", external_id)
    else:
        query = (
            supabase.table(table)
            .select("id")
            .eq("source", source)
            .eq("external_id", external_id)
        )
    data = query.execute().data
    return isinstance(data, list) and bool(data)


def _rpc_payload(table, record, source, external_id):
    payload = dict(record)
    payload.pop("source", None)
    payload.pop("external_id", None)
    payload["p_source"] = source
    payload["p_external_id"] = external_id
    if table == "briefs":
        metadata = record.get("metadata") or {}
        payload = {
            "p_title": record["title"],
            "p_brief_date": record["brief_date"],
            "p_kind": record["kind"],
            "p_body_markdown": record["body_markdown"],
            "p_source_job": record.get("source_job", source),
            "p_source_path": metadata.get("source_path", metadata.get("note_path")),
            "p_topics": record.get("topics", []),
            "p_project_refs": record.get("project_refs", []),
            "p_entity_refs": record.get("entity_refs", []),
            "p_metadata": metadata,
            "p_content_hash": record.get("content_hash", external_id),
        }
    else:
        payload = {
            f"p_{key}": value
            for key, value in payload.items()
            if key not in {"p_source", "p_external_id"}
        }
        payload["p_source"] = source
        payload["p_external_id"] = external_id
    return payload


def upsert_record(supabase, table, record, source, external_id):
    rpc_names = {
        "health_entries": "upsert_health_entry",
        "training_logs": "upsert_training_log",
        "briefs": "upsert_brief",
    }
    try:
        rpc_name = rpc_names[table]
    except KeyError as exc:
        raise ValueError(f"Unsupported upsert table: {table}") from exc
    return supabase.rpc(rpc_name, _rpc_payload(table, record, source, external_id)).execute()


def record_sync(
    supabase,
    source,
    sync_type="full",
    processed=0,
    imported=0,
    skipped=0,
    failed=0,
    failed_tables=0,
    started_at=None,
    error=None,
    status=None,
):
    try:
        if status is None:
            status = "failed" if error else ("partial" if failed or failed_tables else "completed")
        if status not in {"running", "completed", "partial", "failed"}:
            raise ValueError(f"Unsupported sync status: {status}")
        row = {
            "source": source,
            "sync_type": sync_type,
            "records_processed": processed,
            "records_imported": imported,
            "records_skipped": skipped,
            "records_failed": failed,
            "status": status,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if failed_tables:
            row["metadata"] = {"failed_tables": failed_tables}
        if started_at:
            row["started_at"] = started_at
        if error:
            row["error_message"] = error
        supabase.table("sync_log").insert(row).execute()
    except Exception as e:
        print(f"  Warning: failed to record sync_log: {e}")
        logger.warning("Failed to record sync_log", exc_info=True)


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
                return float(val)
            except (ValueError, TypeError):
                return None
    if entry_type == "exercise":
        for k in ("duration_min", "calories", "duration_s"):
            if k in value and value[k] is not None:
                try:
                    return (
                        round(float(value[k]), 1)
                        if k != "duration_s"
                        else round(float(value[k]) / 60, 1)
                    )
                except (ValueError, TypeError):
                    continue
    return None
