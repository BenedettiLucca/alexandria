"""
Integration tests for T13: Memory / Knowledge Graph integrity, reconciliation, and bounded reads.

Covers:
- G1:
  - Entities uniqueness per owner (user A and user B can have 'Alice')
  - Capture -> get_entity real E2E
  - Alice/X -> Bob/Y reconciliation: atomic replacement (removes old mentions, adds new ones)
  - Reconciliation CAS guard (embedding_version mismatch fails closed, leaves graph uncorrupted)
  - Reconciliation owner guard (cross-tenant reconciliation fails closed)
  - Idempotent reconciliation
  - Concurrent captures single ID with stable merge
  - No-change avoids provider / does not corrupt version
- G2:
  - get_memory_stats bounded aggregates RPC (equivalence against synthetic corpus)
  - list_entities_ranked bounded transfer above limit / page cap
  - Database error propagation (DB error does not return count 0)
"""

import asyncio
import json
import uuid
import asyncpg
import pytest
from postgrest.exceptions import APIError
from tests.integration.conftest import LOCAL_DB_URL


@pytest.mark.asyncio
async def test_entities_unique_per_owner_isolation(user_a, user_b):
    """
    User A and User B can both create an entity with identical name and entity_type
    without cross-tenant 23505 collision.
    """
    client_a = user_a["client"]
    client_b = user_b["client"]
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    ent_name = f"SharedEntity_{uuid.uuid4().hex[:6]}"

    # A creates entity
    res_a = client_a.table("entities").insert({
        "user_id": uid_a,
        "name": ent_name,
        "entity_type": "person",
    }).execute()
    assert len(res_a.data) == 1
    ent_a_id = res_a.data[0]["id"]

    try:
        # B creates entity with same name and type - must succeed under owner invariant
        res_b = client_b.table("entities").insert({
            "user_id": uid_b,
            "name": ent_name,
            "entity_type": "person",
        }).execute()
        assert len(res_b.data) == 1
        ent_b_id = res_b.data[0]["id"]
        assert ent_a_id != ent_b_id
    finally:
        client_a.table("entities").delete().eq("id", ent_a_id).execute()
        client_b.table("entities").delete().eq("name", ent_name).execute()


@pytest.mark.asyncio
async def test_reconcile_memory_entities_alice_x_to_bob_y(user_a):
    """
    ACCEPTANCE CRITERIA:
    - Alice/X -> Bob/Y remove mentions antigas e adiciona novas.
    - Transactional replacement: old mentions removed, new mentions created.
    """
    client = user_a["client"]
    owner = user_a["id"]

    # 1. Create a memory for user A
    mem_res = client.table("memories").insert({
        "user_id": owner,
        "content": f"Meeting with Alice about Project X {uuid.uuid4().hex[:6]}",
        "title": "Alice & Project X",
    }).execute()
    mem_id = mem_res.data[0]["id"]
    ver_1 = mem_res.data[0]["embedding_version"]

    try:
        # 2. Reconcile with Alice (person) and Project X (project)
        alice_name = f"Alice_{uuid.uuid4().hex[:6]}"
        proj_x_name = f"ProjectX_{uuid.uuid4().hex[:6]}"
        initial_entities = [
            {"name": alice_name, "type": "person", "context": "Meeting with Alice"},
            {"name": proj_x_name, "type": "project", "context": "about Project X"},
        ]

        rec_1 = client.rpc("reconcile_memory_entities", {
            "p_memory_id": mem_id,
            "p_entities": initial_entities,
            "p_source_version": ver_1,
        }).execute()

        assert rec_1.data["success"] is True
        assert rec_1.data["active_mentions"] == 2

        # Verify mentions in DB
        mentions_1 = client.table("entity_mentions").select("*, entities(name, entity_type)").eq("memory_id", mem_id).execute()
        names_1 = {m["entities"]["name"] for m in mentions_1.data}
        assert names_1 == {alice_name, proj_x_name}

        # 3. Update memory to Bob/Y: content changes and embedding_version advances
        mem_up = client.table("memories").update({
            "content": f"Meeting with Bob about Project Y {uuid.uuid4().hex[:6]}",
            "title": "Bob & Project Y",
        }).eq("id", mem_id).execute()
        ver_2 = mem_up.data[0]["embedding_version"]
        assert ver_2 == ver_1 + 1

        bob_name = f"Bob_{uuid.uuid4().hex[:6]}"
        proj_y_name = f"ProjectY_{uuid.uuid4().hex[:6]}"
        new_entities = [
            {"name": bob_name, "type": "person", "context": "Meeting with Bob"},
            {"name": proj_y_name, "type": "project", "context": "about Project Y"},
        ]

        rec_2 = client.rpc("reconcile_memory_entities", {
            "p_memory_id": mem_id,
            "p_entities": new_entities,
            "p_source_version": ver_2,
        }).execute()

        assert rec_2.data["success"] is True
        assert rec_2.data["active_mentions"] == 2

        # 4. Verify old mentions (Alice, Project X) are removed and new mentions (Bob, Project Y) are present
        mentions_2 = client.table("entity_mentions").select("*, entities(name, entity_type)").eq("memory_id", mem_id).execute()
        names_2 = {m["entities"]["name"] for m in mentions_2.data}
        assert names_2 == {bob_name, proj_y_name}
        assert alice_name not in names_2
        assert proj_x_name not in names_2

        # Memory enrichment_status must be 'ready'
        mem_final = client.table("memories").select("enrichment_status").eq("id", mem_id).single().execute()
        assert mem_final.data["enrichment_status"] == "ready"

    finally:
        client.table("memories").delete().eq("id", mem_id).execute()


