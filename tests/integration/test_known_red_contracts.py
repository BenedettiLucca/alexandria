"""
Testes de integração: contratos conhecidamente quebrados contra o PostgreSQL real (Known-RED).
Estes testes documentam bugs de domínio conhecidos e auditados nas issues do projeto (#37 e #48).
Conforme a regra do harness: NÃO corrigir os bugs de domínio nesta tarefa, mas sim documentá-los e prová-los.
"""

import uuid

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration


@pytest.mark.xfail(
    strict=True,
    raises=APIError,
    reason="Known-RED issue #48: set_profile usa onConflict incompatível com UNIQUE indexes parciais do schema",
)
def test_issue_48_profile_upsert_on_conflict_contract(service_client):
    """
    Issue #48:
    A tabela 'profile' possui índices únicos parciais (WHERE owner_id IS NOT NULL e WHERE owner_id IS NULL).
    O comando PostgREST upsert com `on_conflict='key'` ou `on_conflict='key,owner_id'`
    falha com código 42P10 ('there is no unique or exclusion constraint matching the ON CONFLICT specification').
    """
    test_key = f"upsert_test_{uuid.uuid4().hex[:8]}"
    # Este upsert tenta ON CONFLICT (key), o que o PostgreSQL rejeita pois só há partial index
    service_client.table("profile").upsert(
        {"key": test_key, "value": {"test": 1}},
        on_conflict="key",
    ).execute()


def test_issue_37_health_entries_external_id_unique_constraint(service_client):
    """
    Issue #37:
    'external_id' é documentado como chave externa de deduplicação e idempotência.
    Com a migração de identidade (T06), a unicidade é garantida e o segundo insert falha com 23505.
    """
    test_ext_id = f"ext_{uuid.uuid4().hex[:8]}"
    row_data = {
        "entry_type": "steps",
        "timestamp": "2026-09-11T12:00:00Z",
        "value": {"steps": 1000},
        "external_id": test_ext_id,
    }

    try:
        service_client.table("health_entries").insert(row_data).execute()

        with pytest.raises(APIError) as excinfo:
            service_client.table("health_entries").insert(row_data).execute()

        assert excinfo.value.code == "23505"
    finally:
        service_client.table("health_entries").delete().eq(
            "external_id", test_ext_id
        ).execute()
