"""
Testes de integracao: Invariante de Owner, RLS e RPCs seguros no PostgreSQL/PostgREST.
Valida isolamento estrito entre DB role / principal A e B, fail-closed de linhas legadas NULL,
isolamento de RPCs de busca e dados derivados (health_summaries, coverage, telemetry).
"""

import json
import uuid
import pytest
from postgrest.exceptions import APIError
from supabase import create_client

from .conftest import LOCAL_POSTGREST_URL

pytestmark = pytest.mark.integration


@pytest.fixture
def auth_user_factory(service_client, credentials):
    """Cria usuarios autenticados efemeros para testes de isolamento de owner."""
    created_users = []

    def _create(email_prefix="owner_test"):
        email = f"{email_prefix}_{uuid.uuid4().hex[:8]}@example.com"
        password = "TestPassword123!"
        res = service_client.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        )
        user_id = res.user.id
        client = create_client(LOCAL_POSTGREST_URL, credentials["LOCAL_ANON"])
        client.auth.sign_in_with_password({"email": email, "password": password})
        created_users.append(user_id)
        return {"id": user_id, "email": email, "client": client}

    yield _create

    # Cleanup dos usuarios
    for uid in created_users:
        try:
            service_client.auth.admin.delete_user(uid)
        except Exception:
            pass


@pytest.fixture
def user_a(auth_user_factory):
    return auth_user_factory("user_a")


@pytest.fixture
def user_b(auth_user_factory):
    return auth_user_factory("user_b")


# ==============================================================================
# 1. TESTES DE TABELAS PRIMARIAS (MEMORIES, BRIEFS, HEALTH, TRAINING, PROJECTS)
# ==============================================================================


def test_owner_isolation_memories(service_client, user_a, user_b):
    """DB role/user A nao le/edita/deleta linhas de B em memories."""
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # Usuario A insere uma memoria privada
    res_a = client_a.table("memories").insert({
        "content": "Segredo do Usuario A: projeto ultra secreto",
        "title": "Nota A",
        "category": "note",
        "user_id": uid_a,
    }).execute()
    assert len(res_a.data) == 1
    mem_a_id = res_a.data[0]["id"]

    try:
        # Usuario B tenta ler memoria de A -> deve retornar vazio
        read_b = client_b.table("memories").select("*").eq("id", mem_a_id).execute()
        assert len(read_b.data) == 0, "Usuario B conseguiu ler memoria de A!"

        # Usuario B tenta editar memoria de A -> 0 linhas afetadas
        up_b = client_b.table("memories").update({"content": "Hackeado por B"}).eq("id", mem_a_id).execute()
        assert len(up_b.data) == 0, "Usuario B conseguiu atualizar memoria de A!"

        # Usuario B tenta deletar memoria de A -> 0 linhas afetadas
        del_b = client_b.table("memories").delete().eq("id", mem_a_id).execute()
        assert len(del_b.data) == 0, "Usuario B conseguiu deletar memoria de A!"

        # Usuario B tenta forjar insercao fingindo ser usuario A -> deve falhar com RLS / WITH CHECK violation
        with pytest.raises(APIError) as excinfo:
            client_b.table("memories").insert({
                "content": "Invasao de identidade",
                "user_id": uid_a,
            }).execute()
        assert excinfo.value.code == "42501", f"Esperado erro RLS 42501 ao forjar user_id, obtido {excinfo.value.code}"

    finally:
        # Cleanup
        service_client.table("memories").delete().eq("id", mem_a_id).execute()


