-- ============================================================
-- Alexandria: Derived Health Metrics (Phase 4.1)
-- Run after 001_core.sql, 002_security.sql, 003_improvements.sql
-- ============================================================

CREATE TABLE health_summaries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date        DATE NOT NULL,
    sleep_total_hours NUMERIC,
    sleep_sessions    INTEGER DEFAULT 0,
    steps_total       INTEGER,
    steps_active_minutes NUMERIC,
    hr_avg            NUMERIC,
    hr_min            NUMERIC,
    hr_max            NUMERIC,
    hr_samples        INTEGER DEFAULT 0,
    weight_kg         NUMERIC,
    exercise_count    INTEGER DEFAULT 0,
    exercise_total_minutes NUMERIC,
    exercise_types    TEXT[] DEFAULT '{}',
    workout_count     INTEGER DEFAULT 0,
    training_volume_kg NUMERIC,
    training_types    TEXT[] DEFAULT '{}',
    sources           TEXT[] DEFAULT '{}',
    computed_at       TIMESTAMPTZ DEFAULT now() NOT NULL,

    UNIQUE(date)
);

CREATE INDEX idx_health_summaries_date ON health_summaries (date DESC);

ALTER TABLE health_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON health_summaries
    FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT, INSERT, UPDATE, DELETE ON health_summaries TO service_role;

-- ============================================================
-- COMPUTE DAILY SUMMARY
-- ============================================================
CREATE OR REPLACE FUNCTION compute_daily_summary(target_date DATE)
RETURNS JSONB AS $$
DECLARE
    v_sleep_total    NUMERIC := 0;
    v_sleep_sessions INTEGER := 0;
    v_steps_total    BIGINT  := 0;
    v_steps_active   NUMERIC := 0;
    v_hr_avg         NUMERIC;
    v_hr_min         NUMERIC;
    v_hr_max         NUMERIC;
    v_hr_samples     INTEGER := 0;
    v_weight_kg      NUMERIC;
    v_ex_count       INTEGER := 0;
    v_ex_minutes     NUMERIC := 0;
    v_ex_types       TEXT[]  := '{}';
    v_wk_count       INTEGER := 0;
    v_wk_volume      NUMERIC := 0;
    v_wk_types       TEXT[]  := '{}';
    v_sources        TEXT[]  := '{}';
    v_result         JSONB;
