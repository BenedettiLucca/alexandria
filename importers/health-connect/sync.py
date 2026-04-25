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
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from pathlib import Path

try:
    from supabase import create_client
except ImportError:
    print("pip install supabase")
    sys.exit(1)

# Google Health API data types mapped to Alexandria entry_type
HEALTH_DATA_TYPES = {
    "steps": {
        "endpoint": "steps",
        "alexandria_type": "steps",
        "tags": ["health-connect", "steps"],
    },
    "weight": {
        "endpoint": "weight",
        "alexandria_type": "weight",
        "tags": ["health-connect", "weight"],
    },
    "heart-rate": {
        "endpoint": "heart-rate",
        "alexandria_type": "heart_rate",
        "tags": ["health-connect", "heart-rate"],
    },
    "blood-pressure": {
        "endpoint": "blood-pressure",
        "alexandria_type": "blood_pressure",
        "tags": ["health-connect", "blood-pressure"],
    },
    "active-minutes": {
        "endpoint": "active-minutes",
        "alexandria_type": "exercise",
        "tags": ["health-connect", "activity"],
    },
    "exercise": {
        "endpoint": "exercise",
        "alexandria_type": "exercise",
        "tags": ["health-connect", "exercise"],
    },
    "nutrition": {
        "endpoint": "nutrition",
        "alexandria_type": "nutrition",
        "tags": ["health-connect", "nutrition"],
    },
}


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

    token_path = Path(__file__).parent / "token.json"
    secrets_path = Path(__file__).parent / "client_secret.json"

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


def make_health_request(creds, data_type, start_ms, end_ms):
    """Make a request to the Google Health API."""
    import urllib.request
    import urllib.parse

    # The Google Health API uses the v1 users dataTypes endpoint
    base_url = "https://health.googleapis.com/v4/users/me/dataTypes"

    params = urllib.parse.urlencode({
        "dataTypeName": data_type,
        "startTime": datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat(),
        "endTime": datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat(),
    })

    url = f"{base_url}/{data_type}/dataPoints?{params}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {creds.token}")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  API request failed for {data_type}: {e}")
        return None


def make_aggregate_request(creds, data_type_name, start_ms, end_ms):
    """Aggregate data using the Fitness API (more reliable for some types)."""
    import urllib.request

    url = "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate"
    body = json.dumps({
        "aggregateBy": [{"dataTypeName": data_type_name}],
        "bucketByTime": {"durationMillis": 86400000},  # daily buckets
        "startTimeMillis": str(start_ms),
        "endTimeMillis": str(end_ms),
    }).encode()

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {creds.token}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  Aggregate request failed for {data_type_name}: {e}")
        return None


def get_sleep_sessions(creds, start_ms, end_ms):
    """Get sleep sessions from the Fitness API."""
    import urllib.request

    start_iso = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_iso = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.999Z")

    url = f"https://www.googleapis.com/fitness/v1/users/me/sessions?startTime={start_iso}&endTime={end_iso}&activityType=72"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {creds.token}")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  Sleep session request failed: {e}")
        return None


def dedup(supabase, fingerprint):
    existing = supabase.table("health_entries").select("id").contains(
        "metadata", {"import_fingerprint": fingerprint}
    ).execute()
    return bool(existing.data)


def ms_to_iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


