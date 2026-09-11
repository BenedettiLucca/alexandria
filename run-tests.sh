#!/usr/bin/env bash
# ============================================================
# Alexandria — Run all tests & gate checks
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "=== 1. Python unit tests (importers/) ==="
python3 -m pytest importers/ -v "$@"

echo ""
echo "=== 2. Python integration tests (tests/integration/) ==="
# Se PostgREST não estiver respondendo na porta 54321, aciona scripts/local-db-reset.sh
if ! curl -s -f -o /dev/null "http://127.0.0.1:54321/rest/v1/"; then
  if [ -x "scripts/local-db-reset.sh" ]; then
    echo "PostgREST não respondeu na porta 54321. Inicializando stack local..."
    bash scripts/local-db-reset.sh
  fi
fi
python3 -m pytest tests/integration -v "$@"

echo ""
echo "=== 3. Deno tests & Typed Gates ==="
if ! command -v deno >/dev/null 2>&1; then
  echo "SKIPPED: 'deno' não foi encontrado no PATH. Reportando skip explícito conforme AGENTS.md."
else
  (
    cd "$ROOT_DIR/supabase/functions/alexandria"

    echo "--- 3.1 Deno type check (deno check index.ts) ---"
    deno check index.ts

    echo "--- 3.2 Deno typed test (sem --no-check em tools/telemetry.test.ts) ---"
    SUPABASE_URL=http://localhost:5432 \
    SUPABASE_SERVICE_ROLE_KEY=test-key \
    LOCAL_SUPABASE_URL=http://localhost:5432 \
    LOCAL_SUPABASE_SERVICE_ROLE_KEY=test-key \
    MCP_ACCESS_KEY=test \
    OPENROUTER_API_KEY=test \
    deno test --allow-all tools/telemetry.test.ts

    echo "--- 3.3 Deno unit suite (existente) ---"
    SUPABASE_URL=http://localhost:5432 \
    SUPABASE_SERVICE_ROLE_KEY=test-key \
    LOCAL_SUPABASE_URL=http://localhost:5432 \
    LOCAL_SUPABASE_SERVICE_ROLE_KEY=test-key \
    MCP_ACCESS_KEY=test \
    OPENROUTER_API_KEY=test \
    deno test --allow-all --no-check
  )
fi

echo ""
echo "=== All tests and gates passed successfully ==="
