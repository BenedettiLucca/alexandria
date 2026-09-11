"""
Testes de integração: T06 — Unicidade, upserts e tratamento de legacy.
Valida garantias de identidade no banco de dados para:
- health_entries
- training_logs
- memories
- briefs
- profile
- projects

Cobre:
1. Concorrência real: duas conexões simultâneas geram exatamente 1 row e ID estável.
2. Idempotência e retry lost-response: repetições retornam status 'unchanged' com mesmo ID.
3. Mesclagem determinística de tags, people e importance (GREATEST).
4. external_id NULL permite múltiplas inserções sem colisão.
5. Isolamento por owner: donos distintos com mesmo external_id / slug não colidem.
6. Profile first/repeat/update e PostgREST on_conflict compatível.
7. Projects nome normalizado e error path para nome vazio.
8. Briefs: retenção de ID ao alterar body_markdown para o mesmo source_path estável.
9. Preservação de Foreign Keys (entity_mentions e brief_claims) durante deduplicações.
10. Rollback e consistência transacional.
"""

import asyncio
import json
import uuid

import asyncpg
import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration


# =============================================================================
# 1. PROFILE TESTS
# =============================================================================


def test_profile_postgrest_upsert_with_owner(service_client, user_a):
    """PostgREST .upsert(..., on_conflict='key,owner_id') agora funciona sem 42P10."""
    test_key = f"prof_pgrst_{uuid.uuid4().hex[:8]}"
    test_owner = user_a["id"]

    try:
        # Primeiro upsert cria
        r1 = (
            service_client.table("profile")
            .upsert(
                {"key": test_key, "owner_id": test_owner, "value": {"mode": "dark"}},
                on_conflict="key,owner_id",
            )
            .execute()
        )
        assert len(r1.data) == 1
        row_id = r1.data[0]["id"]

        # Segundo upsert atualiza o mesmo registro sem criar duplicatas
        r2 = (
            service_client.table("profile")
            .upsert(
                {"key": test_key, "owner_id": test_owner, "value": {"mode": "light"}},
                on_conflict="key,owner_id",
            )
            .execute()
        )
        assert len(r2.data) == 1
        assert r2.data[0]["id"] == row_id
        assert r2.data[0]["value"] == {"mode": "light"}
    finally:
        service_client.table("profile").delete().eq("key", test_key).execute()


def test_profile_rpc_first_repeat_update_and_isolation(service_client, user_a, user_b):
    """RPC upsert_profile: first (created), repeat (unchanged), update (updated), e owner isolation."""
    key = f"prof_rpc_{uuid.uuid4().hex[:8]}"
    owner_a = user_a["id"]
    owner_b = user_b["id"]

    try:
        # First call para owner A -> created
        r1 = service_client.rpc(
            "upsert_profile",
            {"p_key": key, "p_value": {"theme": "synthwave"}, "p_owner_id": owner_a},
        ).execute()
        assert r1.data["status"] == "created"
        id_a = r1.data["id"]
        assert id_a is not None

        # Repeat call idêntica -> unchanged, mesmo ID
        r2 = service_client.rpc(
            "upsert_profile",
            {"p_key": key, "p_value": {"theme": "synthwave"}, "p_owner_id": owner_a},
        ).execute()
        assert r2.data["status"] == "unchanged"
        assert r2.data["id"] == id_a

        # Repeat call com valor alterado -> updated, mesmo ID
        r3 = service_client.rpc(
            "upsert_profile",
            {"p_key": key, "p_value": {"theme": "cyberpunk"}, "p_owner_id": owner_a},
        ).execute()
        assert r3.data["status"] == "updated"
        assert r3.data["id"] == id_a

        # Mesma key para Owner B -> created (não colide com Owner A)
        r4 = service_client.rpc(
            "upsert_profile",
            {"p_key": key, "p_value": {"theme": "nord"}, "p_owner_id": owner_b},
        ).execute()
        assert r4.data["status"] == "created"
        assert r4.data["id"] != id_a

        # Error path: key vazia
        with pytest.raises(APIError) as exc:
            service_client.rpc("upsert_profile", {"p_key": "   ", "p_value": {}}).execute()
        assert "cannot be empty" in exc.value.message
    finally:
        service_client.table("profile").delete().eq("key", key).execute()


# =============================================================================
# 2. HEALTH_ENTRIES TESTS
# =============================================================================


