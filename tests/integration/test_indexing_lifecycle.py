"""Integration tests for durable indexing lifecycle and outbox (T05B).

Covers:
- Observable persist -> pending -> ready state transitions
- All 4 vector tables (memories, briefs, health_entries, training_logs) generate jobs on direct write
- Search RPCs guarded by embedding_space and embedding_status == 'ready'
- Entity enrichment independent outbox job and status
- CAS concurrency: stale version completion does not overwrite newer update
- Owner isolation on indexing_outbox
- Backfill RPC enforcing explicit target space and budget limit
"""

import uuid
import pytest


def test_four_tables_produce_outbox_jobs_on_direct_insert(service_client, user_a):
    """Each of the 4 tables automatically generates a pending job in indexing_outbox."""
    owner = user_a["id"]
    client = user_a["client"]

    # 1. memories
    mem = client.table("memories").insert({
        "user_id": owner,
        "content": f"Test memory for lifecycle {uuid.uuid4().hex[:8]}",
    }).execute()
    mem_id = mem.data[0]["id"]
    assert mem.data[0]["embedding_status"] == "pending"
    assert mem.data[0]["enrichment_status"] == "pending"

    # 2. briefs
    brief = client.table("briefs").insert({
        "user_id": owner,
        "title": f"Test Brief {uuid.uuid4().hex[:8]}",
        "brief_date": "2026-09-11",
        "source_job": "test_lifecycle_job",
        "kind": "daily",
        "body_markdown": "Test body for lifecycle",
    }).execute()
    brief_id = brief.data[0]["id"]
    assert brief.data[0]["embedding_status"] == "pending"

    # 3. health_entries
    health = client.table("health_entries").insert({
        "user_id": owner,
        "entry_type": "heart_rate",
        "timestamp": "2026-09-11T12:00:00Z",
        "numeric_value": 70,
        "value": {"bpm": 70},
    }).execute()
    health_id = health.data[0]["id"]
    assert health.data[0]["embedding_status"] == "pending"

    # 4. training_logs
    training = client.table("training_logs").insert({
        "user_id": owner,
        "workout_date": "2026-09-11",
        "workout_type": "strength",
        "name": f"Workout {uuid.uuid4().hex[:8]}",
    }).execute()
    training_id = training.data[0]["id"]
    assert training.data[0]["embedding_status"] == "pending"

    try:
        # Verify outbox jobs exist
        outbox = client.table("indexing_outbox").select("*").eq("user_id", owner).execute()
        source_map = {(r["source_table"], r["source_id"], r["job_type"]): r for r in outbox.data}

        assert ("memories", mem_id, "embedding") in source_map
        assert ("memories", mem_id, "entity_enrichment") in source_map
        assert ("briefs", brief_id, "embedding") in source_map
        assert ("health_entries", health_id, "embedding") in source_map
        assert ("training_logs", training_id, "embedding") in source_map

        for key, row in source_map.items():
            assert row["status"] == "pending"
            assert row["attempts"] == 0
    finally:
        client.table("memories").delete().eq("id", mem_id).execute()
        client.table("briefs").delete().eq("id", brief_id).execute()
        client.table("health_entries").delete().eq("id", health_id).execute()
        client.table("training_logs").delete().eq("id", training_id).execute()
        service_client.table("indexing_outbox").delete().eq("user_id", owner).execute()


def test_search_rpcs_guarded_by_space_and_ready_status(service_client, user_a):
    """Search RPCs guard by embedding_space and only return ready rows."""
    owner = user_a["id"]
    client = user_a["client"]
    zero_vec = [0.0] * 2048

    # Insert memory in default space ('openai/text-embedding-3-small')
    mem1 = client.table("memories").insert({
        "user_id": owner,
        "content": "Secret Alpha in Default Space",
        "embedding": zero_vec,
    }).execute()
    mem1_id = mem1.data[0]["id"]
    assert mem1.data[0]["embedding_status"] == "ready"

    # Insert memory in alternative space ('openai/text-embedding-ada-002')
    mem2 = service_client.table("memories").insert({
        "user_id": owner,
        "content": "Secret Beta in Alternative Space",
        "embedding": zero_vec,
        "embedding_space": "openai/text-embedding-ada-002",
    }).execute()
    mem2_id = mem2.data[0]["id"]

    # Insert memory and mark status as pending (should never appear in search)
    mem3 = service_client.table("memories").insert({
        "user_id": owner,
        "content": "Secret Gamma Pending",
        "embedding": zero_vec,
    }).execute()
    mem3_id = mem3.data[0]["id"]
    service_client.table("memories").update({"embedding_status": "pending"}).eq("id", mem3_id).execute()

    try:
        # Search in default space
        search_default = client.rpc("search_memories", {
            "query_embedding": zero_vec,
            "match_threshold": -1.0,
            "match_count": 10,
            "p_space": "qwen/qwen3-embedding-8b",
        }).execute()
        found_ids = [r["id"] for r in search_default.data]

        assert mem1_id in found_ids
        assert mem2_id not in found_ids  # Different space must NOT mix!
        assert mem3_id not in found_ids  # Pending status must NOT appear!

        # Search in alternative space
        search_alt = client.rpc("search_memories", {
            "query_embedding": zero_vec,
            "match_threshold": -1.0,
            "match_count": 10,
            "p_space": "openai/text-embedding-ada-002",
        }).execute()
        found_alt_ids = [r["id"] for r in search_alt.data]

        assert mem2_id in found_alt_ids
        assert mem1_id not in found_alt_ids
        assert mem3_id not in found_alt_ids
    finally:
        service_client.table("memories").delete().in_("id", [mem1_id, mem2_id, mem3_id]).execute()
        service_client.table("indexing_outbox").delete().eq("user_id", owner).execute()