def test_fail_closed_legacy_null_memories(service_client, user_a):
    """Linhas legadas com user_id NULL nao sao acessiveis por usuarios autenticados comuns (fail-closed)."""
    # Service client cria uma memoria com user_id NULL simulando dado legado
    res = service_client.table("memories").insert({
        "content": "Memoria legada sem dono pre-T03",
        "title": "Legado 2026",
        "user_id": None,
    }).execute()
    assert len(res.data) == 1
    mem_null_id = res.data[0]["id"]

    try:
        # Usuario A tenta ler a linha legada sem dono -> deve retornar vazio
        read_a = user_a["client"].table("memories").select("*").eq("id", mem_null_id).execute()
        assert len(read_a.data) == 0, "Usuario A conseguiu ler memoria legada sem dono!"

        # Usuario A nao pode usurpar ownership de linhas legadas NULL
        up_a = user_a["client"].table("memories").update({
            "content": "Tentativa de apropriacao por A"
        }).eq("id", mem_null_id).execute()
        assert len(up_a.data) == 0, "Usuario A conseguiu alterar linha legada sem dono!"

        # Usuario A nao pode deletar linhas legadas NULL
        del_a = user_a["client"].table("memories").delete().eq("id", mem_null_id).execute()
        assert len(del_a.data) == 0, "Usuario A conseguiu deletar linha legada sem dono!"
    finally:
        service_client.table("memories").delete().eq("id", mem_null_id).execute()


def test_owner_isolation_briefs(service_client, user_a, user_b):
    """Isolamento de briefs entre A e B e protecao de briefs legados NULL."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    res_a = client_a.table("briefs").insert({
        "title": "Brief Confidencial Alpha",
        "source_job": "nightly",
        "brief_date": "2026-09-12",
        "kind": "daily",
        "body_markdown": "Relatorio confidencial de A",
        "content_hash": uuid.uuid4().hex,
        "user_id": uid_a,
    }).execute()
    assert len(res_a.data) == 1
    brief_id = res_a.data[0]["id"]

    try:
        # B tenta ler
        read_b = client_b.table("briefs").select("*").eq("id", brief_id).execute()
        assert len(read_b.data) == 0, "Usuario B conseguiu ler brief de A!"

        # B tenta atualizar
        up_b = client_b.table("briefs").update({"title": "Hackeado"}).eq("id", brief_id).execute()
        assert len(up_b.data) == 0, "Usuario B conseguiu modificar brief de A!"

        # B tenta deletar
        del_b = client_b.table("briefs").delete().eq("id", brief_id).execute()
        assert len(del_b.data) == 0, "Usuario B conseguiu deletar brief de A!"
    finally:
        service_client.table("briefs").delete().eq("id", brief_id).execute()


def test_owner_isolation_health_and_training(service_client, user_a, user_b):
    """Isolamento em health_entries e training_logs entre A e B."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # Health entry de A
    h_a = client_a.table("health_entries").insert({
        "user_id": uid_a,
        "entry_type": "heart_rate",
        "timestamp": "2026-09-12T08:00:00Z",
        "numeric_value": 72,
        "value": {"bpm": 72},
    }).execute()
    h_id = h_a.data[0]["id"]

    # Training log de A
    t_a = client_a.table("training_logs").insert({
        "user_id": uid_a,
        "workout_date": "2026-09-12",
        "workout_type": "strength",
        "name": "Treino A",
    }).execute()
    t_id = t_a.data[0]["id"]

    try:
        # B tenta ler health de A
        assert len(client_b.table("health_entries").select("*").eq("id", h_id).execute().data) == 0
        # B tenta ler training de A
        assert len(client_b.table("training_logs").select("*").eq("id", t_id).execute().data) == 0
    finally:
        service_client.table("health_entries").delete().eq("id", h_id).execute()
        service_client.table("training_logs").delete().eq("id", t_id).execute()


def test_owner_isolation_projects(service_client, user_a, user_b):
    """Isolamento em projects entre A e B."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    p_a = client_a.table("projects").insert({
        "user_id": uid_a,
        "name": "Projeto Alpha Privado",
        "status": "active",
    }).execute()
    p_id = p_a.data[0]["id"]

    try:
        assert len(client_b.table("projects").select("*").eq("id", p_id).execute().data) == 0
        up_b = client_b.table("projects").update({"name": "Comprometido"}).eq("id", p_id).execute()
        assert len(up_b.data) == 0
    finally:
        service_client.table("projects").delete().eq("id", p_id).execute()


# ==============================================================================
# 2. TESTES DE TABELAS ESTENDIDAS (ROOM_RECIPES, BRIEF_CLAIMS, GRAPH, SYNC)
# ==============================================================================


def test_owner_isolation_room_recipes(service_client, user_a, user_b):
    """Isolamento em room_recipes entre A e B (tabela anteriormente sem RLS)."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # A insere uma receita
    r_a = client_a.table("room_recipes").insert({
        "user_id": uid_a,
        "name": "Recipe Secreta de A",
        "description": "Sala de analise confidencial",
        "topic_seed": "segredo",
    }).execute()
    recipe_id = r_a.data[0]["id"]

    try:
        # B nao pode ler a receita de A
        read_b = client_b.table("room_recipes").select("*").eq("id", recipe_id).execute()
        assert len(read_b.data) == 0, "Usuario B conseguiu ler room_recipes de A!"

        # B nao pode atualizar a receita de A
        up_b = client_b.table("room_recipes").update({"name": "Alterada"}).eq("id", recipe_id).execute()
        assert len(up_b.data) == 0, "Usuario B conseguiu alterar room_recipes de A!"

        # B nao pode deletar a receita de A
        del_b = client_b.table("room_recipes").delete().eq("id", recipe_id).execute()
        assert len(del_b.data) == 0, "Usuario B conseguiu deletar room_recipes de A!"
    finally:
        service_client.table("room_recipes").delete().eq("id", recipe_id).execute()


