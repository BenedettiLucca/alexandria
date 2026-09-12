"""
Integration tests for Health Core and Daily Summary Matrix (T10).
Verifies:
1. Steps aggregation: numeric only, value only, both (counts only once per row).
2. Sleep aggregation: 8h, value-only, duration_s, wake attribution.
3. Absence of data is preserved as NULL (not converted to 0).
4. Heart rate (avg/min/max/samples) and weight (latest of the day).
5. Exercise types uses domain type (name, exercise_type, type), NOT tags.
6. Session timezone independence (different session tz does not shift civil day).
7. DST transitions (half-open bounds derived from IANA timezone).
8. Owner isolation on compute/refresh (no cross-owner writes).
"""

import asyncio
from datetime import date
import uuid
import asyncpg
import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration


def test_steps_aggregation_matrix(service_client, user_a):
    """
    Steps numeric/value/both count exactly once per row.
    Never sum numeric_value + value->>'count' on the same record.
    """
    uid = user_a["id"]
    client = user_a["client"]
    target_date = "2026-07-10"

    # Row 1: numeric_value only
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "steps",
        "timestamp": f"{target_date}T08:00:00Z",
        "numeric_value": 5000,
        "value": {},
    }).execute()

    # Row 2: value count only
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "steps",
        "timestamp": f"{target_date}T12:00:00Z",
        "numeric_value": None,
        "value": {"count": 3000},
    }).execute()

    # Row 3: BOTH numeric_value and value count present
    # Must count 4000 once, NOT 8000!
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "steps",
        "timestamp": f"{target_date}T18:00:00Z",
        "numeric_value": 4000,
        "value": {"count": 4000},
    }).execute()

    try:
        res = client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res.data is not None
        # 5000 + 3000 + 4000 = 12000
        assert res.data["steps_total"] == 12000, (
            f"Expected steps_total 12000, got {res.data['steps_total']}"
        )

        sum_row = (
            client.table("health_summaries")
            .select("*")
            .eq("date", target_date)
            .single()
            .execute()
        )
        assert sum_row.data["steps_total"] == 12000
    finally:
        service_client.table("health_entries").delete().eq("user_id", uid).execute()
        service_client.table("health_summaries").delete().eq("user_id", uid).execute()


def test_sleep_aggregation_matrix(service_client, user_a):
    """
    Sleep aggregation handles numeric_value (hours), value-only (duration_hours/duration_h),
    and duration_s (seconds) without duplication.
    """
    uid = user_a["id"]
    client = user_a["client"]
    target_date = "2026-07-11"

    # Row 1: 8h via duration_s = 28800
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "sleep",
        "timestamp": f"{target_date}T06:00:00Z",
        "duration_s": 28800,
        "numeric_value": 8.0,
        "value": {"duration_hours": 8.0},
    }).execute()

    # Row 2: Afternoon nap value-only 1.5h
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "sleep",
        "timestamp": f"{target_date}T14:00:00Z",
        "duration_s": None,
        "numeric_value": None,
        "value": {"duration_hours": 1.5},
    }).execute()

    try:
        res = client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res.data is not None
        # 8.0 + 1.5 = 9.5 hours
        assert float(res.data["sleep_hours"]) == 9.5

        sum_row = (
            client.table("health_summaries")
            .select("*")
            .eq("date", target_date)
            .single()
            .execute()
        )
        assert float(sum_row.data["sleep_total_hours"]) == 9.5
        assert sum_row.data["sleep_sessions"] == 2
    finally:
        service_client.table("health_entries").delete().eq("user_id", uid).execute()
        service_client.table("health_summaries").delete().eq("user_id", uid).execute()


def test_absence_not_converted_to_zero(service_client, user_a):
    """
    DO NOT convert absence of data into zero.
    When a user has no sleep or steps recorded on a day,
    the summary fields must be NULL, not 0 or 0.00.
    """
    uid = user_a["id"]
    client = user_a["client"]
    target_date = "2026-07-12"

    try:
        res = client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res.data is not None
        assert res.data["sleep_hours"] is None
        assert res.data["steps_total"] is None
        assert res.data["hr_avg"] is None
        assert res.data["exercise_minutes"] is None
        assert res.data["training_volume_kg"] is None

        sum_row = (
            client.table("health_summaries")
            .select("*")
            .eq("date", target_date)
            .single()
            .execute()
        )
        assert sum_row.data["sleep_total_hours"] is None
        assert sum_row.data["steps_total"] is None
        assert sum_row.data["hr_avg"] is None
        assert sum_row.data["weight_kg"] is None
        assert sum_row.data["exercise_total_minutes"] is None
        assert sum_row.data["training_volume_kg"] is None
    finally:
        service_client.table("health_summaries").delete().eq("user_id", uid).execute()