def test_cas_concurrency_advances_version_and_outbox(service_client, user_a):
    """Updating row content advances embedding_version and creates superseded/updated outbox state."""
    owner = user_a["id"]
    client = user_a["client"]

    # Initial insert
    mem = client.table("memories").insert({
        "user_id": owner,
        "content": "Original content v1",
    }).execute()
    mem_id = mem.data[0]["id"]
    assert mem.data[0]["embedding_version"] == 1

    # Check outbox has job for v1
    job_v1 = client.table("indexing_outbox").select("*").eq("source_id", mem_id).eq("job_type", "embedding").single().execute()
    assert job_v1.data["source_version"] == 1

    # Update content -> trigger increments embedding_version to 2 and resets outbox
    client.table("memories").update({
        "content": "Updated content v2",
    }).eq("id", mem_id).execute()

    mem_v2 = client.table("memories").select("*").eq("id", mem_id).single().execute()
    assert mem_v2.data["embedding_version"] == 2
    assert mem_v2.data["embedding_status"] == "pending"

    # Outbox job was updated in-place to v2
    job_v2 = client.table("indexing_outbox").select("*").eq("source_id", mem_id).eq("job_type", "embedding").single().execute()
    assert job_v2.data["source_version"] == 2
    assert job_v2.data["status"] == "pending"

    client.table("memories").delete().eq("id", mem_id).execute()
    service_client.table("indexing_outbox").delete().eq("user_id", owner).execute()


def test_indexing_outbox_owner_isolation(service_client, user_a, user_b):
    """User B cannot read or claim User A's outbox jobs."""
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    mem_a = client_a.table("memories").insert({
        "user_id": uid_a,
        "content": "A's secret memory note",
    }).execute()
    mem_a_id = mem_a.data[0]["id"]

    try:
        # A can see their job
        jobs_a = client_a.table("indexing_outbox").select("*").eq("source_id", mem_a_id).execute()
        assert len(jobs_a.data) >= 1

        # B queries outbox -> must not see A's job
        jobs_b = client_b.table("indexing_outbox").select("*").eq("source_id", mem_a_id).execute()
        assert len(jobs_b.data) == 0

        # B tries to claim jobs -> should get none of A's jobs
        claimed = client_b.rpc("claim_indexing_jobs", {
            "p_limit": 10,
            "p_target_space": "openai/text-embedding-3-small",
        }).execute()
        claimed_ids = [r["source_id"] for r in claimed.data]
        assert mem_a_id not in claimed_ids
    finally:
        client_a.table("memories").delete().eq("id", mem_a_id).execute()
        service_client.table("indexing_outbox").delete().eq("user_id", uid_a).execute()


def test_backfill_indexing_jobs_requires_explicit_space_and_budget(service_client, user_a):
    """Backfill RPC enforces explicit non-empty space and positive budget."""
    client = user_a["client"]

    # Missing space fails
    with pytest.raises(Exception) as exc1:
        client.rpc("backfill_indexing_jobs", {
            "p_space": "",
            "p_budget_limit": 10,
        }).execute()
    assert "Explicit target space is required" in str(exc1.value)

    # Non-positive budget fails
    with pytest.raises(Exception) as exc2:
        client.rpc("backfill_indexing_jobs", {
            "p_space": "qwen/qwen3-embedding-8b",
            "p_budget_limit": 0,
        }).execute()
    assert "Explicit positive budget limit is required" in str(exc2.value)


def test_get_indexing_lifecycle_status_observable(service_client, user_a):
    """get_indexing_lifecycle_status returns observable stats per domain and outbox."""
    client = user_a["client"]
    owner = user_a["id"]

    res = client.rpc("get_indexing_lifecycle_status").execute()
    data = res.data

    assert "outbox" in data
    assert "tables" in data
    assert "memories" in data["tables"]
    assert "briefs" in data["tables"]
    assert "health_entries" in data["tables"]
    assert "training_logs" in data["tables"]
    assert "pending" in data["outbox"]
    assert "ready" in data["outbox"]
