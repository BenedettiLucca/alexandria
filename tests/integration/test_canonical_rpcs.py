"""
Testes de integração: validação de existência e assinaturas de RPCs canônicos no PostgreSQL/PostgREST.
"""

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration

CANONICAL_RPCS = [
    "get_coverage_transition_report",
    "search_briefs",
    "capture_coverage_snapshot",
    "compute_source_coverage",
    "get_tool_activation_report",
    "publish_lane_heartbeat",
    "search_memories",
    "search_health_entries",
    "upsert_memory",
]


def test_canonical_rpcs_exist_in_pg_proc_and_information_schema(run_sql):
    """Valida se todos os RPCs canônicos existem em pg_proc com suas respectivas assinaturas."""
    rows = run_sql(
        """
        SELECT 
            p.proname,
            pg_get_function_arguments(p.oid) as arguments,
            pg_get_function_result(p.oid) as result_type
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])
        """,
        CANONICAL_RPCS,
    )

    found_names = {r["proname"]: r for r in rows}

    for rpc_name in CANONICAL_RPCS:
        assert rpc_name in found_names, (
            f"RPC '{rpc_name}' não foi encontrado em pg_proc pós-migrations."
        )
        res_type = found_names[rpc_name]["result_type"]
        assert res_type is not None, f"RPC '{rpc_name}' possui tipo de retorno nulo."

    # Validações pontuais de assinatura
    # 1. search_briefs deve receber query_embedding vector e retornar TABLE(...)
    assert "query_embedding" in found_names["search_briefs"]["arguments"]
    assert "TABLE" in found_names["search_briefs"]["result_type"]

    # 2. capture_coverage_snapshot deve retornar integer
    assert found_names["capture_coverage_snapshot"]["result_type"] == "integer"

    # 3. get_coverage_transition_report deve aceitar p_days e retornar TABLE(...)
    assert "p_days" in found_names["get_coverage_transition_report"]["arguments"]
    assert "TABLE" in found_names["get_coverage_transition_report"]["result_type"]


def test_canonical_rpcs_callable_via_postgrest(service_client, run_sql):
    """Valida execução real dos RPCs via cliente PostgREST/Supabase."""
    # 0. capture_coverage_snapshot é fail-closed: exige owner explícito (#41/T17)
    owner_row = run_sql("SELECT id FROM auth.users ORDER BY created_at LIMIT 1")
    owner_id = str(owner_row[0]["id"] if isinstance(owner_row, list) else owner_row["id"])
    assert owner_id, "seed user ausente"
    res0 = service_client.rpc("capture_coverage_snapshot", {
        "p_target_days": 7,
        "p_source_kind": "health",
        "p_producer": "scheduler",
        "p_user_id": owner_id,
        "p_execution_id": "gate-e2e-1",
    }).execute()
    assert isinstance(res0.data, int)

    # Cleanup imediato: snapshot rows poluem outros testes via report default
    run_sql(f"DELETE FROM coverage_snapshots WHERE user_id = '{owner_id}' AND producer = 'scheduler'")

    # Sem owner deve falhar (default-deny)
    with pytest.raises(APIError):
        service_client.rpc("capture_coverage_snapshot", {}).execute()

    # 1. get_coverage_transition_report deve rodar e retornar lista
    res2 = service_client.rpc(
        "get_coverage_transition_report", {"p_days": 30}
    ).execute()
    assert isinstance(res2.data, list)

    # 3. search_briefs com query_embedding 2048d zerado deve executar sem erro
    zero_vec = [0.0] * 2048
    res3 = service_client.rpc(
        "search_briefs",
        {"query_embedding": zero_vec, "match_threshold": 0.5, "match_count": 5},
    ).execute()
    assert isinstance(res3.data, list)


def test_rpc_invalid_payload_fails_with_apierror(service_client):
    """Valida que chamadas de RPC com argumentos/dimensões inválidas falham no PostgreSQL real."""
    # Passando tipo inválido para parâmetro do tipo vetor em search_briefs
    with pytest.raises(APIError) as excinfo:
        service_client.rpc(
            "search_briefs",
            {"query_embedding": "not-a-vector"},
        ).execute()

    # Erro de sintaxe de vetor do pgvector: 22P02
    assert excinfo.value.code == "22P02"
    assert "vector" in excinfo.value.message.lower()