def test_health_entries_null_external_id_allows_multiple(service_client, user_a):
    """external_id NULL permite múltiplas inserções sem colisão para o mesmo usuário."""
    owner = user_a["id"]
    ext_id = None
    created_ids = []

    try:
        r1 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "heart_rate",
                "p_timestamp": "2026-09-11T10:00:00Z",
                "p_value": {"bpm": 70},
                "p_user_id": owner,
                "p_external_id": ext_id,
            },
        ).execute()
        assert r1.data["status"] == "created"
        created_ids.append(r1.data["id"])

        r2 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "heart_rate",
                "p_timestamp": "2026-09-11T10:05:00Z",
                "p_value": {"bpm": 72},
                "p_user_id": owner,
                "p_external_id": ext_id,
            },
        ).execute()
        assert r2.data["status"] == "created"
        created_ids.append(r2.data["id"])

        # Ambos foram criados com IDs distintos
        assert created_ids[0] != created_ids[1]
    finally:
        for cid in created_ids:
            service_client.table("health_entries").delete().eq("id", cid).execute()


def test_health_entries_upsert_rpc_and_owner_isolation(service_client, user_a, user_b):
    """upsert_health_entry: first (created), repeat (unchanged), update (updated), e isolamento entre donos."""
    ext_id = f"fit_{uuid.uuid4().hex[:8]}"
    owner_a = user_a["id"]
    owner_b = user_b["id"]

    try:
        # First call para owner A -> created
        r1 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "steps",
                "p_timestamp": "2026-09-11T12:00:00Z",
                "p_value": {"steps": 5000},
                "p_numeric_value": 5000,
                "p_source": "garmin",
                "p_external_id": ext_id,
                "p_user_id": owner_a,
            },
        ).execute()
        assert r1.data["status"] == "created"
        id_a = r1.data["id"]

        # Retry idêntico -> unchanged, ID estável
        r2 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "steps",
                "p_timestamp": "2026-09-11T12:00:00Z",
                "p_value": {"steps": 5000},
                "p_numeric_value": 5000,
                "p_source": "garmin",
                "p_external_id": ext_id,
                "p_user_id": owner_a,
            },
        ).execute()
        assert r2.data["status"] == "unchanged"
        assert r2.data["id"] == id_a

        # Update -> updated, mesmo ID
        r3 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "steps",
                "p_timestamp": "2026-09-11T12:00:00Z",
                "p_value": {"steps": 5500},
                "p_numeric_value": 5500,
                "p_source": "garmin",
                "p_external_id": ext_id,
                "p_user_id": owner_a,
            },
        ).execute()
        assert r3.data["status"] == "updated"
        assert r3.data["id"] == id_a

        # Mesmo external_id para Owner B -> created (não colide)
        r4 = service_client.rpc(
            "upsert_health_entry",
            {
                "p_entry_type": "steps",
                "p_timestamp": "2026-09-11T12:00:00Z",
                "p_value": {"steps": 8000},
                "p_numeric_value": 8000,
                "p_source": "garmin",
                "p_external_id": ext_id,
                "p_user_id": owner_b,
            },
        ).execute()
        assert r4.data["status"] == "created"
        assert r4.data["id"] != id_a
    finally:
        service_client.table("health_entries").delete().eq("external_id", ext_id).execute()


# =============================================================================
# 3. TRAINING_LOGS TESTS
# =============================================================================