def test_weight_and_heart_rate(service_client, user_a):
    """
    Weight picks the latest reading of the day.
    Heart rate computes avg, min, max, samples.
    """
    uid = user_a["id"]
    client = user_a["client"]
    target_date = "2026-07-13"

    # Weight morning 81.5 kg
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "weight",
        "timestamp": f"{target_date}T07:00:00Z",
        "numeric_value": 81.5,
        "value": {"weight_kg": 81.5},
    }).execute()

    # Weight evening 80.8 kg (latest reading)
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "weight",
        "timestamp": f"{target_date}T20:00:00Z",
        "numeric_value": 80.8,
        "value": {"weight_kg": 80.8},
    }).execute()

    # HR sample 1: 60 bpm
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "heart_rate",
        "timestamp": f"{target_date}T08:00:00Z",
        "numeric_value": 60,
        "value": {"bpm": 60},
    }).execute()

    # HR sample 2: 120 bpm
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "heart_rate",
        "timestamp": f"{target_date}T12:00:00Z",
        "numeric_value": 120,
        "value": {"bpm": 120},
    }).execute()

    try:
        res = client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res.data is not None

        sum_row = (
            client.table("health_summaries")
            .select("*")
            .eq("date", target_date)
            .single()
            .execute()
        )
        assert float(sum_row.data["weight_kg"]) == 80.8
        assert float(sum_row.data["hr_avg"]) == 90.0
        assert float(sum_row.data["hr_min"]) == 60.0
        assert float(sum_row.data["hr_max"]) == 120.0
        assert sum_row.data["hr_samples"] == 2
    finally:
        service_client.table("health_entries").delete().eq("user_id", uid).execute()
        service_client.table("health_summaries").delete().eq("user_id", uid).execute()


def test_exercise_domain_types_not_tags(service_client, user_a):
    """
    Exercise types must use domain types from value->>'name' or value->>'exercise_type',
    NEVER tags.
    """
    uid = user_a["id"]
    client = user_a["client"]
    target_date = "2026-07-14"

    # Exercise 1: Running (tag is "health-connect", "raw")
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "exercise",
        "timestamp": f"{target_date}T09:00:00Z",
        "duration_s": 1800,
        "value": {"name": "Running", "duration_min": 30},
        "tags": ["health-connect", "raw", "sync-v1"],
    }).execute()

    # Exercise 2: Cycling (tag is "manual")
    client.table("health_entries").insert({
        "user_id": uid,
        "entry_type": "exercise",
        "timestamp": f"{target_date}T16:00:00Z",
        "duration_s": 2700,
        "value": {"exercise_type": "Cycling", "duration_min": 45},
        "tags": ["manual", "device-garmin"],
    }).execute()

    try:
        res = client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res.data is not None

        sum_row = (
            client.table("health_summaries")
            .select("*")
            .eq("date", target_date)
            .single()
            .execute()
        )
        assert sum_row.data["exercise_count"] == 2
        assert float(sum_row.data["exercise_total_minutes"]) == 75.0
        # Must contain ["Cycling", "Running"], and NOT contain tags like "health-connect" or "raw"
        assert set(sum_row.data["exercise_types"]) == {"Cycling", "Running"}
        assert "health-connect" not in sum_row.data["exercise_types"]
        assert "raw" not in sum_row.data["exercise_types"]
    finally:
        service_client.table("health_entries").delete().eq("user_id", uid).execute()
        service_client.table("health_summaries").delete().eq("user_id", uid).execute()


def test_session_timezone_independence(db_url, user_a):
    """
    DO NOT use session timezone.
    Running compute_daily_summary under differing session timezones
    must NOT shift the civil day calculation.
    """
    uid = user_a["id"]
    target_date = "2026-07-15"

    async def _run():
        conn = await asyncpg.connect(db_url)
        try:
            # Insert a record at 23:30 UTC for the target date
            await conn.execute(
                """
                INSERT INTO health_entries (user_id, entry_type, timestamp, numeric_value, value)
                VALUES ($1, 'steps', '2026-07-15T23:30:00Z'::timestamptz, 5000, '{}'::jsonb);
                """,
                uuid.UUID(uid),
            )

            # Run with session timezone UTC
            await conn.execute("SET TIME ZONE 'UTC';")
            row_utc = await conn.fetchrow(
                "SELECT compute_daily_summary('2026-07-15'::date, $1::uuid, 'UTC') AS res;",
                uuid.UUID(uid),
            )

            # Run with session timezone Asia/Tokyo (+09:00, where 23:30 UTC is next day 08:30)
            await conn.execute("SET TIME ZONE 'Asia/Tokyo';")
            row_tokyo = await conn.fetchrow(
                "SELECT compute_daily_summary('2026-07-15'::date, $1::uuid, 'UTC') AS res;",
                uuid.UUID(uid),
            )

            # Run with session timezone America/Sao_Paulo (-03:00)
            await conn.execute("SET TIME ZONE 'America/Sao_Paulo';")
            row_sp = await conn.fetchrow(
                "SELECT compute_daily_summary('2026-07-15'::date, $1::uuid, 'UTC') AS res;",
                uuid.UUID(uid),
            )

            import json
            val_utc = json.loads(row_utc["res"])["steps_total"]
            val_tokyo = json.loads(row_tokyo["res"])["steps_total"]
            val_sp = json.loads(row_sp["res"])["steps_total"]

            assert val_utc == 5000
            assert val_tokyo == 5000, f"Session timezone Asia/Tokyo altered summary: {val_tokyo}"
            assert val_sp == 5000, f"Session timezone America/Sao_Paulo altered summary: {val_sp}"
        finally:
            await conn.execute("DELETE FROM health_entries WHERE user_id = $1;", uuid.UUID(uid))
            await conn.execute("DELETE FROM health_summaries WHERE user_id = $1;", uuid.UUID(uid))
            await conn.close()

    asyncio.run(_run())


