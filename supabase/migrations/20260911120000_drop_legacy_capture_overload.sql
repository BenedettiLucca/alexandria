-- Migration: 20260911120000_drop_legacy_capture_overload.sql
-- Core (pós-T17): o overload legado de capture_coverage_snapshot (4 args,
-- sem execution identity) ambigua o PostgREST (PGRST203) e nao tem mais
-- callers: o runtime (coverage-capture/index.ts) e os testes usam a completa.
-- O overload legado roteia owner via auth.uid()/service role implicito;
-- o novo fail-closed exige p_owner_id/p_execution_id/p_cadence_key.

DROP FUNCTION IF EXISTS public.capture_coverage_snapshot(integer, text, text, uuid);
