-- Add coverage transition ledger: append-only snapshots + transition report.
--
-- Builds on compute_source_coverage() (20260702010000). Every observation of a
-- lane's coverage is persisted as a snapshot so health_summary-style point-in-time
-- checks can be replayed into NEW / ONGOING / RECOVERED transitions.

-- ---------------------------------------------------------------------------
-- coverage_snapshots: append-only ledger of coverage observations.
-- source_kind='health' rows come from capture_coverage_snapshot (scheduler/MCP).
-- source_kind='brief' rows come from publish_lane_heartbeat (external producers).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coverage_snapshots (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_kind TEXT NOT NULL DEFAULT 'health'
        CHECK (source_kind IN ('health', 'brief')),
    source_name TEXT NOT NULL,
    lane TEXT NOT NULL,
    coverage_status TEXT NOT NULL
        CHECK (coverage_status IN ('current', 'late', 'summary_stale', 'missing', 'never_seen')),
    gap_hours INTEGER,
    expected_cadence_hours INTEGER,
    last_event_at TIMESTAMPTZ,
    last_ingested_at TIMESTAMPTZ,
    true_zero_possible BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT[] NOT NULL DEFAULT '{}',
    producer TEXT NOT NULL DEFAULT 'scheduler'
        CHECK (producer IN ('scheduler', 'mcp', 'heartbeat')),
    -- brief-lane heartbeat fields (only populated when source_kind='brief')
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_expected_run_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_coverage_snapshots_lookup
    ON coverage_snapshots (user_id, source_kind, lane, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_coverage_snapshots_prune
    ON coverage_snapshots (captured_at);

ALTER TABLE coverage_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_access ON coverage_snapshots
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY users_read_own_coverage ON coverage_snapshots
    FOR SELECT USING (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY users_insert_own_coverage ON coverage_snapshots
    FOR INSERT WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON coverage_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON coverage_snapshots TO service_role;
GRANT USAGE, SELECT ON SEQUENCE coverage_snapshots_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE coverage_snapshots_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- capture_coverage_snapshot: persist current compute_source_coverage() output.
-- Idempotent per (user, source_kind, lane): skips a lane when its latest
-- snapshot has identical status+gap and was captured within the last 12h, so a
-- retried nightly run does not spam identical rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION capture_coverage_snapshot(
    p_target_days integer DEFAULT 7,
    p_source_kind text DEFAULT 'health',
    p_producer text DEFAULT 'scheduler'
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_inserted integer;
BEGIN
    INSERT INTO coverage_snapshots (
        user_id, source_kind, source_name, lane, coverage_status, gap_hours,
        expected_cadence_hours, last_event_at, last_ingested_at,
        true_zero_possible, notes, producer
    )
    SELECT
        auth.uid(),
        p_source_kind,
        c.source_name,
        c.lane,
        c.coverage_status,
        c.gap_hours,
        c.expected_cadence_hours,
        c.last_event_at,
        c.last_ingested_at,
        c.true_zero_possible,
        c.notes,
        p_producer
    FROM compute_source_coverage(p_target_days) c
    WHERE NOT EXISTS (
        SELECT 1 FROM coverage_snapshots s
        WHERE s.user_id IS NOT DISTINCT FROM auth.uid()
          AND s.source_kind = p_source_kind
          AND s.source_name = c.source_name
          AND s.lane = c.lane
          AND s.coverage_status = c.coverage_status
          AND s.gap_hours IS NOT DISTINCT FROM c.gap_hours
          AND s.captured_at >= now() - interval '12 hours'
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- publish_lane_heartbeat: external producers (e.g. Night Research Pack) record
-- a run. Success marks the lane 'current' with a fresh last_success_at; failure
-- marks it 'missing' with last_failure_at. artifact freshness is derived at
-- read time from expected cadence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION publish_lane_heartbeat(
    p_source_name text,
    p_lane text,
    p_success boolean,
    p_expected_cadence_hours integer DEFAULT 24,
    p_notes text[] DEFAULT '{}'
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_inserted integer;
BEGIN
    INSERT INTO coverage_snapshots (
        user_id, source_kind, source_name, lane, coverage_status, gap_hours,
        expected_cadence_hours, true_zero_possible, notes, producer,
        last_success_at, last_failure_at, last_expected_run_at
    ) VALUES (
        auth.uid(),
        'brief',
        p_source_name,
        p_lane,
        CASE WHEN p_success THEN 'current' ELSE 'missing' END,
        CASE WHEN p_success THEN 0 ELSE NULL END,
        p_expected_cadence_hours,
        FALSE,
        p_notes,
        'heartbeat',
        CASE WHEN p_success THEN now() ELSE NULL END,
        CASE WHEN p_success THEN NULL ELSE now() END,
        now()
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_coverage_transition_report: replay snapshots into transitions.
-- For each (source_kind, lane) within the window it reports the latest and
-- previous status, the transition class, how long the current degradation has
-- been running (first_degraded_at + streak), and whether the lane should block
-- trust (degraded across >= 2 consecutive snapshots).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_coverage_transition_report(p_days integer DEFAULT 30)
RETURNS TABLE (
    source_kind TEXT,
    source_name TEXT,
    lane TEXT,
    prev_status TEXT,
    prev_captured_at TIMESTAMPTZ,
    current_status TEXT,
    current_captured_at TIMESTAMPTZ,
    transition_type TEXT,
    first_degraded_at TIMESTAMPTZ,
    degradation_streak INTEGER,
    gap_hours INTEGER,
    expected_cadence_hours INTEGER,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_expected_run_at TIMESTAMPTZ,
    artifact_freshness_status TEXT,
    trust_blocking BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
    WITH cutoff AS (
        SELECT now() - (p_days || ' days')::interval AS c
    ),
    snaps AS (
        SELECT s.id, s.captured_at, s.source_kind, s.source_name, s.lane,
               s.coverage_status, s.gap_hours, s.expected_cadence_hours,
               s.last_success_at, s.last_failure_at, s.last_expected_run_at,
               (s.coverage_status <> 'current') AS bad
        FROM coverage_snapshots s
        WHERE s.captured_at >= (SELECT c FROM cutoff)
          AND (s.user_id IS NULL OR s.user_id = auth.uid())
    ),
    -- Consecutive degraded rows share a group id (row_number - cumsum(bad)).
    islands AS (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY source_kind, lane ORDER BY captured_at)
              - SUM(bad::int) OVER (PARTITION BY source_kind, lane ORDER BY captured_at) AS grp
        FROM snaps
    ),
    latest_all AS (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY source_kind, lane ORDER BY captured_at DESC) AS rn
        FROM islands
    ),
    latest AS (SELECT * FROM latest_all WHERE rn = 1),
    prev AS (SELECT * FROM latest_all WHERE rn = 2),
    current_island AS (
        SELECT i.source_kind, i.lane, COUNT(*) AS streak, MIN(i.captured_at) AS first_degraded_at
        FROM islands i
        JOIN latest l ON l.source_kind = i.source_kind AND l.lane = i.lane AND l.grp = i.grp
        GROUP BY i.source_kind, i.lane
    )
    SELECT
        l.source_kind,
        l.source_name,
        l.lane,
        p.coverage_status AS prev_status,
        p.captured_at AS prev_captured_at,
        l.coverage_status AS current_status,
        l.captured_at AS current_captured_at,
        CASE
            WHEN l.bad AND (p.coverage_status IS NULL OR NOT p.bad) THEN 'NEW'
            WHEN l.bad AND p.bad THEN 'ONGOING'
            WHEN NOT l.bad AND p.bad THEN 'RECOVERED'
            WHEN NOT l.bad THEN 'STEADY'
            ELSE 'NEW'
        END AS transition_type,
        ci.first_degraded_at,
        COALESCE(ci.streak, 0) AS degradation_streak,
        l.gap_hours,
        l.expected_cadence_hours,
        l.last_success_at,
        l.last_failure_at,
        l.last_expected_run_at,
        CASE
            WHEN l.source_kind <> 'brief' THEN 'n/a'
            WHEN l.last_success_at IS NULL THEN 'missing'
            WHEN l.last_success_at >= now() - (COALESCE(l.expected_cadence_hours, 24) || ' hours')::interval THEN 'fresh'
            ELSE 'stale'
        END AS artifact_freshness_status,
        (l.bad AND COALESCE(ci.streak, 0) >= 2) AS trust_blocking
    FROM latest l
    LEFT JOIN prev p ON p.source_kind = l.source_kind AND p.lane = l.lane
    LEFT JOIN current_island ci ON ci.source_kind = l.source_kind AND ci.lane = l.lane
    ORDER BY l.source_kind, l.lane;
$$;

GRANT EXECUTE ON FUNCTION capture_coverage_snapshot(integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION capture_coverage_snapshot(integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION publish_lane_heartbeat(text, text, boolean, integer, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_lane_heartbeat(text, text, boolean, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION get_coverage_transition_report(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_coverage_transition_report(integer) TO service_role;
