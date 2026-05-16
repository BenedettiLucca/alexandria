#!/bin/bash
# ============================================================
# Alexandria — Run all tests
# ============================================================
set -e

echo "=== Schema drift check ==="
python3 scripts/check_schema_drift.py

echo "=== Python tests (pytest) ==="
python3 -m pytest importers/ -v "$@"

echo ""
echo "=== Deno tests ==="
deno test supabase/functions/alexandria/lib.test.ts --allow-read --allow-env

echo ""
echo "=== All tests passed ==="