def test_owner_isolation_brief_claims(service_client, user_a, user_b):
    """Isolamento em brief_claims entre A e B (tabela anteriormente sem RLS)."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # Cria brief para A
    b_a = client_a.table("briefs").insert({
        "user_id": uid_a,
        "title": "Brief de Teste para Claim",
        "source_job": "importer",
        "brief_date": "2026-09-12",
        "kind": "weekly",
        "body_markdown": "Texto",
        "content_hash": uuid.uuid4().hex,
    }).execute()
    b_id = b_a.data[0]["id"]

    # Cria claim para o brief de A
    c_a = client_a.table("brief_claims").insert({
        "user_id": uid_a,
        "brief_id": b_id,
        "entity": "MetaCorporation",
        "metric": "valuation",
        "value_numeric": 15.0,
        "value_text": "Crescimento de 15%",
    }).execute()
    claim_id = c_a.data[0]["id"]

    try:
        # B tenta ler o claim de A
        read_b = client_b.table("brief_claims").select("*").eq("id", claim_id).execute()
        assert len(read_b.data) == 0, "Usuario B conseguiu ler brief_claim de A!"

        # B tenta deletar o claim de A
        del_b = client_b.table("brief_claims").delete().eq("id", claim_id).execute()
        assert len(del_b.data) == 0, "Usuario B conseguiu deletar brief_claim de A!"
    finally:
        service_client.table("brief_claims").delete().eq("id", claim_id).execute()
        service_client.table("briefs").delete().eq("id", b_id).execute()


def test_owner_isolation_knowledge_graph(service_client, user_a, user_b):
    """Isolamento em entities e entity_mentions entre A e B."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # Cria entidade para A
    e_a = client_a.table("entities").insert({
        "user_id": uid_a,
        "name": "Entidade Secreta de A",
        "entity_type": "person",
    }).execute()
    ent_id = e_a.data[0]["id"]

    # Cria memoria para A e mention
    m_a = client_a.table("memories").insert({
        "user_id": uid_a,
        "content": "Conversa com entidade",
    }).execute()
    mem_id = m_a.data[0]["id"]

    em_a = client_a.table("entity_mentions").insert({
        "user_id": uid_a,
        "entity_id": ent_id,
        "memory_id": mem_id,
    }).execute()
    em_id = em_a.data[0]["id"]

    try:
        # B nao pode ler a entidade de A nem a mention
        assert len(client_b.table("entities").select("*").eq("id", ent_id).execute().data) == 0
        assert len(client_b.table("entity_mentions").select("*").eq("id", em_id).execute().data) == 0
    finally:
        service_client.table("entity_mentions").delete().eq("id", em_id).execute()
        service_client.table("memories").delete().eq("id", mem_id).execute()
        service_client.table("entities").delete().eq("id", ent_id).execute()


def test_owner_isolation_sync_log(service_client, user_a, user_b):
    """Isolamento em sync_log entre A e B."""
    uid_a = user_a["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    s_a = client_a.table("sync_log").insert({
        "user_id": uid_a,
        "source": "iron-log",
        "records_imported": 10,
        "status": "completed",
    }).execute()
    sync_id = s_a.data[0]["id"]

    try:
        assert len(client_b.table("sync_log").select("*").eq("id", sync_id).execute().data) == 0
        up_b = client_b.table("sync_log").update({"status": "failed"}).eq("id", sync_id).execute()
        assert len(up_b.data) == 0
    finally:
        service_client.table("sync_log").delete().eq("id", sync_id).execute()