def sync_steps(creds, supabase, start_ms, end_ms):
    """Sync daily step counts."""
    data = make_aggregate_request(creds, "com.google.step_count.delta", start_ms, end_ms)
    if not data:
        return

    imported = 0
    for bucket in data.get("bucket", []):
        for dataset in bucket.get("dataset", []):
            for point in dataset.get("point", []):
                start = int(point.get("startTimeNanos", 0)) // 1_000_000
                count = 0
                for val in point.get("value", []):
                    count = val.get("intVal", 0)

                if not count or not start:
                    continue

                date_str = datetime.fromtimestamp(start / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                fingerprint = sha256(f"ghc-steps-{date_str}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "steps",
                    "timestamp": ms_to_iso(start),
                    "value": {"count": count},
                    "source": "health-connect",
                    "tags": ["health-connect", "steps"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1

    print(f"  Steps: {imported} new entries")


def sync_weight(creds, supabase, start_ms, end_ms):
    """Sync weight measurements."""
    data = make_aggregate_request(creds, "com.google.weight", start_ms, end_ms)
    if not data:
        return

    imported = 0
    for bucket in data.get("bucket", []):
        for dataset in bucket.get("dataset", []):
            for point in dataset.get("point", []):
                start = int(point.get("startTimeNanos", 0)) // 1_000_000
                weight = None
                for val in point.get("value", []):
                    weight = val.get("fpVal")

                if not weight or not start:
                    continue

                fingerprint = sha256(f"ghc-weight-{start}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "weight",
                    "timestamp": ms_to_iso(start),
                    "value": {"weight_kg": round(float(weight), 2)},
                    "source": "health-connect",
                    "tags": ["health-connect", "weight"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1

    print(f"  Weight: {imported} new entries")


def sync_heart_rate(creds, supabase, start_ms, end_ms):
    """Sync heart rate samples."""
    data = make_aggregate_request(creds, "com.google.heart_rate.bpm", start_ms, end_ms)
    if not data:
        return

    imported = 0
    for bucket in data.get("bucket", []):
        for dataset in bucket.get("dataset", []):
            for point in dataset.get("point", []):
                start = int(point.get("startTimeNanos", 0)) // 1_000_000
                bpm = None
                for val in point.get("value", []):
                    bpm = val.get("fpVal")

                if not bpm or not start:
                    continue

                fingerprint = sha256(f"ghc-hr-{start}".encode()).hexdigest()
                if dedup(supabase, fingerprint):
                    continue

                supabase.table("health_entries").insert({
                    "entry_type": "heart_rate",
                    "timestamp": ms_to_iso(start),
                    "value": {"bpm": round(float(bpm))},
                    "source": "health-connect",
                    "tags": ["health-connect", "heart-rate"],
                    "metadata": {"import_fingerprint": fingerprint},
                }).execute()
                imported += 1

    print(f"  Heart rate: {imported} new entries")


def sync_sleep(creds, supabase, start_ms, end_ms):
    """Sync sleep sessions."""
    data = get_sleep_sessions(creds, start_ms, end_ms)
    if not data:
        return

    imported = 0
    for session in data.get("session", []):
        start = int(session.get("startTimeMillis", 0))
        end = int(session.get("endTimeMillis", 0))
        if not start or not end:
            continue

        duration_s = int((end - start) / 1000)
        fingerprint = sha256(f"ghc-sleep-{start}-{end}".encode()).hexdigest()
        if dedup(supabase, fingerprint):
            continue

        supabase.table("health_entries").insert({
            "entry_type": "sleep",
            "timestamp": ms_to_iso(start),
            "duration_s": duration_s,
            "value": {
                "end_time": ms_to_iso(end),
                "duration_hours": round(duration_s / 3600, 1),
                "name": session.get("name", "Sleep"),
            },
            "source": "health-connect",
            "tags": ["health-connect", "sleep"],
            "metadata": {"import_fingerprint": fingerprint},
        }).execute()
        imported += 1

    print(f"  Sleep: {imported} new entries")


def sync_exercise(creds, supabase, start_ms, end_ms):
    """Sync exercise sessions."""
    import urllib.request

    start_iso = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_iso = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.999Z")

    # Get all non-sleep sessions
    url = f"https://www.googleapis.com/fitness/v1/users/me/sessions?startTime={start_iso}&endTime={end_iso}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {creds.token}")

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  Exercise request failed: {e}")
        return

    imported = 0
    for session in data.get("session", []):
        # Skip sleep sessions (activityType 72)
        if session.get("activityType") == 72:
            continue

        start = int(session.get("startTimeMillis", 0))
        end = int(session.get("endTimeMillis", 0))
        if not start:
            continue

        duration_s = int((end - start) / 1000) if end else None
        fingerprint = sha256(f"ghc-exercise-{start}".encode()).hexdigest()
        if dedup(supabase, fingerprint):
            continue

        supabase.table("health_entries").insert({
            "entry_type": "exercise",
            "timestamp": ms_to_iso(start),
            "duration_s": duration_s,
            "value": {
                "name": session.get("name", "Exercise"),
                "activity_type": session.get("activityType"),
                "description": session.get("description"),
            },
            "source": "health-connect",
            "tags": ["health-connect", "exercise"],
            "metadata": {"import_fingerprint": fingerprint},
        }).execute()
        imported += 1

    print(f"  Exercise: {imported} new entries")


def main():
    parser = argparse.ArgumentParser(description="Alexandria Health Connect Sync")
    parser.add_argument("--auth", action="store_true", help="Run OAuth flow to get credentials")
    parser.add_argument("--days", type=int, default=7, help="Sync last N days (default: 7)")
    parser.add_argument("--all", action="store_true", help="Sync all available data (365 days)")
    args = parser.parse_args()

    # Get OAuth credentials
    creds = get_credentials()
    print("Authenticated successfully.")

    # Connect to Supabase
    supabase = connect_supabase()

    # Time range
    days = 365 if args.all else args.days
    end_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    start_ms = int((datetime.now(tz=timezone.utc) - timedelta(days=days)).timestamp() * 1000)

    start_date = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    end_date = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    print(f"\nSyncing {start_date} to {end_date} ({days} days)...")

    print("\n--- Syncing Steps ---")
    sync_steps(creds, supabase, start_ms, end_ms)

    print("\n--- Syncing Weight ---")
    sync_weight(creds, supabase, start_ms, end_ms)

    print("\n--- Syncing Heart Rate ---")
    sync_heart_rate(creds, supabase, start_ms, end_ms)

    print("\n--- Syncing Sleep ---")
    sync_sleep(creds, supabase, start_ms, end_ms)

    print("\n--- Syncing Exercise ---")
    sync_exercise(creds, supabase, start_ms, end_ms)

    print("\nDone!")


if __name__ == "__main__":
    main()