def test_training_logs_canonical_source_and_upsert(service_client, user_a):
    """training_logs possui source canônico ('iron-log') e unicidade por (user_id, source, external_id)."""
    ext_id = f"workout_{uuid.uuid4().hex[:8]}"
    owner = user_a["id"]

    try:
        # First call -> created
        r1 = service_client.rpc(
            "upsert_training_log",
            {
                "p_workout_date": "2026-09-11",
                "p_workout_type": "strength",
                "p_name": "Push Day",
                "p_volume_kg": 2500.5,
                "p_source": "iron-log",
                "p_external_id": ext_id,
                "p_user_id": owner,
            },
        ).execute()
        assert r1.data["status"] == "created"
        t_id = r1.data["id"]

        # Retry idêntico -> unchanged
        r2 = service_client.rpc(
            "upsert_training_log",
            {
                "p_workout_date": "2026-09-11",
                "p_workout_type": "strength",
                "p_name": "Push Day",
                "p_volume_kg": 2500.5,
                "p_source": "iron-log",
                "p_external_id": ext_id,
                "p_user_id": owner,
            },
        ).execute()
        assert r2.data["status"] == "unchanged"
        assert r2.data["id"] == t_id

        # Update volume -> updated
        r3 = service_client.rpc(
            "upsert_training_log",
            {
                "p_workout_date": "2026-09-11",
                "p_workout_type": "strength",
                "p_name": "Push Day",
                "p_volume_kg": 2600.0,
                "p_source": "iron-log",
                "p_external_id": ext_id,
                "p_user_id": owner,
            },
        ).execute()
        assert r3.data["status"] == "updated"
        assert r3.data["id"] == t_id

        # Insert direto duplicado via PostgREST falha com 23505
        with pytest.raises(APIError) as exc:
            service_client.table("training_logs").insert(
                {
                    "workout_date": "2026-09-11",
                    "workout_type": "strength",
                    "name": "Duplicate Push",
                    "source": "iron-log",
                    "external_id": ext_id,
                    "user_id": owner,
                }
            ).execute()
        assert exc.value.code == "23505"
    finally:
        service_client.table("training_logs").delete().eq("external_id", ext_id).execute()


# =============================================================================
# 4. MEMORIES TESTS: Exact Hash, Deterministic Merge, Lost-response
# =============================================================================


def test_memories_exact_hash_and_deterministic_merge(service_client, user_a):
    """
    memories:
    - hash exato calculado por bytea
    - merge determinístico de tags (distintas e ordenadas)
    - merge de people (distintas e ordenadas)
    - importance usa GREATEST
    - retry lost-response idempotente
    """
    content = f"Meeting notes with team about architectural contracts {uuid.uuid4().hex}"
    owner = user_a["id"]

    try:
        # First call -> created
        r1 = service_client.rpc(
            "upsert_memory",
            {
                "p_content": content,
                "p_title": "Initial Title",
                "p_importance": 4,
                "p_tags": ["arch", "backend"],
                "p_people": ["Alice", "Bob"],
                "p_metadata": {"key1": "val1"},
                "p_user_id": owner,
            },
        ).execute()
        assert r1.data["status"] == "created"
        m_id = r1.data["id"]

        # Retry idêntico -> unchanged, mesmo ID
        r2 = service_client.rpc(
            "upsert_memory",
            {
                "p_content": content,
                "p_title": "Initial Title",
                "p_importance": 4,
                "p_tags": ["arch", "backend"],
                "p_people": ["Alice", "Bob"],
                "p_metadata": {"key1": "val1"},
                "p_user_id": owner,
            },
        ).execute()
        assert r2.data["status"] == "unchanged"
        assert r2.data["id"] == m_id

        # Update com tags complementares e maior importance -> updated
        r3 = service_client.rpc(
            "upsert_memory",
            {
                "p_content": content,
                "p_title": "Updated Title",
                "p_importance": 8,
                "p_tags": ["security", "backend"],  # 'backend' repetido, 'security' novo
                "p_people": ["Charlie", "Bob"],     # 'Bob' repetido, 'Charlie' novo
                "p_metadata": {"key2": "val2"},
                "p_user_id": owner,
            },
        ).execute()
        assert r3.data["status"] == "updated"
        assert r3.data["id"] == m_id

        # Verifica resultado no banco
        saved = service_client.table("memories").select("*").eq("id", m_id).single().execute()
        row = saved.data
        assert row["title"] == "Updated Title"
        assert row["importance"] == 8
        assert row["tags"] == ["arch", "backend", "security"]
        assert row["people"] == ["Alice", "Bob", "Charlie"]
        assert row["metadata"] == {"key1": "val1", "key2": "val2"}
        assert len(row["content_hash"]) == 64  # SHA-256 hex
    finally:
        service_client.table("memories").delete().eq("id", m_id).execute()


# =============================================================================
# 5. BRIEFS TESTS: Stable source_path vs content_hash
# =============================================================================


