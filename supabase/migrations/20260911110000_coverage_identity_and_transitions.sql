ALTER TABLE coverage_snapshots ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION capture_coverage_snapshot(
    p_target_days integer DEFAULT 7,
    p_source_kind text DEFAULT 'health',
    p_producer text DEFAULT 'scheduler',
    p_user_id uuid DEFAULT NULL,
    p_execution_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner uuid := COALESCE(auth.uid(), p_user_id);
    v_execution_id text := COALESCE(NULLIF(trim(p_execution_id), ''), gen_random_uuid()::text);
    v_inserted integer;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'coverage snapshot owner is required';
    END IF;

    INSERT INTO coverage_snapshots (
        user_id, source_kind, source_name, lane, coverage_status, gap_hours,
        expected_cadence_hours, true_zero_possible, notes, producer, metadata,
        last_success_at, last_failure_at, last_expected_run_at
    )
    SELECT v_owner, p_source_kind, cov.source_name, cov.source_name,
           cov.coverage_status, cov.gap_hours, cov.expected_cadence_hours,
           cov.true_zero_possible, cov.notes, p_producer,
           jsonb_build_object('execution_id', v_execution_id),
           CASE WHEN cov.coverage_status = 'current' THEN cov.last_record_at ELSE NULL END,
           CASE WHEN cov.coverage_status <> 'current' THEN now() ELSE NULL END,
           now()
    FROM compute_source_coverage(p_target_days, v_owner) cov
    WHERE NOT EXISTS (
        SELECT 1 FROM coverage_snapshots s
        WHERE s.user_id = v_owner
          AND s.source_kind = p_source_kind
          AND s.source_name = cov.source_name
          AND s.lane = cov.source_name
          AND s.metadata->>'execution_id' IS NOT DISTINCT FROM v_execution_id
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION get_coverage_transition_report(
    p_days integer DEFAULT 30,
    p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
    source_kind text, source_name text, lane text, prev_status text,
    prev_captured_at timestamptz, current_status text,
    current_captured_at timestamptz, transition_type text,
    first_degraded_at timestamptz, degradation_streak integer,
    gap_hours integer, expected_cadence_hours integer,
    last_success_at timestamptz, last_failure_at timestamptz,
    last_expected_run_at timestamptz, artifact_freshness_status text,
    trust_blocking boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
WITH snaps AS (
    SELECT s.*, (s.coverage_status <> 'current') AS bad
    FROM coverage_snapshots s
    WHERE s.captured_at >= now() - (p_days || ' days')::interval
      AND s.user_id = COALESCE(auth.uid(), p_user_id)
), ordered AS (
    SELECT s.*, row_number() OVER w AS rn,
           sum(CASE WHEN s.bad THEN 1 ELSE 0 END) OVER w AS bad_count
    FROM snaps s
    WINDOW w AS (PARTITION BY s.user_id, s.source_kind, s.source_name, s.lane ORDER BY s.captured_at, s.id)
), grouped AS (
    SELECT o.*, sum(CASE WHEN NOT o.bad THEN 1 ELSE 0 END) OVER (PARTITION BY o.user_id, o.source_kind, o.source_name, o.lane ORDER BY o.captured_at, o.id) AS healthy_group
    FROM ordered o
), ranked AS (
    SELECT o.*, row_number() OVER (PARTITION BY o.user_id, o.source_kind, o.source_name, o.lane ORDER BY o.captured_at DESC, o.id DESC) AS latest_rn
    FROM grouped o
), latest AS (SELECT * FROM ranked WHERE latest_rn = 1), prev AS (SELECT * FROM ranked WHERE latest_rn = 2),
streaks AS (
    SELECT l.source_kind, l.source_name, l.lane,
           CASE WHEN l.bad THEN count(*) FILTER (WHERE x.bad AND x.healthy_group = l.healthy_group) ELSE 0 END::integer AS streak,
           CASE WHEN l.bad THEN min(x.captured_at) FILTER (WHERE x.bad AND x.healthy_group = l.healthy_group) ELSE NULL END AS first_bad
    FROM latest l JOIN ranked x ON x.user_id = l.user_id AND x.source_kind = l.source_kind AND x.source_name = l.source_name AND x.lane = l.lane AND x.captured_at <= l.captured_at
    GROUP BY l.source_kind, l.source_name, l.lane, l.bad, l.healthy_group
)
SELECT l.source_kind, l.source_name, l.lane, p.coverage_status, p.captured_at,
       l.coverage_status, l.captured_at,
       CASE WHEN p.coverage_status IS NULL THEN 'initial'
            WHEN p.coverage_status = l.coverage_status THEN 'unchanged'
            WHEN p.coverage_status = 'current' THEN 'degraded'
            WHEN l.coverage_status = 'current' THEN 'recovered'
            ELSE 'status_shift' END,
       CASE WHEN l.bad THEN s.first_bad ELSE NULL END,
       CASE WHEN l.bad THEN s.streak ELSE 0 END,
       l.gap_hours, l.expected_cadence_hours, l.last_success_at,
       l.last_failure_at, l.last_expected_run_at,
       CASE WHEN l.last_success_at IS NULL THEN 'unknown'
            WHEN now() - l.last_success_at <= (COALESCE(l.expected_cadence_hours, 24) || ' hours')::interval THEN 'fresh'
            WHEN now() - l.last_success_at <= (COALESCE(l.expected_cadence_hours, 24) * 2 || ' hours')::interval THEN 'aging'
            ELSE 'stale' END,
       (l.bad AND s.streak >= 2)
FROM latest l LEFT JOIN prev p USING (user_id, source_kind, source_name, lane)
JOIN streaks s USING (source_kind, source_name, lane)
ORDER BY l.source_kind, l.source_name, l.lane;
$$;

REVOKE EXECUTE ON FUNCTION capture_coverage_snapshot(integer, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION capture_coverage_snapshot(integer, text, text, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION get_coverage_transition_report(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_coverage_transition_report(integer, uuid) TO service_role;
