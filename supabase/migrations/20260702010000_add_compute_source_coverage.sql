-- Add compute_source_coverage function
CREATE OR REPLACE FUNCTION compute_source_coverage(target_days integer default 7)
RETURNS TABLE (
    source_name TEXT,
    lane TEXT,
    last_event_at TIMESTAMPTZ,
    last_ingested_at TIMESTAMPTZ,
    last_summary_refresh_at TIMESTAMPTZ,
    expected_cadence_hours INTEGER,
    gap_hours INTEGER,
    coverage_status TEXT,
    true_zero_possible BOOLEAN,
    notes TEXT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_last_summary_refresh TIMESTAMPTZ;
    v_has_recent_workouts BOOLEAN;
    v_has_sync_workouts BOOLEAN;
    v_has_sync_health BOOLEAN;
BEGIN
    -- Global variables
    SELECT max(computed_at) INTO v_last_summary_refresh FROM health_summaries;
    
    SELECT EXISTS (
        SELECT 1 FROM training_logs 
        WHERE workout_date >= (v_now - (target_days || ' days')::interval)::date
    ) INTO v_has_recent_workouts;

    SELECT EXISTS (
        SELECT 1 FROM sync_log 
        WHERE source = 'iron-log' AND status = 'completed'
    ) INTO v_has_sync_workouts;

    SELECT EXISTS (
        SELECT 1 FROM sync_log 
        WHERE source IN ('health-connect', 'health-api') AND status = 'completed'
    ) INTO v_has_sync_health;

    RETURN QUERY
    WITH lane_data AS (
        -- workouts
        SELECT
            'iron-log'::TEXT AS src,
            'workouts'::TEXT AS ln,
            (SELECT max(workout_date)::timestamptz FROM training_logs) AS le_at,
            (SELECT max(created_at) FROM training_logs) AS li_at,
            96 AS expected_cadence,
            EXISTS (SELECT 1 FROM health_summaries WHERE workout_count IS NOT NULL AND workout_count > 0) AS has_sum,
            v_has_sync_workouts AS has_sync,
            TRUE AS zero_possible
        UNION ALL
        -- sleep
        SELECT
            COALESCE((SELECT source FROM health_entries WHERE entry_type = 'sleep' ORDER BY timestamp DESC LIMIT 1), 'health-connect')::TEXT AS src,
            'sleep'::TEXT AS ln,
            (SELECT max(timestamp) FROM health_entries WHERE entry_type = 'sleep') AS le_at,
            (SELECT max(created_at) FROM health_entries WHERE entry_type = 'sleep') AS li_at,
            36 AS expected_cadence,
            EXISTS (SELECT 1 FROM health_summaries WHERE sleep_total_hours IS NOT NULL) AS has_sum,
            v_has_sync_health AS has_sync,
            FALSE AS zero_possible
        UNION ALL
        -- steps
        SELECT
            COALESCE((SELECT source FROM health_entries WHERE entry_type = 'steps' ORDER BY timestamp DESC LIMIT 1), 'health-connect')::TEXT AS src,
            'steps'::TEXT AS ln,
            (SELECT max(timestamp) FROM health_entries WHERE entry_type = 'steps') AS le_at,
            (SELECT max(created_at) FROM health_entries WHERE entry_type = 'steps') AS li_at,
            36 AS expected_cadence,
            EXISTS (SELECT 1 FROM health_summaries WHERE steps_total IS NOT NULL) AS has_sum,
            v_has_sync_health AS has_sync,
            FALSE AS zero_possible
        UNION ALL
        -- heart_rate
        SELECT
            COALESCE((SELECT source FROM health_entries WHERE entry_type = 'heart_rate' ORDER BY timestamp DESC LIMIT 1), 'health-connect')::TEXT AS src,
            'heart_rate'::TEXT AS ln,
            (SELECT max(timestamp) FROM health_entries WHERE entry_type = 'heart_rate') AS le_at,
            (SELECT max(created_at) FROM health_entries WHERE entry_type = 'heart_rate') AS li_at,
            36 AS expected_cadence,
            EXISTS (SELECT 1 FROM health_summaries WHERE hr_avg IS NOT NULL) AS has_sum,
            v_has_sync_health AS has_sync,
            FALSE AS zero_possible
        UNION ALL
        -- weight
        SELECT
            COALESCE((SELECT source FROM health_entries WHERE entry_type = 'weight' ORDER BY timestamp DESC LIMIT 1), 'health-connect')::TEXT AS src,
            'weight'::TEXT AS ln,
            (SELECT max(timestamp) FROM health_entries WHERE entry_type = 'weight') AS le_at,
            (SELECT max(created_at) FROM health_entries WHERE entry_type = 'weight') AS li_at,
            336 AS expected_cadence,
            EXISTS (SELECT 1 FROM health_summaries WHERE weight_kg IS NOT NULL) AS has_sum,
            v_has_sync_health AS has_sync,
            FALSE AS zero_possible
    ),
    lane_with_gaps AS (
        SELECT
            src,
            ln,
            le_at,
            li_at,
            expected_cadence,
            has_sum,
            has_sync,
            zero_possible,
            CASE
                WHEN le_at IS NULL THEN NULL::integer
                ELSE extract(epoch from (v_now - le_at))::integer / 3600
            END AS gap
        FROM lane_data
    )
    SELECT
        src AS source_name,
        ln AS lane,
        le_at AS last_event_at,
        li_at AS last_ingested_at,
        v_last_summary_refresh AS last_summary_refresh_at,
        expected_cadence AS expected_cadence_hours,
        gap AS gap_hours,
        CASE
            WHEN le_at IS NOT NULL AND gap <= expected_cadence THEN 'current'
            WHEN has_sum AND (le_at IS NULL OR gap > expected_cadence) THEN 'summary_stale'
            WHEN le_at IS NULL AND v_has_recent_workouts AND NOT has_sync THEN 'missing'
            WHEN le_at IS NULL AND NOT has_sum AND NOT has_sync THEN 'never_seen'
            WHEN le_at IS NOT NULL AND gap > expected_cadence THEN 'late'
            ELSE 'missing'
        END AS coverage_status,
        CASE
            WHEN ln = 'workouts' THEN TRUE
            WHEN ln = 'steps' AND le_at IS NOT NULL THEN TRUE
            ELSE FALSE
        END AS true_zero_possible,
        -- Generate notes
        ARRAY(
            SELECT n FROM (
                SELECT 'no_data_points'::TEXT AS n WHERE le_at IS NULL
                UNION ALL
                SELECT 'stale_data'::TEXT WHERE le_at IS NOT NULL AND gap > expected_cadence
                UNION ALL
                SELECT 'sync_log_found'::TEXT WHERE has_sync
                UNION ALL
                SELECT 'no_sync_log'::TEXT WHERE NOT has_sync
                UNION ALL
                SELECT 'summary_found'::TEXT WHERE has_sum
                UNION ALL
                SELECT 'recent_workouts_found'::TEXT WHERE v_has_recent_workouts
            ) s
        ) AS notes
    FROM lane_with_gaps;
END;
$$;

GRANT EXECUTE ON FUNCTION compute_source_coverage(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION compute_source_coverage(integer) TO service_role;
