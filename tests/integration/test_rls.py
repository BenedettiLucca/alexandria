"""
Testes de integração: validação de Row Level Security (RLS) entre service_role e anon key.
"""

import uuid

import pytest

pytestmark = pytest.mark.integration


def test_sync_log_rls_blocks_anon_access(service_client, anon_client):
    """
    Valida que tabelas com política exclusiva de service_role (como sync_log)
    são invisíveis para requisições usando anon key.
    """
    test_id = str(uuid.uuid4())
    # Inserção como service_role
    insert_res = (
        service_client.table("sync_log")
        .insert(
            {
                "id": test_id,
                "source": "health-connect",
                "status": "completed",
                "records_imported": 0,
            }
        )
        .execute()
    )
    assert len(insert_res.data) == 1

    try:
        # service_role lê a linha normalmente
        service_res = (
            service_client.table("sync_log").select("*").eq("id", test_id).execute()
        )
        assert len(service_res.data) == 1

        # anon key NÃO tem acesso de leitura por RLS
        anon_res = anon_client.table("sync_log").select("*").eq("id", test_id).execute()
        assert len(anon_res.data) == 0, (
            "Anon key não deveria conseguir ler registros restritos ao service_role"
        )
    finally:
        service_client.table("sync_log").delete().eq("id", test_id).execute()


def test_profile_user_scoped_rls_blocks_anon_access(service_client, anon_client):
    """
    Valida que perfis associados a um owner_id específico (auth.uid)
    NÃO podem ser lidos por clientes anônimos (anon key).
    """
    user_email = f"test_rls_{uuid.uuid4().hex[:8]}@example.com"
    user = service_client.auth.admin.create_user(
        {"email": user_email, "password": "Password123!", "email_confirm": True}
    )
    uid = user.user.id
    test_key = f"scoped_key_{uuid.uuid4().hex[:8]}"

    try:
        # Inserir profile vinculado ao owner_id
        service_client.table("profile").insert(
            {"key": test_key, "owner_id": uid, "value": {"secret": "data"}}
        ).execute()

        # service_role consegue ler
        service_read = (
            service_client.table("profile").select("*").eq("key", test_key).execute()
        )
        assert len(service_read.data) == 1

        # anon NÃO consegue ler
        anon_read = (
            anon_client.table("profile").select("*").eq("key", test_key).execute()
        )
        assert len(anon_read.data) == 0, (
            "Anon key não deve ler perfis com owner_id definido de outro usuário"
        )
    finally:
        service_client.table("profile").delete().eq("key", test_key).execute()
        service_client.auth.admin.delete_user(uid)


def test_profile_null_owner_design_behavior(service_client, anon_client):
    """
    Documentação e validação de design:
    Na migration 20260429160331_alexandria_schema.sql, a política 'users_read_own_profile' é:
      USING (((auth.uid() = owner_id) OR (owner_id IS NULL) OR (auth.role() = 'service_role'::text)))

    Portanto, registros de perfil legado/sistema com owner_id IS NULL são legíveis
    por anon por design. Este teste documenta essa semântica e valida que anon
    não pode efetuar update/delete em dados do sistema.
    """
    test_key = f"system_key_{uuid.uuid4().hex[:8]}"
    service_client.table("profile").insert(
        {"key": test_key, "owner_id": None, "value": {"system_default": True}}
    ).execute()

    try:
        # service lê normalmente
        s_res = (
            service_client.table("profile").select("*").eq("key", test_key).execute()
        )
        assert len(s_res.data) == 1

        # anon lê por design pois owner_id IS NULL
        a_res = anon_client.table("profile").select("*").eq("key", test_key).execute()
        assert len(a_res.data) == 1

        # anon NÃO pode deletar o perfil do sistema
        anon_client.table("profile").delete().eq("key", test_key).execute()
        check_res = (
            service_client.table("profile").select("*").eq("key", test_key).execute()
        )
        assert len(check_res.data) == 1, (
            "Anon key não deve ter permissão para deletar perfil de sistema"
        )
    finally:
        service_client.table("profile").delete().eq("key", test_key).execute()