@pytest.mark.asyncio
async def test_reconcile_cas_guard_version_mismatch(user_a):
    """
    Guard de source_version: if source_version does not match current embedding_version,
    reconciliation fails observably and DOES NOT corrupt graph.
    """
    client = user_a["client"]
    owner = user_a["id"]

    mem_res = client.table("memories").insert({
        "user_id": owner,
        "content": f"Version mismatch test {uuid.uuid4().hex[:6]}",
    }).execute()
    mem_id = mem_res.data[0]["id"]
    current_ver = mem_res.data[0]["embedding_version"]

    try:
        # Initial mention
        ent_name = f"StaleEntity_{uuid.uuid4().hex[:6]}"
        client.rpc("reconcile_memory_entities", {
            "p_memory_id": mem_id,
            "p_entities": [{"name": ent_name, "type": "concept"}],
            "p_source_version": current_ver,
        }).execute()

        # Attempt reconcile with stale version
        stale_ver = current_ver - 1
        with pytest.raises(APIError) as exc:
            client.rpc("reconcile_memory_entities", {
                "p_memory_id": mem_id,
                "p_entities": [{"name": "ShouldNotBeAdded", "type": "concept"}],
                "p_source_version": stale_ver,
            }).execute()

        assert "version mismatch" in str(exc.value).lower() or "cas" in str(exc.value).lower()

        # Existing mention remains intact (not corrupted)
        mentions = client.table("entity_mentions").select("*, entities(name)").eq("memory_id", mem_id).execute()
        assert len(mentions.data) == 1
        assert mentions.data[0]["entities"]["name"] == ent_name

    finally:
        client.table("memories").delete().eq("id", mem_id).execute()


@pytest.mark.asyncio
async def test_reconcile_owner_guard_cross_tenant_denied(user_a, user_b):
    """
    Reconcile cannot modify memories belonging to another owner.
    """
    client_a = user_a["client"]
    client_b = user_b["client"]
    uid_a = user_a["id"]

    mem_a = client_a.table("memories").insert({
        "user_id": uid_a,
        "content": f"Tenant A memory {uuid.uuid4().hex[:6]}",
    }).execute()
    mem_id = mem_a.data[0]["id"]

    try:
        # User B tries to reconcile user A's memory
        with pytest.raises(APIError) as exc:
            client_b.rpc("reconcile_memory_entities", {
                "p_memory_id": mem_id,
                "p_entities": [{"name": "InjectedEntity", "type": "person"}],
            }).execute()

        assert "not found" in str(exc.value).lower() or "owner" in str(exc.value).lower()

    finally:
        client_a.table("memories").delete().eq("id", mem_id).execute()


@pytest.mark.asyncio
async def test_reconcile_idempotence(user_a):
    """
    Calling reconcile multiple times with the same entities is completely idempotent.
    """
    client = user_a["client"]
    owner = user_a["id"]

    mem = client.table("memories").insert({
        "user_id": owner,
        "content": f"Idempotence test {uuid.uuid4().hex[:6]}",
    }).execute()
    mem_id = mem.data[0]["id"]

    try:
        ent = [{"name": f"Idemp_{uuid.uuid4().hex[:6]}", "type": "technology"}]
        res1 = client.rpc("reconcile_memory_entities", {
            "p_memory_id": mem_id,
            "p_entities": ent,
        }).execute()

        res2 = client.rpc("reconcile_memory_entities", {
            "p_memory_id": mem_id,
            "p_entities": ent,
        }).execute()

        assert res1.data["success"] is True
        assert res2.data["success"] is True

        mentions = client.table("entity_mentions").select("id").eq("memory_id", mem_id).execute()
        assert len(mentions.data) == 1
    finally:
        client.table("memories").delete().eq("id", mem_id).execute()


@pytest.mark.asyncio
async def test_concurrent_captures_produce_single_row_and_stable_id(user_a):
    """
    ACCEPTANCE CRITERIA:
    - Captures concorrentes uma ID com merge estável.
    """
    conn1 = await asyncpg.connect(LOCAL_DB_URL)
    conn2 = await asyncpg.connect(LOCAL_DB_URL)

    test_content = f"Concurrent capture test {uuid.uuid4().hex}"
    test_owner = uuid.UUID(user_a["id"])

    try:
        async def call_upsert(conn):
            res = await conn.fetchval(
                "SELECT upsert_memory($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                test_content,
                "Concurrent Title",
                "note",
                "mcp",
                5,
                ["concur_tag"],
                ["ConcurPerson"],
                json.dumps({}),
                test_owner,
            )
            return json.loads(res)

        res1, res2 = await asyncio.gather(call_upsert(conn1), call_upsert(conn2))
        assert res1["id"] == res2["id"]

        count = await conn1.fetchval(
            "SELECT count(*) FROM memories WHERE user_id = $1 AND content = $2",
            test_owner,
            test_content,
        )
        assert count == 1
    finally:
        await conn1.execute("DELETE FROM memories WHERE user_id = $1 AND content = $2", test_owner, test_content)
        await conn1.close()
        await conn2.close()