def test_dst_transition_bounds(db_url, user_a):
    """
    Derives UTC half-open bounds [day_start, day_end) from IANA timezone.
    Validates that on DST transition days (e.g. America/New_York spring forward),
    entries within the local civil day are correctly captured.
    """
    uid = user_a["id"]
    # 2026-03-08 is US Spring Forward: 02:00 -> 03:00 (23-hour day)
    target_date = "2026-03-08"

    async def _run():
        conn = await asyncpg.connect(db_url)
        try:
            # America/New_York:
            # Day starts at 2026-03-08 00:00:00 EST = 2026-03-08 05:00:00 UTC
            # Day ends at 2026-03-09 00:00:00 EDT = 2026-03-09 04:00:00 UTC (23h interval)
            await conn.execute(
                """
                INSERT INTO health_entries (user_id, entry_type, timestamp, numeric_value, value)
                VALUES
                    ($1, 'steps', '2026-03-08T05:05:00Z'::timestamptz, 1000, '{}'::jsonb),
                    ($1, 'steps', '2026-03-09T03:55:00Z'::timestamptz, 2000, '{}'::jsonb),
                    ($1, 'steps', '2026-03-09T04:05:00Z'::timestamptz, 9999, '{}'::jsonb);
                """,
                uuid.UUID(uid),
            )

            row = await conn.fetchrow(
                "SELECT compute_daily_summary('2026-03-08'::date, $1::uuid, 'America/New_York') AS res;",
                uuid.UUID(uid),
            )
            import json
            res = json.loads(row["res"])
            # Only 1000 + 2000 = 3000 should fall within 2026-03-08 America/New_York.
            # 9999 is at 04:05:00 UTC, which is 00:05:00 EDT on 2026-03-09 (next day).
            assert res["steps_total"] == 3000, (
                f"Expected 3000 steps on DST transition day, got {res['steps_total']}"
            )
        finally:
            await conn.execute("DELETE FROM health_entries WHERE user_id = $1;", uuid.UUID(uid))
            await conn.execute("DELETE FROM health_summaries WHERE user_id = $1;", uuid.UUID(uid))
            await conn.close()

    asyncio.run(_run())


def test_owner_isolation_and_refresh_no_cross_write(user_a, user_b, service_client, anon_client):
    """
    Refresh is owner-scoped and cannot write to or corrupt another owner's summary.
    Calling unauthenticated compute_daily_summary without explicit p_user_id fails.
    """
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]
    target_date = "2026-07-16"

    # User A has 6000 steps
    client_a.table("health_entries").insert({
        "user_id": uid_a,
        "entry_type": "steps",
        "timestamp": f"{target_date}T10:00:00Z",
        "numeric_value": 6000,
        "value": {},
    }).execute()

    # User B has 9000 steps
    client_b.table("health_entries").insert({
        "user_id": uid_b,
        "entry_type": "steps",
        "timestamp": f"{target_date}T11:00:00Z",
        "numeric_value": 9000,
        "value": {},
    }).execute()

    try:
        # User A refreshes
        res_a = client_a.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res_a.data["steps_total"] == 6000
        assert res_a.data["user_id"] == uid_a

        # User B refreshes
        res_b = client_b.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res_b.data["steps_total"] == 9000
        assert res_b.data["user_id"] == uid_b

        # Verify User A cannot see or alter User B's summary
        sum_a = client_a.table("health_summaries").select("*").eq("date", target_date).execute()
        assert len(sum_a.data) == 1
        assert sum_a.data[0]["user_id"] == uid_a
        assert sum_a.data[0]["steps_total"] == 6000

        # Unauthenticated call without p_user_id must fail fail-closed
        with pytest.raises(APIError) as exc:
            anon_client.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert "Owner invariant violation" in str(exc.value)
    finally:
        service_client.table("health_entries").delete().in_("user_id", [uid_a, uid_b]).execute()
        service_client.table("health_summaries").delete().in_("user_id", [uid_a, uid_b]).execute()
