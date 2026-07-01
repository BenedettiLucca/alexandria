#!/bin/bash
# ============================================================
# Alexandria — Run all tests
# ============================================================
set -e

echo "=== Python tests (pytest) ==="
python3 -m pytest importers/ -v "$@"

echo ""
echo "=== Deno tests ==="
cd supabase/functions/alexandria && \
SUPABASE_URL=http://localhost:5432 \
SUPABASE_SERVICE_ROLE_KEY=test-key \
LOCAL_SUPABASE_URL=http://localhost:5432 \
LOCAL_SUPABASE_SERVICE_ROLE_KEY=test-key \
MCP_ACCESS_KEY=test \
OPENROUTER_API_KEY=test \
deno test --allow-all --no-check

echo ""
echo "=== All tests passed ==="