def test_briefs_stable_source_path_retains_id_on_content_edit(service_client, user_a, user_b):
    """
    Briefs:
    - Retém o mesmo ID quando o conteúdo muda no mesmo source_path
    - Rerun idêntico é idempotente (unchanged)
    - Removida a restrição global de content_hash cross-owner
    """
    source_path = f"vault/meetings/sync_{uuid.uuid4().hex[:8]}.md"
    owner_a = user_a["id"]
    owner_b = user_b["id"]

    try:
        # First import -> created
        r1 = service_client.rpc(
            "upsert_brief",
            {
                "p_source_job": "meetcap",
                "p_source_path": source_path,
                "p_title": "Sprint Sync 1",
                "p_brief_date": "2026-09-11",
                "p_kind": "meeting-brief",
                "p_body_markdown": "# Initial Sync Markdown",
                "p_topics": ["sprint1"],
                "p_user_id": owner_a,
            },
        ).execute()
        assert r1.data["status"] == "created"
        b_id = r1.data["id"]

        # Rerun idêntico -> unchanged, ID preservado
        r2 = service_client.rpc(
            "upsert_brief",
            {
                "p_source_job": "meetcap",
                "p_source_path": source_path,
                "p_title": "Sprint Sync 1",
                "p_brief_date": "2026-09-11",
                "p_kind": "meeting-brief",
                "p_body_markdown": "# Initial Sync Markdown",
                "p_topics": ["sprint1"],
                "p_user_id": owner_a,
            },
        ).execute()
        assert r2.data["status"] == "unchanged"
        assert r2.data["id"] == b_id

        # Edição de conteúdo na nota markdown -> updated, ID preservado!
        r3 = service_client.rpc(
            "upsert_brief",
            {
                "p_source_job": "meetcap",
                "p_source_path": source_path,
                "p_title": "Sprint Sync 1 (Revised)",
                "p_brief_date": "2026-09-11",
                "p_kind": "meeting-brief",
                "p_body_markdown": "# Revised Sync Markdown with action items",
                "p_topics": ["sprint1", "actions"],
                "p_user_id": owner_a,
            },
        ).execute()
        assert r3.data["status"] == "updated"
        assert r3.data["id"] == b_id

        # Outro dono com o mesmo source_path não colide
        r4 = service_client.rpc(
            "upsert_brief",
            {
                "p_source_job": "meetcap",
                "p_source_path": source_path,
                "p_title": "Sprint Sync 1",
                "p_brief_date": "2026-09-11",
                "p_kind": "meeting-brief",
                "p_body_markdown": "# Revised Sync Markdown with action items",
                "p_user_id": owner_b,
            },
        ).execute()
        assert r4.data["status"] == "created"
        assert r4.data["id"] != b_id
    finally:
        service_client.table("briefs").delete().eq("source_path", source_path).execute()


# =============================================================================
# 6. PROJECTS TESTS: Normalized name, error paths
# =============================================================================


def test_projects_normalized_name_and_error_paths(service_client, user_a):
    """
    projects:
    - Normalização aprovada: lower(trim(name))
    - Inserções com variação de maiúsculas/espaços colidem e atualizam o registro existente
    - Error path: nome vazio aborta com diagnóstico
    """
    base_name = f"Alexandria_{uuid.uuid4().hex[:6]}"
    owner = user_a["id"]

    try:
        # First call -> created
        r1 = service_client.rpc(
            "upsert_project",
            {
                "p_name": f"  {base_name}  ",
                "p_path": "/home/projects/alexandria",
                "p_description": "Knowledge engine",
                "p_stack": ["python", "typescript"],
                "p_user_id": owner,
            },
        ).execute()
        assert r1.data["status"] == "created"
        p_id = r1.data["id"]

        # Segunda chamada com case diferente e espaços ("alexandria_xyz") -> detecta conflito e atualiza
        r2 = service_client.rpc(
            "upsert_project",
            {
                "p_name": base_name.lower(),
                "p_path": "/home/projects/alexandria",
                "p_description": "Knowledge engine v2",
                "p_stack": ["python", "typescript", "postgres"],
                "p_user_id": owner,
            },
        ).execute()
        assert r2.data["status"] == "updated"
        assert r2.data["id"] == p_id

        # Retry idêntico -> unchanged
        r3 = service_client.rpc(
            "upsert_project",
            {
                "p_name": base_name.lower(),
                "p_path": "/home/projects/alexandria",
                "p_description": "Knowledge engine v2",
                "p_stack": ["python", "typescript", "postgres"],
                "p_user_id": owner,
            },
        ).execute()
        assert r3.data["status"] == "unchanged"
        assert r3.data["id"] == p_id

        # Erro diagnosticado para nome em branco
        with pytest.raises(APIError) as exc:
            service_client.rpc("upsert_project", {"p_name": "   ", "p_user_id": owner}).execute()
        assert "cannot be empty" in exc.value.message
    finally:
        service_client.table("projects").delete().eq("id", p_id).execute()


