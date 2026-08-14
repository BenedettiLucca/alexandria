-- Tool activation telemetry: append-only call log + seeded tool catalog.
--
-- The catalog is the source of truth for every MCP tool name, so the activation
-- report can classify tools that have never been called. The call log records a
-- non-reversible SHA-256 hash of the JSON params (never raw args), the calling
-- client, success, and latency.

-- ---------------------------------------------------------------------------
-- tool_catalog: canonical registry of MCP tools (seeded below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_catalog (
    tool_name TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tool_catalog (tool_name) VALUES
    ('search_memories'),
    ('capture_memory'),
    ('list_memories'),
    ('memory_stats'),
    ('update_memory'),
    ('delete_memory'),
    ('capture_brief'),
    ('list_briefs'),
    ('search_briefs'),
    ('build_room_manifest'),
    ('save_room_recipe'),
    ('list_room_recipes'),
    ('get_room_recipe'),
    ('build_room_manifest_from_recipe'),
    ('get_profile'),
    ('set_profile'),
    ('whoami'),
    ('list_projects'),
    ('save_project'),
    ('log_health'),
    ('query_health'),
    ('search_health'),
    ('health_summary'),
    ('refresh_summary'),
    ('delete_health_entry'),
    ('bodycomp_summary'),
    ('source_coverage_report'),
    ('coverage_transition_report'),
    ('log_workout'),
    ('query_workouts'),
    ('search_workouts'),
    ('update_workout'),
    ('search_entities'),
    ('get_entity'),
    ('list_entities'),
    ('sync_status'),
    ('score_brief_provenance'),
    ('extract_brief_claims'),
    ('scan_brief_conflicts'),
    ('get_tool_activation_report')
ON CONFLICT (tool_name) DO NOTHING;

ALTER TABLE tool_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_access_catalog ON tool_catalog
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY users_read_tool_catalog ON tool_catalog
    FOR SELECT USING (true);

GRANT SELECT ON tool_catalog TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_catalog TO service_role;

-- ---------------------------------------------------------------------------
-- tool_call_log: append-only, no UPDATE/DELETE policy for end users.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_call_log (
    id BIGSERIAL PRIMARY KEY,
    tool_name TEXT NOT NULL,
    caller_client TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    params_hash TEXT,
    success BOOLEAN NOT NULL,
    latency_ms INTEGER,
    owner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_call_log_tool_time
    ON tool_call_log (tool_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_time
    ON tool_call_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_owner_time
    ON tool_call_log (owner_id, timestamp DESC);

ALTER TABLE tool_call_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_access_call_log ON tool_call_log
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY users_read_own_tool_log ON tool_call_log
    FOR SELECT USING (owner_id IS NULL OR owner_id = auth.uid()::text);

CREATE POLICY users_insert_own_tool_log ON tool_call_log
    FOR INSERT WITH CHECK (owner_id IS NULL OR owner_id = auth.uid()::text);

GRANT SELECT, INSERT ON tool_call_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_call_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE tool_call_log_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_call_log_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- get_tool_activation_report: catalog-driven activation heatmap.
-- Window defaults to 90 days; sub-windows are always measured at 7/30/90 days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_tool_activation_report(p_days integer DEFAULT 90)
RETURNS TABLE (
    tool_name TEXT,
    never_called BOOLEAN,
    called_7d BOOLEAN,
    called_30d BOOLEAN,
    called_90d BOOLEAN,
    total_calls BIGINT,
    success_rate NUMERIC,
    avg_latency_ms NUMERIC,
    last_called_at TIMESTAMPTZ,
    client_count BIGINT,
    clients TEXT[],
    trend TEXT
)
LANGUAGE sql
STABLE
AS $$
    WITH logs AS (
        SELECT tool_name, timestamp, success, latency_ms, caller_client
        FROM tool_call_log
        WHERE timestamp >= now() - (p_days || ' days')::interval
    ),
    agg AS (
        SELECT
            tool_name,
            count(*) AS total_calls,
            count(*) FILTER (WHERE timestamp >= now() - interval '7 days') AS c7,
            count(*) FILTER (WHERE timestamp >= now() - interval '30 days') AS c30,
            count(*) FILTER (WHERE timestamp >= now() - interval '90 days') AS c90,
            count(*) FILTER (
                WHERE timestamp >= now() - interval '7 days'
            ) AS recent_7,
            count(*) FILTER (
                WHERE timestamp >= now() - interval '14 days'
                  AND timestamp < now() - interval '7 days'
            ) AS prev_7,
            round(100.0 * avg(success::int)) AS success_rate,
            round(avg(latency_ms)) AS avg_latency_ms,
            max(timestamp) AS last_called_at,
            count(DISTINCT caller_client) FILTER (
                WHERE caller_client IS NOT NULL
            ) AS client_count,
            array_agg(DISTINCT caller_client ORDER BY caller_client) FILTER (
                WHERE caller_client IS NOT NULL
            ) AS clients
        FROM logs
        GROUP BY tool_name
    ),
    ever AS (
        SELECT DISTINCT tool_name FROM tool_call_log
    )
    SELECT
        c.tool_name,
        (e.tool_name IS NULL) AS never_called,
        COALESCE(a.c7, 0) > 0 AS called_7d,
        COALESCE(a.c30, 0) > 0 AS called_30d,
        COALESCE(a.c90, 0) > 0 AS called_90d,
        COALESCE(a.total_calls, 0) AS total_calls,
        a.success_rate,
        a.avg_latency_ms,
        a.last_called_at,
        COALESCE(a.client_count, 0) AS client_count,
        COALESCE(a.clients, '{}') AS clients,
        CASE
            WHEN e.tool_name IS NULL THEN 'never'
            WHEN COALESCE(a.total_calls, 0) = 0 THEN 'dormant'
            WHEN COALESCE(a.recent_7, 0) > COALESCE(a.prev_7, 0) THEN 'rising'
            WHEN COALESCE(a.recent_7, 0) < COALESCE(a.prev_7, 0) THEN 'falling'
            ELSE 'stable'
        END AS trend
    FROM tool_catalog c
    LEFT JOIN agg a ON a.tool_name = c.tool_name
    LEFT JOIN ever e ON e.tool_name = c.tool_name
    ORDER BY c.tool_name;
$$;

-- ---------------------------------------------------------------------------
-- prune_tool_call_log: enforce retention (default 90 days).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_tool_call_log(p_retention_days integer DEFAULT 90)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH deleted AS (
        DELETE FROM tool_call_log
        WHERE timestamp < now() - (p_retention_days || ' days')::interval
        RETURNING id
    )
    SELECT count(*) FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION get_tool_activation_report(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_tool_activation_report(integer) TO service_role;
GRANT EXECUTE ON FUNCTION prune_tool_call_log(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION prune_tool_call_log(integer) TO service_role;