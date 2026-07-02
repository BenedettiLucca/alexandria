#!/usr/bin/env python3
"""
Alexandria Health Connect Sync Service

Syncs health data from Google Health API directly into Alexandria.

Uses the Google Health API (health.googleapis.com) which provides REST
endpoints to read data that Samsung Health and other apps write into
Health Connect.

SETUP:
  1. Go to https://console.cloud.google.com
  2. Create a project (or use existing)
  3. Enable the "Google Health API"
  4. Create OAuth 2.0 credentials (Desktop app)
  5. Download client_secret.json to this directory
  6. Run: python3 sync.py --auth    # First-time OAuth flow
  7. Run: python3 sync.py           # Sync all data
  8. Set up a cron job for automatic syncing

For cron automation, use a refresh token (saved after --auth).

Requirements: pip install google-auth-oauthlib google-api-python-client supabase

DATA TYPES SYNCED:
  - Steps (daily count)
  - Sleep sessions (start, end, duration, stages)
  - Exercise sessions (type, duration, calories, heart rate)
  - Heart rate samples
  - Weight measurements
  - Blood pressure
  - Nutrition / hydration

GOOGLE HEALTH API DATA TYPES:
  - active-minutes -> activity
  - steps -> steps
  - weight -> weight
  - exercise -> exercise
  - heart-rate -> heart_rate
  - sleep (via sessions, activityType=72) -> sleep
  - blood-pressure -> blood_pressure
  - nutrition -> nutrition / water
  - body-fat -> body composition
"""

import os
import sys
import json
import argparse
import logging
import subprocess
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from pathlib import Path

logger = logging.getLogger(__name__)

MILLIS_PER_DAY = 86_400_000
FIT_API_BASE = "https://www.googleapis.com/fitness/v1/users/me"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.shared import (
    connect_supabase,
    dedup_by_external_id,
    upsert_record,
    record_sync,
    format_timestamp,
    format_date,
)

def get_credentials():
    """Handle OAuth2 authentication for Google Health API."""
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
        from google.oauth2.credentials import Credentials
    except ImportError:
        print("pip install google-auth-oauthlib")
        sys.exit(1)

    SCOPES = [
        "https://www.googleapis.com/auth/fitness.activity.read",
        "https://www.googleapis.com/auth/fitness.body.read",
        "https://www.googleapis.com/auth/fitness.heart_rate.read",
        "https://www.googleapis.com/auth/fitness.sleep.read",
        "https://www.googleapis.com/auth/fitness.nutrition.read",
        "https://www.googleapis.com/auth/fitness.blood_pressure.read",
    ]

    token_path = Path(
        os.environ.get("GOOGLE_TOKEN_PATH", str(Path(__file__).parent / "token.json"))
    )
    secrets_path = Path(
        os.environ.get(
            "GOOGLE_CLIENT_SECRETS_PATH",
            str(Path(__file__).parent / "client_secret.json"),
        )
    )

    # Check for existing token
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        if creds and creds.valid:
            return creds
        if creds and creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request

            creds.refresh(Request())
            token_path.write_text(creds.to_json())
            return creds

    # New OAuth flow
    if not secrets_path.exists():
        print("ERROR: client_secret.json not found.")
        print("Download it from: https://console.cloud.google.com/apis/credentials")
        print("Enable the Google Health API first.")
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(secrets_path), SCOPES)
    creds = flow.run_local_server(port=0)
    token_path.write_text(creds.to_json())
    print(f"Credentials saved to {token_path}")
    return creds