BEGIN
    -- Sleep
    SELECT
        COALESCE(SUM(CASE WHEN duration_s IS NOT NULL THEN duration_s ELSE COALESCE((value->>'duration_s')::NUMERIC, 0) END), 0),
        COUNT(*)
    INTO v_sleep_total, v_sleep_sessions
    FROM health_entries
    WHERE entry_type = 'sleep'
      AND (event_time IS NOT NULL AND event_time::date = target_date
           OR event_time IS NULL AND timestamp::date = target_date);

    -- Steps
    SELECT
        COALESCE(SUM(numeric_value), 0) + COALESCE(SUM((value->>'count')::BIGINT), 0),
        COUNT(*),
        COALESCE(SUM(CASE WHEN value->>'active_minutes' IS NOT NULL THEN (value->>'active_minutes')::NUMERIC ELSE 0 END), 0)
    INTO v_steps_total, v_hr_samples, v_steps_active
    FROM health_entries
    WHERE entry_type = 'steps'
      AND (event_time IS NOT NULL AND event_time::date = target_date
           OR event_time IS NULL AND timestamp::date = target_date);

    -- Heart rate
    SELECT
        AVG(numeric_value),
        MIN(numeric_value),
        MAX(numeric_value),
        COUNT(*)
    INTO v_hr_avg, v_hr_min, v_hr_max, v_hr_samples
    FROM health_entries
    WHERE entry_type = 'heart_rate'
      AND numeric_value IS NOT NULL
      AND (event_time IS NOT NULL AND event_time::date = target_date
           OR event_time IS NULL AND timestamp::date = target_date);

    -- Weight (latest reading for the day)
    SELECT numeric_value
    INTO v_weight_kg
    FROM health_entries
    WHERE entry_type = 'weight'
      AND numeric_value IS NOT NULL
      AND (event_time IS NOT NULL AND event_time::date = target_date
           OR event_time IS NULL AND timestamp::date = target_date)
    ORDER BY event_time DESC NULLS LAST, timestamp DESC
    LIMIT 1;

    -- Exercise
    SELECT
        COUNT(*),
        COALESCE(SUM(CASE WHEN duration_s IS NOT NULL THEN duration_s ELSE 0 END), 0),
        ARRAY_AGG(DISTINCT unnest(COALESCE(tags, '{}')))
    INTO v_ex_count, v_ex_minutes, v_ex_types
    FROM health_entries
    WHERE entry_type = 'exercise'
      AND (event_time IS NOT NULL AND event_time::date = target_date
           OR event_time IS NULL AND timestamp::date = target_date);

    -- Training (from training_logs)
    SELECT
        COUNT(*),
        COALESCE(SUM(volume_kg), 0),
        ARRAY_AGG(DISTINCT workout_type)
    INTO v_wk_count, v_wk_volume, v_wk_types
    FROM training_logs
    WHERE workout_date = target_date;

    -- Collect unique sources
    SELECT ARRAY_AGG(DISTINCT COALESCE(ingestion_source, source))
    INTO v_sources
    FROM (
        SELECT ingestion_source, source FROM health_entries
        WHERE (event_time IS NOT NULL AND event_time::date = target_date
               OR event_time IS NULL AND timestamp::date = target_date)
        UNION ALL
        SELECT ingestion_source, 'iron-log'::TEXT FROM training_logs
        WHERE workout_date = target_date
    ) combined;

    IF v_sources IS NULL THEN v_sources := '{}'; END IF;

    -- UPSERT into health_summaries
    INSERT INTO health_summaries (
        date, sleep_total_hours, sleep_sessions,
        steps_total, steps_active_minutes,
        hr_avg, hr_min, hr_max, hr_samples,
        weight_kg,
        exercise_count, exercise_total_minutes, exercise_types,
        workout_count, training_volume_kg, training_types,
        sources, computed_at
    ) VALUES (
        target_date,
        ROUND(v_sleep_total / 3600, 2),
        v_sleep_sessions,
        v_steps_total::INTEGER,
        v_steps_active,
        CASE WHEN v_hr_avg IS NOT NULL THEN ROUND(v_hr_avg, 1) END,
        v_hr_min,
        v_hr_max,
        v_hr_samples,
        v_weight_kg,
        v_ex_count,
        ROUND(COALESCE(v_ex_minutes, 0) / 60, 1),
        COALESCE(v_ex_types, '{}'),
        v_wk_count,
        v_wk_volume,
        COALESCE(v_wk_types, '{}'),
        v_sources,
        now()
    )
    ON CONFLICT (date) DO UPDATE SET
        sleep_total_hours = EXCLUDED.sleep_total_hours,
        sleep_sessions = EXCLUDED.sleep_sessions,
        steps_total = EXCLUDED.steps_total,
        steps_active_minutes = EXCLUDED.steps_active_minutes,
        hr_avg = EXCLUDED.hr_avg,
        hr_min = EXCLUDED.hr_min,
        hr_max = EXCLUDED.hr_max,
        hr_samples = EXCLUDED.hr_samples,
        weight_kg = EXCLUDED.weight_kg,
        exercise_count = EXCLUDED.exercise_count,
        exercise_total_minutes = EXCLUDED.exercise_total_minutes,
        exercise_types = EXCLUDED.exercise_types,
        workout_count = EXCLUDED.workout_count,
        training_volume_kg = EXCLUDED.training_volume_kg,
        training_types = EXCLUDED.training_types,
        sources = EXCLUDED.sources,
        computed_at = now()
    RETURNING to_jsonb(health_summaries) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;
