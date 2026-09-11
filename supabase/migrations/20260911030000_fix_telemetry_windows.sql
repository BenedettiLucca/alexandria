-- Migration: 20260911030000_fix_telemetry_windows.sql
-- Task: T18 — Telemetry windows (#55)
-- Empacotada pelo Core a partir do trabalho da lane T18: a logica nova
-- (scan estavel GREATEST(p_days,90) + agregados FILTER na janela pedida)
-- estava sendo escrita em migrations JA APLICADAS; o correto e delta incremental.
-- Base: versao owner-aware de get_tool_activation_report (T03A).

CREATE OR REPLACE FUNCTION get_tool_activation_report(
    p_days integer DEFAULT 90,
    p_owner_id text DEFAULT NULL
)
RETURNS TABLE (
    tool_name TEXT,
    call_count BIGINT,
    success_count BIGINT,
    error_count BIGINT,
    success_rate NUMERIC,
    avg_latency_ms NUMERIC,
    p95_latency_ms NUMERIC,
    last_called_at TIMESTAMPTZ,
    active_days BIGINT,
    distinct_clients BIGINT,
    status TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH v_ctx AS (
        SELECT COALESCE(auth.uid()::text, p_owner_id) AS owner
    ),
    logs AS (
        SELECT l.tool_name, l.timestamp, l.success, l.latency_ms, l.caller_client
        FROM tool_call_log l
        WHERE l.timestamp >= now() - (GREATEST(p_days, 90) || ' days')::interval
          AND ((SELECT owner FROM v_ctx) IS NULL OR l.owner_id = (SELECT owner FROM v_ctx))
    ),
    agg AS (
        SELECT
            l.tool_name,
            COUNT(*) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval)::bigint AS call_count,
            COUNT(*) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval AND l.success)::bigint AS success_count,
            COUNT(*) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval AND NOT l.success)::bigint AS error_count,
            ROUND((COUNT(*) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval AND l.success)::numeric / NULLIF(COUNT(*) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval), 0)) * 100, 2) AS success_rate,
            ROUND(AVG(l.latency_ms) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval)::numeric, 1) AS avg_latency_ms,
            ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval)::numeric, 1) AS p95_latency_ms,
            MAX(l.timestamp) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval) AS last_called_at,
            COUNT(DISTINCT l.timestamp::date) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval)::bigint AS active_days,
            COUNT(DISTINCT l.caller_client) FILTER (WHERE l.timestamp >= now() - (GREATEST(p_days, 1) || ' days')::interval)::bigint AS distinct_clients
        FROM logs l
        GROUP BY l.tool_name
    ),
    ever AS (
        SELECT DISTINCT l.tool_name
        FROM tool_call_log l
        WHERE ((SELECT owner FROM v_ctx) IS NULL OR l.owner_id = (SELECT owner FROM v_ctx))
    )
    SELECT
        c.tool_name,
        COALESCE(a.call_count, 0) AS call_count,
        COALESCE(a.success_count, 0) AS success_count,
        COALESCE(a.error_count, 0) AS error_count,
        COALESCE(a.success_rate, 0.0) AS success_rate,
        a.avg_latency_ms,
        a.p95_latency_ms,
        a.last_called_at,
        COALESCE(a.active_days, 0) AS active_days,
        COALESCE(a.distinct_clients, 0) AS distinct_clients,
        CASE
            WHEN a.call_count IS NOT NULL AND a.call_count > 0 THEN 'active'
            WHEN e.tool_name IS NOT NULL THEN 'dormant'
            ELSE 'never_called'
        END AS status
    FROM tool_catalog c
    LEFT JOIN agg a ON a.tool_name = c.tool_name
    LEFT JOIN ever e ON e.tool_name = c.tool_name
    ORDER BY
        CASE
            WHEN a.call_count IS NOT NULL AND a.call_count > 0 THEN 1
            WHEN e.tool_name IS NOT NULL THEN 2
            ELSE 3
        END,
        COALESCE(a.call_count, 0) DESC,
        c.tool_name ASC;
$$;

GRANT EXECUTE ON FUNCTION get_tool_activation_report(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_tool_activation_report(integer, text) TO service_role;