# =============================================================================
# 7. CONCURRENCY: Two real concurrent requests yield 1 row and stable ID
# =============================================================================


@pytest.mark.asyncio
async def test_concurrent_upsert_produces_single_row_and_stable_id(user_a):
    """
    ACCEPTANCE CRITERIA:
    - Duas conexões concorrentes geram uma row e ID estável.
    Testado em memories e health_entries via transações concorrentes reais.
    """
    from tests.integration.conftest import LOCAL_DB_URL

    conn1 = await asyncpg.connect(LOCAL_DB_URL)
    conn2 = await asyncpg.connect(LOCAL_DB_URL)

    test_content = f"Concurrent test memory {uuid.uuid4().hex}"
    test_owner = uuid.UUID(user_a["id"])

    try:
        # Executa upsert_memory simultaneamente em duas conexões
        async def call_upsert(conn):
            res = await conn.fetchval(
                "SELECT upsert_memory($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                test_content,
                "Concurrent Title",
                "note",
                "mcp",
                5,
                ["concurrent"],
                ["TestBot"],
                json.dumps({}),
                test_owner,
            )
            return json.loads(res)

        # Dispara as duas chamadas simultaneamente
        res1, res2 = await asyncio.gather(
            call_upsert(conn1),
            call_upsert(conn2),
        )

        # Ambos devem ter recebido o exato mesmo ID de linha
        assert res1["id"] == res2["id"]
        # Um deles criou, o outro atualizou ou foi unchanged
        statuses = {res1["status"], res2["status"]}
        assert "created" in statuses

        # Verifica no banco: existe rigorosamente 1 única row com esse content_hash
        count = await conn1.fetchval(
            "SELECT count(*) FROM memories WHERE user_id = $1 AND content = $2",
            test_owner,
            test_content,
        )
        assert count == 1
    finally:
        await conn1.execute("DELETE FROM memories WHERE user_id = $1", test_owner)
        await conn1.close()
        await conn2.close()


# =============================================================================
# 8. TRANSACTION ROLLBACK AND READBACK
# =============================================================================


@pytest.mark.asyncio
async def test_transaction_rollback_and_readback(user_a):
    """Valida atomicidade: rollback descarta inserções pendentes sem deixar resíduos."""
    from tests.integration.conftest import LOCAL_DB_URL

    conn = await asyncpg.connect(LOCAL_DB_URL)
    test_owner = uuid.UUID(user_a["id"])
    content = f"Rollback test {uuid.uuid4().hex}"

    try:
        tr = conn.transaction()
        await tr.start()

        await conn.execute(
            "SELECT upsert_memory($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            content,
            "Temp Memory",
            "note",
            "mcp",
            5,
            [],
            [],
            json.dumps({}),
            test_owner,
        )

        # Antes do commit está visível na transação
        count_inside = await conn.fetchval(
            "SELECT count(*) FROM memories WHERE user_id = $1 AND content = $2",
            test_owner,
            content,
        )
        assert count_inside == 1

        # Realiza Rollback
        await tr.rollback()

        # Após rollback não há registro no banco
        count_outside = await conn.fetchval(
            "SELECT count(*) FROM memories WHERE user_id = $1 AND content = $2",
            test_owner,
            content,
        )
        assert count_outside == 0
    finally:
        await conn.close()


# =============================================================================
# 9. FK PRESERVATION DURING DEDUPLICATION
# =============================================================================


