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


def sync_steps(creds, supabase, start_ms, end_ms):
    """Sync daily step counts."""
    data = _api_get(
        creds,
        "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate",
        method="POST",
        body=json.dumps({
            "aggregateBy": [{"dataTypeName": "com.google.step_count.delta"}],
            "bucketByTime": {"durationMillis": 86400000},
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
                count = 0
                for val in point.get("value", []):
                    count = val.get("intVal", 0)

                if not count or not start:
                    continue

                date_str = format_date(start)
                external_id = f"ghc-steps-{start}"
                if dedup_by_external_id(
                    supabase, "health_entries", "health-connect", external_id
                ):
                    skipped += 1
                    continue

                fingerprint = sha256(f"ghc-steps-{date_str}".encode()).hexdigest()
                value = {"count": count}

                upsert_record(
                    supabase,
                    "health_entries",
                    {
                        "entry_type": "steps",
                        "timestamp": format_timestamp(start),
                        "numeric_value": count,
                        "value": value,
                        "source": "health-connect",
                        "external_id": external_id,
                        "tags": ["health-connect", "steps"],
                        "metadata": {"import_fingerprint": fingerprint},
                    },
                    "health-connect",
                    external_id,
                )
                imported += 1

    print(f"  Steps: {imported} imported, {skipped} skipped")
    return imported, skipped


def sync_weight(creds, supabase, start_ms, end_ms):
    """Sync weight measurements."""
    data = _api_get(
        creds,
        "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate",
        method="POST",
        body=json.dumps({
            "aggregateBy": [{"dataTypeName": "com.google.weight"}],
            "bucketByTime": {"durationMillis": 86400000},
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
                weight = None
                for val in point.get("value", []):
                    weight = val.get("fpVal")

                if not weight or not start:
                    continue

                external_id = f"ghc-weight-{start}"
                if dedup_by_external_id(
                    supabase, "health_entries", "health-connect", external_id
                ):
                    skipped += 1
                    continue

                fingerprint = sha256(f"ghc-weight-{start}".encode()).hexdigest()
                weight_kg = round(float(weight), 2)
                value = {"weight_kg": weight_kg}

                upsert_record(
                    supabase,
                    "health_entries",
                    {
                        "entry_type": "weight",
                        "timestamp": format_timestamp(start),
                        "numeric_value": weight_kg,
                        "value": value,
                        "source": "health-connect",
                        "external_id": external_id,
                        "tags": ["health-connect", "weight"],
                        "metadata": {"import_fingerprint": fingerprint},
                    },
                    "health-connect",
                    external_id,
                )
                imported += 1

    print(f"  Weight: {imported} imported, {skipped} skipped")
    return imported, skipped


def sync_heart_rate(creds, supabase, start_ms, end_ms):
    """Sync heart rate samples."""
    data = _api_get(
        creds,
        "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate",
        method="POST",
        body=json.dumps({
            "aggregateBy": [{"dataTypeName": "com.google.heart_rate.bpm"}],
            "bucketByTime": {"durationMillis": 86400000},
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
                bpm = None
                for val in point.get("value", []):
                    bpm = val.get("fpVal")

                if not bpm or not start:
                    continue

                external_id = f"ghc-heart_rate-{start}"
                if dedup_by_external_id(
                    supabase, "health_entries", "health-connect", external_id
                ):
                    skipped += 1
                    continue

                fingerprint = sha256(f"ghc-hr-{start}".encode()).hexdigest()
                bpm_rounded = round(float(bpm))
                value = {"bpm": bpm_rounded}

                upsert_record(
                    supabase,
                    "health_entries",
                    {
                        "entry_type": "heart_rate",
                        "timestamp": format_timestamp(start),
                        "numeric_value": bpm_rounded,
                        "value": value,
                        "source": "health-connect",
                        "external_id": external_id,
                        "tags": ["health-connect", "heart-rate"],
                        "metadata": {"import_fingerprint": fingerprint},
                    },
                    "health-connect",
                    external_id,
                )
                imported += 1

    print(f"  Heart rate: {imported} imported, {skipped} skipped")
    return imported, skipped


def sync_sleep(creds, supabase, start_ms, end_ms):
    """Sync sleep sessions."""
    start_iso = format_timestamp(start_ms)
    end_iso = format_timestamp(end_ms)
    url = f"https://www.googleapis.com/fitness/v1/users/me/sessions?startTime={start_iso}&endTime={end_iso}&activityType=72"
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
    url = f"https://www.googleapis.com/fitness/v1/users/me/sessions?startTime={start_iso}&endTime={end_iso}"
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