def _api_get(creds, url, method="GET", body=None):
    """Single HTTP helper. Uses curl (urllib hangs on CachyOS)."""
    headers = ["-H", f"Authorization: Bearer {creds.token}"]
    if body:
        headers += ["-H", "Content-Type: application/json", "-d", body]
    try:
        r = subprocess.run(
            ["curl", "-s", "-X", method] + headers + [url],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            print(f"  curl failed: {r.stderr.strip()}")
            return None
        return json.loads(r.stdout)
    except Exception as e:
        print(f"  API request failed: {e}")
        logger.warning(f"API request failed: {e}", exc_info=True)
        return None


AGGREGATE_CONFIGS = {
    "steps": {
        "data_type_name": "com.google.step_count.delta",
        "entry_type": "steps",
        "id_prefix": "ghc-steps",
        "fingerprint_prefix": "ghc-steps",
        "tags": ["health-connect", "steps"],
        "label": "Steps",
        "value_key": "intVal",
        "value_field": "count",
        "round": None,
    },
    "weight": {
        "data_type_name": "com.google.weight",
        "entry_type": "weight",
        "id_prefix": "ghc-weight",
        "fingerprint_prefix": "ghc-weight",
        "tags": ["health-connect", "weight"],
        "label": "Weight",
        "value_key": "fpVal",
        "value_field": "weight_kg",
        "round": 2,
    },
    "heart_rate": {
        "data_type_name": "com.google.heart_rate.bpm",
        "entry_type": "heart_rate",
        "id_prefix": "ghc-heart_rate",
        "fingerprint_prefix": "ghc-hr",
        "tags": ["health-connect", "heart-rate"],
        "label": "Heart rate",
        "value_key": "fpVal",
        "value_field": "bpm",
        "round": 0,
    },
}


def sync_aggregate(creds, supabase, start_ms, end_ms, config_name):
    """Generic sync for Google Fit aggregate endpoints (steps, weight, heart_rate)."""
    cfg = AGGREGATE_CONFIGS[config_name]

    data = _api_get(
        creds,
        f"{FIT_API_BASE}/dataset:aggregate",
        method="POST",
        body=json.dumps({
            "aggregateBy": [{"dataTypeName": cfg["data_type_name"]}],
            "bucketByTime": {"durationMillis": MILLIS_PER_DAY},
            "startTimeMillis": str(start_ms),
            "endTimeMillis": str(end_ms),
        }),
    )
    if not data:
        return 0, 0

    imported = 0
    skipped = 0
    for bucket in data.get("bucket", []):
        for dataset in bucket.get("dataset", []):
            for point in dataset.get("point", []):
                start = int(point.get("startTimeNanos", 0)) // 1_000_000
                raw_val = None
                for val in point.get("value", []):
                    raw_val = val.get(cfg["value_key"])

                if not raw_val or not start:
                    continue

                if cfg["round"] is not None:
                    raw_val = round(float(raw_val), cfg["round"])
                else:
                    raw_val = int(raw_val)

                external_id = f"{cfg['id_prefix']}-{start}"
                if dedup_by_external_id(
                    supabase, "health_entries", "health-connect", external_id
                ):
                    skipped += 1
                    continue

                if cfg["fingerprint_prefix"] == "ghc-steps":
                    fingerprint = sha256(
                        f"{cfg['fingerprint_prefix']}-{format_date(start)}".encode()
                    ).hexdigest()
                else:
                    fingerprint = sha256(
                        f"{cfg['fingerprint_prefix']}-{start}".encode()
                    ).hexdigest()

                value = {cfg["value_field"]: raw_val}

                upsert_record(
                    supabase,
                    "health_entries",
                    {
                        "entry_type": cfg["entry_type"],
                        "timestamp": format_timestamp(start),
                        "numeric_value": raw_val,
                        "value": value,
                        "source": "health-connect",
                        "external_id": external_id,
                        "tags": cfg["tags"],
                        "metadata": {"import_fingerprint": fingerprint},
                    },
                    "health-connect",
                    external_id,
                )
                imported += 1

    print(f"  {cfg['label']}: {imported} imported, {skipped} skipped")
    return imported, skipped


def sync_steps(creds, supabase, start_ms, end_ms):
    """Sync daily step counts."""
    return sync_aggregate(creds, supabase, start_ms, end_ms, "steps")


def sync_weight(creds, supabase, start_ms, end_ms):
    """Sync weight measurements."""
    return sync_aggregate(creds, supabase, start_ms, end_ms, "weight")


def sync_heart_rate(creds, supabase, start_ms, end_ms):
    """Sync heart rate samples."""
    return sync_aggregate(creds, supabase, start_ms, end_ms, "heart_rate")


def sync_sleep(creds, supabase, start_ms, end_ms):
    """Sync sleep sessions."""
    start_iso = format_timestamp(start_ms)
    end_iso = format_timestamp(end_ms)
    url = f"{FIT_API_BASE}/sessions?startTime={start_iso}&endTime={end_iso}&activityType=72"
    data = _api_get(creds, url)
    if not data:
        return 0, 0

    imported = 0
    skipped = 0
    for session in data.get("session", []):
        start = int(session.get("startTimeMillis", 0))
        end = int(session.get("endTimeMillis", 0))
        if not start or not end:
            continue

        duration_s = int((end - start) / 1000)
        external_id = f"ghc-sleep-{start}"
        if dedup_by_external_id(
            supabase, "health_entries", "health-connect", external_id
        ):
            skipped += 1
            continue

        duration_hours = round(duration_s / 3600, 1)
        fingerprint = sha256(f"ghc-sleep-{start}-{end}".encode()).hexdigest()

        upsert_record(
            supabase,
            "health_entries",
            {
                "entry_type": "sleep",
                "timestamp": format_timestamp(start),
                "numeric_value": duration_hours,
                "duration_s": duration_s,
                "value": {
                    "end_time": format_timestamp(end),
                    "duration_hours": duration_hours,
                    "name": session.get("name", "Sleep"),
                },
                "source": "health-connect",
                "external_id": external_id,
                "tags": ["health-connect", "sleep"],
                "metadata": {"import_fingerprint": fingerprint},
            },
            "health-connect",
            external_id,
        )
        imported += 1

    print(f"  Sleep: {imported} imported, {skipped} skipped")
    return imported, skipped


def sync_exercise(creds, supabase, start_ms, end_ms):
    """Sync exercise sessions."""
    start_iso = format_timestamp(start_ms)
    end_iso = format_timestamp(end_ms)
    url = f"{FIT_API_BASE}/sessions?startTime={start_iso}&endTime={end_iso}"
    data = _api_get(creds, url)
    if not data:
        return 0, 0

    imported = 0
    skipped = 0
    for session in data.get("session", []):
        # Skip sleep sessions (activityType 72)
        if session.get("activityType") == 72:
            continue

        start = int(session.get("startTimeMillis", 0))
        end = int(session.get("endTimeMillis", 0))
        if not start:
            continue

        duration_s = int((end - start) / 1000) if end else None
        external_id = f"ghc-exercise-{start}"
        if dedup_by_external_id(
            supabase, "health_entries", "health-connect", external_id
        ):
            skipped += 1
            continue

        fingerprint = sha256(f"ghc-exercise-{start}".encode()).hexdigest()
        numeric_value = round(duration_s / 60) if duration_s else None

        upsert_record(
            supabase,
            "health_entries",
            {
                "entry_type": "exercise",
                "timestamp": format_timestamp(start),
                "numeric_value": numeric_value,
                "duration_s": duration_s,
                "value": {
                    "name": session.get("name", "Exercise"),
                    "activity_type": session.get("activityType"),
                    "description": session.get("description"),
                },
                "source": "health-connect",
                "external_id": external_id,
                "tags": ["health-connect", "exercise"],
                "metadata": {"import_fingerprint": fingerprint},
            },
            "health-connect",
            external_id,
        )
        imported += 1

    print(f"  Exercise: {imported} imported, {skipped} skipped")
    return imported, skipped


def main():
    parser = argparse.ArgumentParser(description="Alexandria Health Connect Sync")
    parser.add_argument(
        "--auth", action="store_true", help="Run OAuth flow to get credentials"
    )
    parser.add_argument(
        "--days", type=int, default=7, help="Sync last N days (default: 7)"
    )
    parser.add_argument(
        "--all", action="store_true", help="Sync all available data (365 days)"
    )
    args = parser.parse_args()

    # Get OAuth credentials
    creds = get_credentials()
    print("Authenticated successfully.")

    # Connect to Supabase
    supabase = connect_supabase()

    # Time range
    days = 365 if args.all else args.days
    end_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    start_ms = int(
        (datetime.now(tz=timezone.utc) - timedelta(days=days)).timestamp() * 1000
    )

    start_date = format_date(start_ms)
    end_date = format_date(end_ms)
    print(f"\nSyncing {start_date} to {end_date} ({days} days)...")

    total_imported = 0
    total_skipped = 0
    total_processed = 0

    print("\n--- Syncing Steps ---")
    imp, skp = sync_steps(creds, supabase, start_ms, end_ms)
    total_imported += imp
    total_skipped += skp
    total_processed += imp + skp

    print("\n--- Syncing Weight ---")
    imp, skp = sync_weight(creds, supabase, start_ms, end_ms)
    total_imported += imp
    total_skipped += skp
    total_processed += imp + skp

    print("\n--- Syncing Heart Rate ---")
    imp, skp = sync_heart_rate(creds, supabase, start_ms, end_ms)
    total_imported += imp
    total_skipped += skp
    total_processed += imp + skp

    print("\n--- Syncing Sleep ---")
    imp, skp = sync_sleep(creds, supabase, start_ms, end_ms)
    total_imported += imp
    total_skipped += skp
    total_processed += imp + skp

    print("\n--- Syncing Exercise ---")
    imp, skp = sync_exercise(creds, supabase, start_ms, end_ms)
    total_imported += imp
    total_skipped += skp
    total_processed += imp + skp

    print(
        f"\nTotals: {total_imported} imported, {total_skipped} skipped ({total_processed} processed)"
    )

    sync_type = "full" if args.all else "incremental"
    record_sync(
        supabase,
        "health-api",
        sync_type=sync_type,
        processed=total_processed,
        imported=total_imported,
        skipped=total_skipped,
    )

    print("\nDone!")


if __name__ == "__main__":
    main()
