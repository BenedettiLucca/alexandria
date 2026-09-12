-- ==============================================================================
-- Migration: 20260911050000_fix_health_core_and_daily_summary.sql
-- Alexandria — Health Core and Daily Summary Fixes (T10)
-- ==============================================================================
-- 1. Single canonical value per row with fallback legacy (steps, sleep, weight, HR, exercise)
-- 2. Prevent duplicate step counts (never sum numeric_value + value->>'count')
-- 3. Avoid converting absence of data to zero (NULL metrics when no records exist)
-- 4. Derive UTC half-open bounds [day_start, day_end) from IANA timezone (independent of Postgres session timezone)
-- 5. Exercise aggregation uses domain type (exercise_type/type/name/activity_type), NOT tags
-- 6. Owner invariant enforcement and bounded behavior

DROP FUNCTION IF EXISTS compute_daily_summary(DATE, UUID);
DROP FUNCTION IF EXISTS compute_daily_summary(DATE, UUID, TEXT);
DROP FUNCTION IF EXISTS compute_daily_summary(DATE);

CREATE OR REPLACE FUNCTION compute_daily_summary(
    target_date DATE,
    p_user_id UUID DEFAULT NULL,
    p_timezone TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_tz TEXT;
    v_day_start TIMESTAMPTZ;
    v_day_end TIMESTAMPTZ;

    v_sleep_total NUMERIC;
    v_sleep_count INTEGER := 0;

    v_steps_total BIGINT;
    v_steps_active NUMERIC;
    v_steps_count INTEGER := 0;

    v_hr_avg NUMERIC;
    v_hr_min NUMERIC;
    v_hr_max NUMERIC;
    v_hr_samples INTEGER := 0;

    v_weight_kg NUMERIC;

    v_ex_count INTEGER := 0;
    v_ex_minutes NUMERIC;
    v_ex_types TEXT[] := '{}';

    v_wk_count INTEGER := 0;
    v_wk_volume NUMERIC;
    v_wk_types TEXT[] := '{}';

    v_sources TEXT[] := '{}';
    v_result JSONB;
BEGIN
    -- 1. Enforce owner invariant
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: compute_daily_summary requires an authenticated owner or explicit p_user_id';
    END IF;

    -- 2. Resolve IANA timezone (p_timezone > profile preferences/identity > UTC)
    v_tz := COALESCE(
        NULLIF(trim(p_timezone), ''),
        (SELECT value->>'timezone' FROM profile WHERE owner_id = v_owner AND key = 'preferences'),
        (SELECT value->>'timezone' FROM profile WHERE owner_id = v_owner AND key = 'identity'),
        'UTC'
    );
    -- Validate timezone safely; fallback to UTC if invalid
    BEGIN
        PERFORM ('2000-01-01 00:00:00'::timestamp AT TIME ZONE v_tz);
    EXCEPTION WHEN OTHERS THEN
        v_tz := 'UTC';
    END;

    -- 3. Calculate UTC half-open interval [v_day_start, v_day_end) independent of session timezone
    v_day_start := (target_date::timestamp AT TIME ZONE v_tz);
    v_day_end := ((target_date + 1)::timestamp AT TIME ZONE v_tz);

    -- 4. Sleep:
    -- Canonical duration per row (seconds / 3600 or numeric_value or duration_hours/duration_h or duration_s / 3600)
    -- Attributed to wake/end_time if present, else timestamp
    -- Never converts absence to zero (NULL if no records)
    SELECT
        SUM(CASE
            WHEN duration_s IS NOT NULL THEN duration_s / 3600.0
            WHEN numeric_value IS NOT NULL THEN numeric_value
            WHEN (value->>'duration_hours') IS NOT NULL THEN (value->>'duration_hours')::NUMERIC
            WHEN (value->>'duration_h') IS NOT NULL THEN (value->>'duration_h')::NUMERIC
            WHEN (value->>'duration_s') IS NOT NULL THEN (value->>'duration_s')::NUMERIC / 3600.0
            ELSE NULL
        END),
        COUNT(*)
    INTO v_sleep_total, v_sleep_count
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'sleep'
      AND COALESCE(NULLIF(value->>'end_time', '')::TIMESTAMPTZ, timestamp) >= v_day_start
      AND COALESCE(NULLIF(value->>'end_time', '')::TIMESTAMPTZ, timestamp) < v_day_end;

    -- 5. Steps:
    -- Single canonical value per row with fallback legacy:
    -- COALESCE(numeric_value, (value->>'count')::NUMERIC, (value->>'steps')::NUMERIC)
    -- NEVER sum numeric_value + value->>'count'!
    SELECT
        SUM(COALESCE(
            numeric_value,
            (value->>'count')::NUMERIC,
            (value->>'steps')::NUMERIC
        )),
        SUM(COALESCE(
            (value->>'active_minutes')::NUMERIC,
            (value->>'duration_min')::NUMERIC,
            CASE WHEN duration_s IS NOT NULL THEN duration_s / 60.0 ELSE NULL END
        )),
        COUNT(*)
    INTO v_steps_total, v_steps_active, v_steps_count
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'steps'
      AND timestamp >= v_day_start
      AND timestamp < v_day_end;

    -- 6. Heart Rate:
    -- Canonical bpm per row: COALESCE(numeric_value, (value->>'bpm')::NUMERIC, (value->>'beats_per_minute')::NUMERIC, (value->>'heart_rate')::NUMERIC)
    SELECT
        AVG(COALESCE(numeric_value, (value->>'bpm')::NUMERIC, (value->>'beats_per_minute')::NUMERIC, (value->>'heart_rate')::NUMERIC)),
        MIN(COALESCE(numeric_value, (value->>'bpm')::NUMERIC, (value->>'beats_per_minute')::NUMERIC, (value->>'heart_rate')::NUMERIC)),
        MAX(COALESCE(numeric_value, (value->>'bpm')::NUMERIC, (value->>'beats_per_minute')::NUMERIC, (value->>'heart_rate')::NUMERIC)),
        COUNT(*)
    INTO v_hr_avg, v_hr_min, v_hr_max, v_hr_samples
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'heart_rate'
      AND (numeric_value IS NOT NULL OR value->>'bpm' IS NOT NULL OR value->>'beats_per_minute' IS NOT NULL OR value->>'heart_rate' IS NOT NULL)
      AND timestamp >= v_day_start
      AND timestamp < v_day_end;

    -- 7. Weight:
    -- Latest weight reading of the day
    SELECT COALESCE(numeric_value, (value->>'weight_kg')::NUMERIC, (value->>'weight')::NUMERIC)
    INTO v_weight_kg
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'weight'
      AND (numeric_value IS NOT NULL OR value->>'weight_kg' IS NOT NULL OR value->>'weight' IS NOT NULL)
      AND timestamp >= v_day_start
      AND timestamp < v_day_end
    ORDER BY timestamp DESC
    LIMIT 1;

    -- 8. Exercise:
    -- Exercise types uses domain type (value->>'exercise_type', type, name, activity_type), NOT tags!
    SELECT
        COUNT(*),
        SUM(COALESCE(
            CASE WHEN duration_s IS NOT NULL THEN duration_s / 60.0 ELSE NULL END,
            (value->>'duration_min')::NUMERIC,
            CASE WHEN (value->>'duration_s') IS NOT NULL THEN (value->>'duration_s')::NUMERIC / 60.0 ELSE NULL END,
            CASE WHEN (value->>'duration_seconds') IS NOT NULL THEN (value->>'duration_seconds')::NUMERIC / 60.0 ELSE NULL END,
            CASE WHEN numeric_value IS NOT NULL THEN numeric_value ELSE NULL END
        )),
        ARRAY(
            SELECT DISTINCT ex_type
            FROM (
                SELECT COALESCE(
                    NULLIF(value->>'exercise_type', ''),
                    NULLIF(value->>'type', ''),
                    NULLIF(value->>'name', ''),
                    NULLIF(value->>'activity_type', '')
                ) AS ex_type
                FROM health_entries
                WHERE user_id = v_owner
                  AND entry_type = 'exercise'
                  AND timestamp >= v_day_start
                  AND timestamp < v_day_end
            ) sub
            WHERE ex_type IS NOT NULL AND trim(ex_type) <> ''
            ORDER BY 1
        )
    INTO v_ex_count, v_ex_minutes, v_ex_types
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'exercise'
      AND timestamp >= v_day_start
      AND timestamp < v_day_end;

    -- 9. Training logs (Iron-Log workouts):
    SELECT
        COUNT(*),
        SUM(volume_kg),
        ARRAY(
            SELECT DISTINCT workout_type
            FROM training_logs
            WHERE user_id = v_owner
              AND workout_date = target_date
              AND workout_type IS NOT NULL AND trim(workout_type) <> ''
            ORDER BY 1
        )
    INTO v_wk_count, v_wk_volume, v_wk_types
    FROM training_logs
    WHERE user_id = v_owner
      AND workout_date = target_date;

    -- 10. Sources:
    SELECT ARRAY(
        SELECT DISTINCT src FROM (
            SELECT source AS src
            FROM health_entries
            WHERE user_id = v_owner
              AND timestamp >= v_day_start
              AND timestamp < v_day_end
              AND source IS NOT NULL AND trim(source) <> ''
            UNION
            SELECT 'iron-log'::TEXT AS src
            FROM training_logs
            WHERE user_id = v_owner
              AND workout_date = target_date
        ) s
        ORDER BY 1
    ) INTO v_sources;

    -- 11. Atomic UPSERT into health_summaries scoped strictly by (user_id, date)
    INSERT INTO health_summaries (
        user_id, date, sleep_total_hours, sleep_sessions,
        steps_total, steps_active_minutes,
        hr_avg, hr_min, hr_max, hr_samples,
        weight_kg,
        exercise_count, exercise_total_minutes, exercise_types,
        workout_count, training_volume_kg, training_types,
        sources, computed_at
    ) VALUES (
        v_owner,
        target_date,
        CASE WHEN v_sleep_total IS NOT NULL THEN ROUND(v_sleep_total, 2) ELSE NULL END,
        COALESCE(v_sleep_count, 0),
        CASE WHEN v_steps_total IS NOT NULL THEN v_steps_total::INTEGER ELSE NULL END,
        CASE WHEN v_steps_active IS NOT NULL THEN ROUND(v_steps_active, 1) ELSE NULL END,
        CASE WHEN v_hr_avg IS NOT NULL THEN ROUND(v_hr_avg, 1) ELSE NULL END,
        v_hr_min,
        v_hr_max,
        COALESCE(v_hr_samples, 0),
        CASE WHEN v_weight_kg IS NOT NULL THEN ROUND(v_weight_kg, 2) ELSE NULL END,
        COALESCE(v_ex_count, 0),
        CASE WHEN v_ex_minutes IS NOT NULL THEN ROUND(v_ex_minutes, 2) ELSE NULL END,
        COALESCE(v_ex_types, '{}'),
        COALESCE(v_wk_count, 0),
        CASE WHEN v_wk_volume IS NOT NULL THEN ROUND(v_wk_volume, 1) ELSE NULL END,
        COALESCE(v_wk_types, '{}'),
        COALESCE(v_sources, '{}'),
        now()
    )
    ON CONFLICT (user_id, date) DO UPDATE SET
        sleep_total_hours      = EXCLUDED.sleep_total_hours,
        sleep_sessions         = EXCLUDED.sleep_sessions,
        steps_total            = EXCLUDED.steps_total,
        steps_active_minutes   = EXCLUDED.steps_active_minutes,
        hr_avg                 = EXCLUDED.hr_avg,
        hr_min                 = EXCLUDED.hr_min,
        hr_max                 = EXCLUDED.hr_max,
        hr_samples             = EXCLUDED.hr_samples,
        weight_kg              = EXCLUDED.weight_kg,
        exercise_count         = EXCLUDED.exercise_count,
        exercise_total_minutes = EXCLUDED.exercise_total_minutes,
        exercise_types         = EXCLUDED.exercise_types,
        workout_count          = EXCLUDED.workout_count,
        training_volume_kg     = EXCLUDED.training_volume_kg,
        training_types         = EXCLUDED.training_types,
        sources                = EXCLUDED.sources,
        computed_at            = now();

    v_result := jsonb_build_object(
        'user_id', v_owner,
        'date', target_date,
        'timezone', v_tz,
        'sleep_hours', CASE WHEN v_sleep_total IS NOT NULL THEN ROUND(v_sleep_total, 2) ELSE NULL END,
        'steps_total', v_steps_total,
        'hr_avg', CASE WHEN v_hr_avg IS NOT NULL THEN ROUND(v_hr_avg, 1) ELSE NULL END,
        'exercise_minutes', CASE WHEN v_ex_minutes IS NOT NULL THEN ROUND(v_ex_minutes, 2) ELSE NULL END,
        'training_volume_kg', CASE WHEN v_wk_volume IS NOT NULL THEN ROUND(v_wk_volume, 1) ELSE NULL END,
        'sources', COALESCE(v_sources, '{}'::TEXT[])
    );

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION compute_daily_summary(DATE, UUID, TEXT) TO authenticated, service_role, anon;
