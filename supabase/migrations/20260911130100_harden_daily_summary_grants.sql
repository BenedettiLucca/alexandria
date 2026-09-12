
-- Migration: 20260911130100_harden_daily_summary_grants.sql
-- T25 BLOCKER 1 (P0): EXECUTE de compute_daily_summary revogado de PUBLIC/anon.
-- Em arquivo separado: parser de chain do CLI engole $$-body + grants num arquivo so.
REVOKE EXECUTE ON FUNCTION public.compute_daily_summary(date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_daily_summary(date, uuid, text) TO authenticated, service_role;
