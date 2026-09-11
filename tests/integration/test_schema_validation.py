"""
Testes de integração: validação de schemas, constraints e integridade relacional no PostgreSQL/PostgREST.
"""

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration


def test_profile_insert_without_key_fails(service_client):
    """Valida que inserção na tabela 'profile' sem a coluna obrigatória 'key' falha com not-null constraint."""
    with pytest.raises(APIError) as excinfo:
        service_client.table("profile").insert({"value": {"test": 123}}).execute()

    # Código 23502 = not_null_violation
    assert excinfo.value.code == "23502"
    assert 'column "key"' in excinfo.value.message


def test_health_entries_invalid_entry_type_fails(service_client):
    """Valida que inserção em 'health_entries' com entry_type fora do CHECK constraint é rejeitada."""
    with pytest.raises(APIError) as excinfo:
        service_client.table("health_entries").insert(
            {
                "entry_type": "invalid_unsupported_type",
                "timestamp": "2026-09-11T20:00:00Z",
                "value": {"test": 1},
            }
        ).execute()

    # Código 23514 = check_violation
    assert excinfo.value.code == "23514"
    assert "health_entries_entry_type_check" in excinfo.value.message


def test_sync_log_invalid_source_fails(service_client):
    """Valida que inserção em 'sync_log' com source inválido viola check constraint."""
    with pytest.raises(APIError) as excinfo:
        service_client.table("sync_log").insert(
            {
                "source": "unauthorized_external_source",
                "status": "completed",
                "records_imported": 0,
            }
        ).execute()

    assert excinfo.value.code == "23514"
    assert "sync_log_source_check" in excinfo.value.message