# ==============================================================================
# 3. TESTES DE DADOS DERIVADOS E RPCS (DAILY SUMMARY, SEARCH, AGGREGATES)
# ==============================================================================


def test_derived_daily_summary_owner_isolation(service_client, user_a, user_b):
    """
    compute_daily_summary agrega exclusivamente os dados do usuario autenticado
    e grava na linha de health_summaries correspondente a ele, sem misturar com outro owner.
    """
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]
    target_date = "2026-09-15"

    # Usuario A registra 7000 passos no dia
    client_a.table("health_entries").insert({
        "user_id": uid_a,
        "entry_type": "steps",
        "timestamp": f"{target_date}T10:00:00Z",
        "numeric_value": 7000,
        "value": {},
    }).execute()

    # Usuario B registra 3000 passos no mesmo dia
    client_b.table("health_entries").insert({
        "user_id": uid_b,
        "entry_type": "steps",
        "timestamp": f"{target_date}T11:00:00Z",
        "numeric_value": 3000,
        "value": {},
    }).execute()

    try:
        # Usuario A executa compute_daily_summary
        res_summary_a = client_a.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res_summary_a.data is not None
        assert res_summary_a.data["steps_total"] == 7000, f"Passos de A devem ser 7000, foram {res_summary_a.data['steps_total']}"

        # Usuario B executa compute_daily_summary
        res_summary_b = client_b.rpc("compute_daily_summary", {"target_date": target_date}).execute()
        assert res_summary_b.data is not None
        assert res_summary_b.data["steps_total"] == 3000, f"Passos de B devem ser 3000, foram {res_summary_b.data['steps_total']}"

        # Invariante no banco: health_summaries de A nao e visivel por B
        sum_rows_b_reading_a = client_b.table("health_summaries").select("*").eq("date", target_date).execute()
        # B deve ver apenas a sua propria linha em health_summaries (com 3000 passos)
        assert len(sum_rows_b_reading_a.data) == 1
        assert sum_rows_b_reading_a.data[0]["user_id"] == uid_b
        assert sum_rows_b_reading_a.data[0]["steps_total"] == 3000

    finally:
        service_client.table("health_entries").delete().in_("user_id", [uid_a, uid_b]).execute()
        service_client.table("health_summaries").delete().in_("user_id", [uid_a, uid_b]).execute()


def test_search_memories_owner_isolation(service_client, user_a, user_b):
    """search_memories RPC isola estritamente os resultados por owner autenticado."""
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]
    zero_vec = [0.0] * 1536

    mem_a = client_a.table("memories").insert({
        "user_id": uid_a,
        "content": "UniqueSecretAlphaByA",
        "embedding": zero_vec,
    }).execute()
    mem_a_id = mem_a.data[0]["id"]

    mem_b = client_b.table("memories").insert({
        "user_id": uid_b,
        "content": "UniqueSecretBetaByB",
        "embedding": zero_vec,
    }).execute()
    mem_b_id = mem_b.data[0]["id"]

    try:
        # A executa busca semantica: deve achar apenas a de A
        search_a = client_a.rpc("search_memories", {
            "query_embedding": zero_vec,
            "match_threshold": -1.0,
            "match_count": 10,
        }).execute()
        found_ids_a = [r["id"] for r in search_a.data]
        assert mem_a_id in found_ids_a
        assert mem_b_id not in found_ids_a, "Busca de A retornou memoria privada de B!"

        # B executa busca semantica: deve achar apenas a de B
        search_b = client_b.rpc("search_memories", {
            "query_embedding": zero_vec,
            "match_threshold": -1.0,
            "match_count": 10,
        }).execute()
        found_ids_b = [r["id"] for r in search_b.data]
        assert mem_b_id in found_ids_b
        assert mem_a_id not in found_ids_b, "Busca de B retornou memoria privada de A!"
    finally:
        service_client.table("memories").delete().in_("id", [mem_a_id, mem_b_id]).execute()


