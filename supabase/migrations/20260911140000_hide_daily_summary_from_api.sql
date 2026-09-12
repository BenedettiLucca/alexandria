-- Migration: 20260911140000_hide_daily_summary_from_api.sql
-- D-ENV-PGCRASH (Core): compute_daily_summary dispara segfault nativo do PG 17.6
-- quando PARSEADA sob SET ROLE anon (REVOKE nao protege: PostgREST prepara a
-- statement antes do privilege check). Mitigacao: mover para schema dedicado
-- alexandria_priv e REVOKE USAGE do schema para anon/public. Tools e Edge
-- Function chamam schema-qualified. INVOKER + guarda JWT ja aplicados em 130000.

CREATE SCHEMA IF NOT EXISTS alexandria_priv;

ALTER FUNCTION public.compute_daily_summary(date, uuid, text) SET SCHEMA alexandria_priv;

REVOKE ALL ON SCHEMA alexandria_priv FROM anon, PUBLIC;
GRANT USAGE ON SCHEMA alexandria_priv TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA alexandria_priv TO authenticated, service_role;
