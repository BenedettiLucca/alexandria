"""Pure, versioned health-entry contract shared by importers."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

CONTRACT_VERSION = "health.v1"
ENTRY_TYPES = frozenset({"steps", "weight", "heart_rate", "sleep", "exercise", "body_composition", "measurement_goal"})
ALIASES = {
    "heartRate": "heart_rate", "heart-rate": "heart_rate", "hr": "heart_rate",
    "bodyComp": "body_composition", "body-comp": "body_composition",
    "goal": "measurement_goal", "measurement-goal": "measurement_goal",
}
_FIELDS = {
    "steps": ("count", ("steps",)),
    "weight": ("weight_kg", ("weight",)),
    "heart_rate": ("bpm", ("beats_per_minute", "heart_rate")),
    "sleep": ("duration_hours", ("duration_h",)),
    "exercise": ("duration_s", ("duration_seconds",)),
}
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value or value.endswith("Z") is False and "+" not in value and not re.search(r"T[^ ]*-[0-9]{2}:[0-9]{2}$", value):
        raise ValueError("timestamp must be an ISO-8601 string with an explicit offset")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("timestamp must be an ISO-8601 string with an explicit offset") from exc
    return value


def identity(record: dict[str, Any]) -> str:
    source = record.get("source")
    stable = record.get("source_record_id") or record.get("external_id")
    if stable:
        return f"{source or 'unknown'}:{stable}"
    start = record.get("start") or record.get("timestamp")
    end = record.get("end") or record.get("timestamp")
    if not source or not start or not end:
        raise ValueError("identity requires source record id or provenance/source and start/end")
    return f"fallback:{source}:{start}:{end}:{record.get('entry_type')}"


def validate_health_entry(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError("health entry must be an object")
    entry_type = ALIASES.get(record.get("entry_type"), record.get("entry_type"))
    if entry_type not in ENTRY_TYPES:
        raise ValueError("unsupported entry_type")
    timestamp = _timestamp(record.get("timestamp"))
    value = record.get("value")
    if value is not None and not isinstance(value, dict):
        raise ValueError("value must be an object or null")
    if record.get("numeric_value") is not None and not _number(record["numeric_value"]):
        raise ValueError("numeric_value must be a number or null")
    if record.get("duration_s") is not None and (not _number(record["duration_s"]) or record["duration_s"] < 0):
        raise ValueError("duration_s must be non-negative")
    if record.get("source") is not None and not isinstance(record["source"], str):
        raise ValueError("source must be a string")
    return {"entry_type": entry_type, "timestamp": timestamp, "value": value, "numeric_value": record.get("numeric_value"), "duration_s": record.get("duration_s"), "source": record.get("source"), "external_id": record.get("external_id")}


def normalize_health_entry(record: dict[str, Any]) -> dict[str, Any]:
    checked = validate_health_entry(record)
    value = dict(checked["value"] or {})
    entry_type = checked["entry_type"]
    canonical, aliases = _FIELDS.get(entry_type, (None, ()))
    if canonical and canonical not in value:
        for alias in aliases:
            if alias in value:
                value[canonical] = value[alias]
                break
    if canonical and canonical in value and not _number(value[canonical]):
        raise ValueError(f"{canonical} must be a number")
    if entry_type == "steps" and value.get("count") is not None and value["count"] < 0:
        raise ValueError("steps count must be non-negative")
    result = dict(checked)
    result["value"] = value
    result["identity"] = identity({**record, **result})
    result["contract_version"] = CONTRACT_VERSION
    result["raw_content"] = {"untrusted": True, "value": record}
    return result


def project_health_entries(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected: dict[str, dict[str, Any]] = {}
    for record in records:
        item = normalize_health_entry(record)
        key = item["identity"]
        if key in projected:
            if projected[key] != item:
                raise ValueError(f"conflicting duplicate identity: {key}")
            continue
        projected[key] = item
    return [projected[key] for key in sorted(projected)]