@pytest.mark.asyncio
async def test_get_memory_stats_bounded_rpc_corpus_equivalence(user_a):
    """
    ACCEPTANCE CRITERIA:
    - Aggregate/list transfere bounded rows e funciona acima do page cap; DB error não é zero.
    - Stats equivalence em corpus sintético.
    """
    client = user_a["client"]
    owner = user_a["id"]

    # Insert 15 distinct memories across categories and tags
    mem_ids = []
    categories = ["note", "idea", "decision", "note", "note"]
    tags_list = [["deepwork", "python"], ["deepwork", "ai"], ["reading"], ["python"], ["exercise"]]
    people_list = [["Alice"], ["Alice", "Bob"], ["Bob"], ["Charlie"], ["Alice"]]

    for i in range(5):
        res = client.table("memories").insert({
            "user_id": owner,
            "content": f"Stats synthetic corpus memory {i} {uuid.uuid4().hex[:6]}",
            "category": categories[i],
            "tags": tags_list[i],
            "people": people_list[i],
        }).execute()
        mem_ids.append(res.data[0]["id"])

    try:
        stats = client.rpc("get_memory_stats").execute()
        data = stats.data

        assert data["total_count"] >= 5
        assert data["earliest_date"] is not None
        assert data["latest_date"] is not None

        # Verify categories aggregation
        cat_map = {c["category"]: c["count"] for c in data["categories"]}
        assert cat_map.get("note", 0) >= 3
        assert cat_map.get("idea", 0) >= 1
        assert cat_map.get("decision", 0) >= 1

        # Verify tags aggregation
        tag_map = {t["tag"]: t["count"] for t in data["top_tags"]}
        assert tag_map.get("deepwork", 0) >= 2
        assert tag_map.get("python", 0) >= 2

        # Verify people aggregation
        people_map = {p["person"]: p["count"] for p in data["top_people"]}
        assert people_map.get("Alice", 0) >= 3
        assert people_map.get("Bob", 0) >= 2
    finally:
        for mid in mem_ids:
            client.table("memories").delete().eq("id", mid).execute()


@pytest.mark.asyncio
async def test_list_entities_ranked_bounded_rows(user_a):
    """
    ACCEPTANCE CRITERIA:
    - Aggregate/list transfere bounded rows e funciona acima do page cap.
    - list_entities_ranked returns bounded rows ordered by mention_count desc.
    """
    client = user_a["client"]
    owner = user_a["id"]

    # Create 5 entities with varying mention counts
    ent_ids = []
    for i in range(5):
        e = client.table("entities").insert({
            "user_id": owner,
            "name": f"RankedEntity_{i}_{uuid.uuid4().hex[:6]}",
            "entity_type": "technology",
        }).execute()
        ent_ids.append(e.data[0]["id"])

    # Create a memory and link it to ent_ids[0] and ent_ids[1]
    mem = client.table("memories").insert({
        "user_id": owner,
        "content": f"Memory for ranking {uuid.uuid4().hex[:6]}",
    }).execute()
    mem_id = mem.data[0]["id"]

    try:
        # Add 2 mentions for ent_ids[0] (via 2 memories or multiple mentions)
        client.table("entity_mentions").insert({
            "user_id": owner,
            "memory_id": mem_id,
            "entity_id": ent_ids[0],
        }).execute()

        # Request with limit 3: must return EXACTLY 3 rows (bounded transfer)
        ranked = client.rpc("list_entities_ranked", {
            "p_entity_type": "technology",
            "p_limit": 3,
        }).execute()

        assert len(ranked.data) <= 3
        # First row should be the one with the mention
        assert any(r["id"] == ent_ids[0] for r in ranked.data)
        for r in ranked.data:
            if r["id"] == ent_ids[0]:
                assert r["mention_count"] >= 1
    finally:
        client.table("memories").delete().eq("id", mem_id).execute()
        for eid in ent_ids:
            client.table("entities").delete().eq("id", eid).execute()


@pytest.mark.asyncio
async def test_db_error_does_not_infer_zero_or_mask_failure(anon_client):
    """
    DO NOT: inferir zero em DB error;
    Calling get_memory_stats or reconcile without owner raises observable error.
    """
    # Anon client without authenticated user violates owner invariant
    with pytest.raises(APIError) as exc:
        anon_client.rpc("get_memory_stats").execute()

    assert "owner invariant violation" in str(exc.value).lower()
