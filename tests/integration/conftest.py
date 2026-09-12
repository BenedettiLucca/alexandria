"""
Configuração e fixtures de teste de integração contra PostgreSQL/PostgREST local do Supabase.
"""

import asyncio
import os
import subprocess
import uuid

import asyncpg
import pytest

from supabase import Client, create_client

LOCAL_DB_URL = os.environ.get(
    "LOCAL_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
LOCAL_POSTGREST_URL = os.environ.get("LOCAL_POSTGREST_URL", "http://127.0.0.1:54321")
LOCAL_KEYS_PATH = (
    "/home/lucca/.local/state/alexandria-sprint-plan/EXECUTION/local-keys.env"
)


def pytest_configure(config):
    """Registra markers personalizados."""
    config.addinivalue_line(
        "markers",
        "integration: marca testes que exigem banco de dados Supabase local ativo",
    )


def _load_credentials() -> dict[str, str]:
    """
    Carrega credenciais de acesso anon e service_role sem expor segredos.
    Prioridades:
    1. Variáveis de ambiente (LOCAL_SERVICE / LOCAL_ANON ou SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY)
    2. Arquivo local-keys.env se existir
    3. Execução de 'supabase status -o env' como fallback dinâmico
    """
    keys: dict[str, str] = {}

    # 1. Variáveis de ambiente
    if os.environ.get("LOCAL_SERVICE"):
        keys["LOCAL_SERVICE"] = os.environ["LOCAL_SERVICE"]
    elif os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        keys["LOCAL_SERVICE"] = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    if os.environ.get("LOCAL_ANON"):
        keys["LOCAL_ANON"] = os.environ["LOCAL_ANON"]
    elif os.environ.get("SUPABASE_ANON_KEY"):
        keys["LOCAL_ANON"] = os.environ["SUPABASE_ANON_KEY"]

    # 2. Arquivo local-keys.env
    if (not keys.get("LOCAL_SERVICE") or not keys.get("LOCAL_ANON")) and os.path.isfile(
        LOCAL_KEYS_PATH
    ):
        try:
            with open(LOCAL_KEYS_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("\"'")
                        if k in ("LOCAL_SERVICE", "LOCAL_ANON") and k not in keys:
                            keys[k] = v
        except OSError:
            pass

    # 3. Fallback via supabase status
    if not keys.get("LOCAL_SERVICE") or not keys.get("LOCAL_ANON"):
        try:
            proc = subprocess.run(
                ["supabase", "status", "-o", "env"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
            if proc.returncode == 0:
                for line in proc.stdout.splitlines():
                    if "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("\"'")
                        if k == "SERVICE_ROLE_KEY" and "LOCAL_SERVICE" not in keys:
                            keys["LOCAL_SERVICE"] = v
                        elif k == "ANON_KEY" and "LOCAL_ANON" not in keys:
                            keys["LOCAL_ANON"] = v
        except (OSError, subprocess.SubprocessError):
            pass

    return keys


@pytest.fixture(scope="session")
def credentials():
    """Retorna credenciais do banco local."""
    creds = _load_credentials()
    if not creds.get("LOCAL_SERVICE"):
        pytest.skip(
            "LOCAL_SERVICE não encontrado no ambiente, local-keys.env ou supabase status."
        )
    return creds


@pytest.fixture(scope="session")
def service_client(credentials) -> Client:
    """Cliente real Supabase com service_role key."""
    return create_client(LOCAL_POSTGREST_URL, credentials["LOCAL_SERVICE"])


@pytest.fixture(scope="session")
def anon_client(credentials) -> Client:
    """Cliente real Supabase com anon key."""
    if not credentials.get("LOCAL_ANON"):
        pytest.skip("LOCAL_ANON não encontrado para testes anon.")
    return create_client(LOCAL_POSTGREST_URL, credentials["LOCAL_ANON"])


@pytest.fixture(scope="session")
def db_url() -> str:
    """URL de conexão direta PostgreSQL."""
    return LOCAL_DB_URL


@pytest.fixture(scope="session")
def run_sql(db_url):
    """Executor síncrono de SQL direto no PostgreSQL via asyncpg."""

    def _execute(query: str, *args):
        async def _run():
            conn = await asyncpg.connect(db_url, timeout=5)
            try:
                return await conn.fetch(query, *args)
            finally:
                await conn.close()

        return asyncio.run(_run())

    return _execute


@pytest.fixture
def auth_user_factory(service_client, credentials):
    """Cria usuários autenticados efêmeros para testes de isolamento de owner."""
    created_users = []

    def _create(email_prefix="user"):
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

    # Limpeza: rows de dominio primeiro (FKs de indexing_outbox/etc seguram
    # auth.users; deletar na ordem errada derruba o backend auth local com
    # segfault no PG 17.6 empacotado pelo CLI — ver ledger D-ENV-PGCRASH).
    for uid in created_users:
        for table in ("indexing_outbox", "health_summaries", "health_entries",
                      "training_logs", "briefs", "memories", "brief_claims",
                      "entity_mentions", "entities", "room_recipes"):
            try:
                service_client.table(table).delete().eq("user_id", uid).execute()
            except Exception:
                pass
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