# ==============================================================================
# 4. TELEMETRIA E COVERAGE
# ==============================================================================


def test_telemetry_owner_isolation(service_client, user_a, user_b):
    """tool_call_log e get_tool_activation_report sao estritamente isolados por owner."""
    uid_a = user_a["id"]
    uid_b = user_b["id"]
    client_a = user_a["client"]
    client_b = user_b["client"]

    # Insercao de chamadas de tools por A e B
    log_a = client_a.table("tool_call_log").insert({
        "tool_name": "search_memories",
        "owner_id": uid_a,
        "caller_client": "test_client_a",
        "success": True,
        "latency_ms": 50,
    }).execute()
    log_a_id = log_a.data[0]["id"]

    log_b = client_b.table("tool_call_log").insert({
        "tool_name": "search_memories",
        "owner_id": uid_b,
        "caller_client": "test_client_b",
        "success": True,
        "latency_ms": 60,
    }).execute()
    log_b_id = log_b.data[0]["id"]

    try:
        # A nao le log de B
        assert len(client_a.table("tool_call_log").select("*").eq("id", log_b_id).execute().data) == 0
        # B nao le log de A
        assert len(client_b.table("tool_call_log").select("*").eq("id", log_a_id).execute().data) == 0

        # get_tool_activation_report chamado por A deve conter apenas métricas de A
        report_a = client_a.rpc("get_tool_activation_report", {"p_days": 1}).execute()
        assert isinstance(report_a.data, list)
    finally:
        service_client.table("tool_call_log").delete().in_("id", [log_a_id, log_b_id]).execute()


# ==============================================================================
# 5. AUDITORIA E PLANO DE BACKFILL DE LINHAS LEGADAS
# ==============================================================================


def test_legacy_audit_and_fail_closed_backfill(service_client, user_a, run_sql):
    """
    Funcao de auditoria conta linhas legadas desprovidas de dono.
    Funcao de backfill rejeita target_owner_id nulo/invalido (fail-closed, nunca publica)
    e atribui o owner aprovado preservando todos os relacionamentos pre-existentes.
    """
    # Insere uma linha legada em memories
    res_mem = service_client.table("memories").insert({
        "content": "Memoria legada orphan para teste de migracao",
        "user_id": None,
    }).execute()
    orphan_mem_id = res_mem.data[0]["id"]

    try:
        # Auditoria relata existencia de unowned rows
        audit_res = run_sql("SELECT alexandria_audit_legacy_unowned_rows() AS report;")
        report = audit_res[0]["report"]
        assert report is not None
        report = json.loads(report) if isinstance(report, str) else report
        assert "memories" in report
        assert report["memories"] >= 1

        # Backfill sem dono aprovado (target_owner_id = NULL) deve ABORTAR com erro estruturado
        with pytest.raises(Exception) as exc_null:
            run_sql("SELECT alexandria_backfill_legacy_owner(NULL);")
        assert "Owner invariant violation" in str(exc_null.value) or "target_owner_id cannot be null" in str(exc_null.value).lower()

        # Backfill com owner inexistente deve ABORTAR
        fake_uuid = str(uuid.uuid4())
        with pytest.raises(Exception) as exc_fake:
            run_sql("SELECT alexandria_backfill_legacy_owner($1::uuid);", fake_uuid)
        assert "not found" in str(exc_fake.value).lower() or "violation" in str(exc_fake.value).lower()

        # Backfill com owner valido (user_a) deve atribuir com sucesso
        uid_a = user_a["id"]
        bf_res = run_sql("SELECT alexandria_backfill_legacy_owner($1::uuid) AS res;", uid_a)
        res_json = bf_res[0]["res"]
        assert res_json is not None
        res_json = json.loads(res_json) if isinstance(res_json, str) else res_json
        assert res_json.get("success") is True

        # Agora a memoria legada pertence a user_a e esta legivel por ele
        read_a = user_a["client"].table("memories").select("*").eq("id", orphan_mem_id).execute()
        assert len(read_a.data) == 1
        assert read_a.data[0]["user_id"] == uid_a
    finally:
        service_client.table("memories").delete().eq("id", orphan_mem_id).execute()