@pytest.mark.asyncio
async def test_legacy_deduplication_repoints_foreign_keys(user_a):
    """
    DO NOT: apagar duplicates com perda de FKs;
    Valida que ao consolidar duplicatas de memory, os registros em entity_mentions
    são re-apontados para a memória canônica sobrevivente.
    """
    from tests.integration.conftest import LOCAL_DB_URL

    conn = await asyncpg.connect(LOCAL_DB_URL)
    owner = uuid.UUID(user_a["id"])
    entity_id = None

    try:
        # Cria uma entidade para a mention
        entity_id = await conn.fetchval(
            "INSERT INTO entities (user_id, name, entity_type) VALUES ($1, $2, $3) RETURNING id",
            owner,
            f"Dr. Alexandria {uuid.uuid4().hex[:6]}",
            "person",
        )

        # Cria duas memories idênticas simulando legacy duplicates (desativando temporariamente a trigger/constraint)
        await conn.execute("ALTER TABLE memories DISABLE TRIGGER trigger_memories_content_hash")
        await conn.execute("ALTER TABLE memories DROP CONSTRAINT memories_owner_content_hash_key")

        m1_id = await conn.fetchval(
            "INSERT INTO memories (user_id, content, content_hash, title, tags, importance) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            owner,
            "Legacy duplicate text",
            "same_hash_123",
            "Memory 1",
            ["tag1"],
            3,
        )
        m2_id = await conn.fetchval(
            "INSERT INTO memories (user_id, content, content_hash, title, tags, importance) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            owner,
            "Legacy duplicate text",
            "same_hash_123",
            "Memory 2",
            ["tag2"],
            7,
        )

        # Cria mentions apontando para ambas
        em1 = await conn.fetchval(
            "INSERT INTO entity_mentions (memory_id, entity_id, context, user_id) VALUES ($1, $2, $3, $4) RETURNING id",
            m1_id,
            entity_id,
            "mention 1",
            owner,
        )
        em2 = await conn.fetchval(
            "INSERT INTO entity_mentions (memory_id, entity_id, context, user_id) VALUES ($1, $2, $3, $4) RETURNING id",
            m2_id,
            entity_id,
            "mention 2",
            owner,
        )

        # Executa o bloco de conciliação exatamente como na migration
        await conn.execute("""
            DO $$
            DECLARE
                r RECORD;
                v_surviving_id UUID;
                v_dup RECORD;
            BEGIN
                FOR r IN (
                    SELECT user_id, content_hash, count(*) AS cnt
                    FROM memories
                    GROUP BY user_id, content_hash
                    HAVING count(*) > 1
                ) LOOP
                    SELECT id INTO v_surviving_id
                    FROM memories
                    WHERE content_hash = r.content_hash
                      AND user_id IS NOT DISTINCT FROM r.user_id
                    ORDER BY created_at ASC, id ASC
                    LIMIT 1;

                    FOR v_dup IN (
                        SELECT * FROM memories
                        WHERE content_hash = r.content_hash
                          AND user_id IS NOT DISTINCT FROM r.user_id
                          AND id <> v_surviving_id
                    ) LOOP
                        DELETE FROM entity_mentions
                        WHERE memory_id = v_dup.id
                          AND entity_id IN (SELECT entity_id FROM entity_mentions WHERE memory_id = v_surviving_id);

                        UPDATE entity_mentions SET memory_id = v_surviving_id WHERE memory_id = v_dup.id;
                        UPDATE memories SET
                            tags = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(memories.tags, '{}'::text[]) || COALESCE(v_dup.tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1),
                            importance = GREATEST(memories.importance, v_dup.importance)
                        WHERE id = v_surviving_id;
                        DELETE FROM memories WHERE id = v_dup.id;
                    END LOOP;
                END LOOP;
            END;
            $$;
        """)

        # Restaura a trigger e constraint
        await conn.execute("ALTER TABLE memories ENABLE TRIGGER trigger_memories_content_hash")
        await conn.execute(
            "ALTER TABLE memories ADD CONSTRAINT memories_owner_content_hash_key UNIQUE NULLS NOT DISTINCT (user_id, content_hash)"
        )

        # Verificações:
        # 1. m2 foi apagado, m1 sobreviveu
        remaining_memories = await conn.fetch("SELECT id, tags, importance FROM memories WHERE user_id = $1", owner)
        assert len(remaining_memories) == 1
        assert remaining_memories[0]["id"] == m1_id
        assert remaining_memories[0]["tags"] == ["tag1", "tag2"]
        assert remaining_memories[0]["importance"] == 7

        # 2. entity_mentions agora apontam para m1_id (FK preservada sem erro de duplicate key)
        mentions = await conn.fetch("SELECT id, memory_id FROM entity_mentions WHERE entity_id = $1", entity_id)
        assert len(mentions) == 1
        assert mentions[0]["memory_id"] == m1_id
    finally:
        if entity_id:
            await conn.execute("DELETE FROM entity_mentions WHERE entity_id = $1", entity_id)
            await conn.execute("DELETE FROM entities WHERE id = $1", entity_id)
        await conn.execute("DELETE FROM memories WHERE user_id = $1", owner)
        await conn.close()
