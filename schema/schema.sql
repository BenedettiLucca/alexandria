-- ============================================================
-- Alexandria: Consolidated Schema
-- Personal context store for multi-AI shared memory
-- ============================================================
-- Canonical consolidated version — safe to run on a fresh Supabase
-- database to create everything from scratch.
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- TABLES
-- ============================================================

-- Memories: personal notes, observations, ideas, decisions
CREATE TABLE memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES auth.users(id),
    content     TEXT NOT NULL,
    embedding   vector(1536),
    title       TEXT,
    category    TEXT NOT NULL DEFAULT 'note'
                CHECK (category IN (
                    'note', 'idea', 'decision', 'observation',
                    'reference', 'task', 'person', 'recipe',
                    'travel', 'purchase', 'quote'
                )),
    source      TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN (
                    'manual', 'mcp', 'import', 'capture',
                    'health-connect', 'iron-log', 'auto'
                )),
    importance  SMALLINT DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
    tags        TEXT[] DEFAULT '{}',
    people      TEXT[] DEFAULT '{}',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Projects: codebase context, architecture decisions
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES auth.users(id),
    name        TEXT NOT NULL,
    path        TEXT,
    description TEXT,
    stack       TEXT[] DEFAULT '{}',
    conventions JSONB DEFAULT '{}',
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Profile: who you are, preferences, conventions
CREATE TABLE profile (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID REFERENCES auth.users(id),
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Health entries: Samsung Health / Health Connect data
CREATE TABLE health_entries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES auth.users(id),
    entry_type          TEXT NOT NULL
                        CHECK (entry_type IN (
                            'sleep', 'exercise', 'heart_rate', 'steps',
                            'weight', 'water', 'nutrition', 'blood_pressure',
                            'stress', 'cycle', 'body_composition',
                            'personal_record', 'measurement_goal'
                        )),
    timestamp           TIMESTAMPTZ NOT NULL,
    duration_s          INTEGER,
    value               JSONB NOT NULL DEFAULT '{}',
    numeric_value       NUMERIC,
    embedding           vector(1536),
    tags                TEXT[] DEFAULT '{}',
    source              TEXT DEFAULT 'health-connect',
    external_id         TEXT,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Training logs: Iron-Log workout data
CREATE TABLE training_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES auth.users(id),
    workout_date        DATE NOT NULL,
    workout_type        TEXT NOT NULL,
    name                TEXT NOT NULL,
    exercises           JSONB NOT NULL DEFAULT '[]',
    duration_s          INTEGER,
    volume_kg           NUMERIC(8,2),
    numeric_value       NUMERIC,
    rpe                 SMALLINT CHECK (rpe BETWEEN 1 AND 10),
    notes               TEXT,
    tags                TEXT[] DEFAULT '{}',
    external_id         TEXT,
    embedding           vector(1536),
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Health summaries: daily derived metrics
CREATE TABLE health_summaries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date                DATE NOT NULL,
    sleep_total_hours   NUMERIC,
    sleep_sessions      INTEGER DEFAULT 0,
    steps_total         INTEGER,
    steps_active_minutes NUMERIC,
    hr_avg              NUMERIC,
    hr_min              NUMERIC,
    hr_max              NUMERIC,
    hr_samples          INTEGER DEFAULT 0,
    weight_kg           NUMERIC,
    exercise_count      INTEGER DEFAULT 0,
    exercise_total_minutes NUMERIC,
    exercise_types      TEXT[] DEFAULT '{}',
    workout_count       INTEGER DEFAULT 0,
    training_volume_kg  NUMERIC,
    training_types      TEXT[] DEFAULT '{}',
    sources             TEXT[] DEFAULT '{}',
    computed_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(date)
);

-- Entities: knowledge graph nodes
CREATE TABLE entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN (
                    'person', 'project', 'concept', 'location',
                    'technology', 'organization', 'event', 'other'
                )),
    description TEXT,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(name, entity_type)
);

-- Entity mentions: knowledge graph edges
CREATE TABLE entity_mentions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    context     TEXT,
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(memory_id, entity_id)
);

-- Sync log: ingestion tracking
CREATE TABLE sync_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source              TEXT NOT NULL
                        CHECK (source IN ('iron-log', 'health-connect', 'health-api')),
    sync_type           TEXT NOT NULL DEFAULT 'incremental'
                        CHECK (sync_type IN ('full', 'incremental')),
    records_processed   INTEGER DEFAULT 0,
    records_imported    INTEGER DEFAULT 0,
    records_skipped     INTEGER DEFAULT 0,
    records_failed      INTEGER DEFAULT 0,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
    error_message       TEXT,
    metadata            JSONB DEFAULT '{}'
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Memories
CREATE INDEX idx_memories_embedding ON memories
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_memories_metadata ON memories USING gin (metadata);
CREATE INDEX idx_memories_tags ON memories USING gin (tags);
CREATE INDEX idx_memories_category ON memories (category);
CREATE INDEX idx_memories_source ON memories (source);
CREATE INDEX idx_memories_importance ON memories (importance DESC);
CREATE INDEX idx_memories_created ON memories (created_at DESC);
CREATE INDEX idx_memories_user_id ON memories(user_id);

-- Projects
CREATE INDEX idx_projects_name ON projects (name);
CREATE INDEX idx_projects_status ON projects (status);
CREATE INDEX idx_projects_user_id ON projects(user_id);

-- Profile
CREATE UNIQUE INDEX profile_key_owner_unique ON profile (key, owner_id)
    WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX profile_key_null_owner ON profile (key)
    WHERE owner_id IS NULL;

-- Health entries
CREATE INDEX idx_health_type_ts ON health_entries (entry_type, timestamp DESC);
CREATE INDEX idx_health_timestamp ON health_entries (timestamp DESC);
CREATE INDEX idx_health_metadata ON health_entries USING gin (metadata);
CREATE INDEX idx_health_type_numeric ON health_entries (entry_type, numeric_value DESC);
CREATE INDEX idx_health_entries_user_id ON health_entries(user_id);
CREATE INDEX idx_health_entries_embedding ON health_entries
    USING hnsw (embedding vector_cosine_ops);

-- Training logs
CREATE INDEX idx_training_date ON training_logs (workout_date DESC);
CREATE INDEX idx_training_type ON training_logs (workout_type);
CREATE INDEX idx_training_metadata ON training_logs USING gin (metadata);
CREATE INDEX idx_training_logs_user_id ON training_logs(user_id);
CREATE INDEX idx_training_logs_embedding ON training_logs
    USING hnsw (embedding vector_cosine_ops);

-- Health summaries
CREATE INDEX idx_health_summaries_date ON health_summaries (date DESC);

-- Entities
CREATE INDEX idx_entities_name ON entities (name);
CREATE INDEX idx_entities_type ON entities (entity_type);

-- Entity mentions
CREATE INDEX idx_entity_mentions_memory ON entity_mentions (memory_id);
CREATE INDEX idx_entity_mentions_entity ON entity_mentions (entity_id);

-- Sync log
CREATE INDEX idx_sync_log_source ON sync_log (source, started_at DESC);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Search memories by vector similarity
CREATE OR REPLACE FUNCTION search_memories(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter_category TEXT DEFAULT NULL,
    filter_tags TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    id UUID, content TEXT, title TEXT, category TEXT, source TEXT,
    importance SMALLINT, tags TEXT[], metadata JSONB,
    similarity FLOAT, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.content, m.title, m.category, m.source,
        m.importance, m.tags, m.metadata,
        1 - (m.embedding <=> query_embedding) AS similarity,
        m.created_at
    FROM memories m
    WHERE (1 - (m.embedding <=> query_embedding)) > match_threshold
      AND (filter_category IS NULL OR m.category = filter_category)
      AND (filter_tags IS NULL OR m.tags @> filter_tags)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Upsert memory with deduplication via content fingerprint
CREATE OR REPLACE FUNCTION upsert_memory(
    p_content TEXT, p_title TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'note', p_source TEXT DEFAULT 'mcp',
    p_importance SMALLINT DEFAULT 5, p_tags TEXT[] DEFAULT '{}',
    p_people TEXT[] DEFAULT '{}', p_metadata JSONB DEFAULT '{}'
)
RETURNS JSONB AS $$
DECLARE
    v_fingerprint TEXT; v_existing JSONB; v_merged_meta JSONB; v_new_id UUID;
BEGIN
    v_fingerprint := encode(sha256(p_content::bytea), 'hex');
    SELECT to_jsonb(m) INTO v_existing
    FROM memories m WHERE m.content = p_content;
    IF v_existing IS NOT NULL THEN
        v_merged_meta := COALESCE(v_existing->'metadata', '{}') || p_metadata;
        UPDATE memories SET
            metadata = v_merged_meta,
            tags = ARRAY(SELECT DISTINCT unnest(tags || p_tags)),
            people = ARRAY(SELECT DISTINCT unnest(people || p_people)),
            importance = GREATEST(importance, p_importance),
            updated_at = now()
        WHERE id = (v_existing->>'id')::UUID;
        RETURN jsonb_build_object('id', v_existing->>'id', 'status', 'updated');
    END IF;
    INSERT INTO memories (content, title, category, source, importance, tags, people, metadata)
    VALUES (p_content, p_title, p_category, p_source, p_importance, p_tags, p_people, p_metadata)
    RETURNING jsonb_build_object('id', id, 'status', 'created') INTO v_new_id;
    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;

-- Compute daily health summary from health_entries + training_logs
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
      AND timestamp::date = target_date;

    -- Steps
    SELECT
        COALESCE(SUM(numeric_value), 0) + COALESCE(SUM((value->>'count')::BIGINT), 0),
        COUNT(*),
        COALESCE(SUM(CASE WHEN value->>'active_minutes' IS NOT NULL THEN (value->>'active_minutes')::NUMERIC ELSE 0 END), 0)
    INTO v_steps_total, v_hr_samples, v_steps_active
    FROM health_entries
    WHERE entry_type = 'steps'
      AND timestamp::date = target_date;

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
      AND timestamp::date = target_date;

    -- Weight (latest reading for the day)
    SELECT numeric_value
    INTO v_weight_kg
    FROM health_entries
    WHERE entry_type = 'weight'
      AND numeric_value IS NOT NULL
      AND timestamp::date = target_date
    ORDER BY timestamp DESC
    LIMIT 1;

    -- Exercise
    SELECT
        COUNT(*),
        COALESCE(SUM(CASE WHEN duration_s IS NOT NULL THEN duration_s ELSE 0 END), 0),
        ARRAY_AGG(DISTINCT unnest(COALESCE(tags, '{}')))
    INTO v_ex_count, v_ex_minutes, v_ex_types
    FROM health_entries
    WHERE entry_type = 'exercise'
      AND timestamp::date = target_date;

    -- Training (from training_logs)
    SELECT
        COUNT(*),
        COALESCE(SUM(volume_kg), 0),
        ARRAY_AGG(DISTINCT workout_type)
    INTO v_wk_count, v_wk_volume, v_wk_types
    FROM training_logs
    WHERE workout_date = target_date;

    -- Collect unique sources
    SELECT ARRAY_AGG(DISTINCT source)
    INTO v_sources
    FROM (
        SELECT source FROM health_entries
        WHERE timestamp::date = target_date
        UNION ALL
        SELECT 'iron-log'::TEXT FROM training_logs
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

-- Search health entries by vector similarity
CREATE OR REPLACE FUNCTION search_health_entries(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_entry_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID, entry_type TEXT, timestamp TIMESTAMPTZ,
    duration_s INTEGER, numeric_value NUMERIC, value JSONB, tags TEXT[],
    source TEXT, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT h.id, h.entry_type, h.timestamp,
        h.duration_s, h.numeric_value, h.value, h.tags,
        h.source,
        1 - (h.embedding <=> query_embedding) AS similarity
    FROM health_entries h
    WHERE h.embedding IS NOT NULL
      AND (1 - (h.embedding <=> query_embedding)) > match_threshold
      AND (filter_entry_type IS NULL OR h.entry_type = filter_entry_type)
    ORDER BY h.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Search training logs by vector similarity
CREATE OR REPLACE FUNCTION search_training_logs(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_workout_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID, workout_date DATE, workout_type TEXT, name TEXT,
    exercises JSONB, volume_kg NUMERIC, numeric_value NUMERIC, rpe SMALLINT, notes TEXT,
    tags TEXT[], duration_s INTEGER, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.workout_date, t.workout_type, t.name,
        t.exercises, t.volume_kg, t.numeric_value, t.rpe, t.notes,
        t.tags, t.duration_s,
        1 - (t.embedding <=> query_embedding) AS similarity
    FROM training_logs t
    WHERE t.embedding IS NOT NULL
      AND (1 - (t.embedding <=> query_embedding)) > match_threshold
      AND (filter_workout_type IS NULL OR t.workout_type = filter_workout_type)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE TRIGGER memories_updated_at
    BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER projects_updated_at
    BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER training_logs_updated_at
    BEFORE UPDATE ON training_logs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER entities_updated_at
    BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES
-- ============================================================

-- Service role: full access to all tables
CREATE POLICY "service_role_full_access" ON memories
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON projects
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON profile
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON health_entries
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON training_logs
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON health_summaries
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON entities
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON entity_mentions
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON sync_log
    FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users: profile
CREATE POLICY "users_read_own_profile" ON profile
    FOR SELECT USING (
        auth.uid() = owner_id
        OR owner_id IS NULL
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_insert_own_profile" ON profile
    FOR INSERT WITH CHECK (
        auth.uid() = owner_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_update_own_profile" ON profile
    FOR UPDATE USING (
        auth.uid() = owner_id
        OR auth.role() = 'service_role'
    );

-- Authenticated users: memories
CREATE POLICY "users_read_own_memories" ON memories
    FOR SELECT USING (
        auth.uid() = user_id
        OR user_id IS NULL
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_insert_own_memories" ON memories
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_update_own_memories" ON memories
    FOR UPDATE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_delete_own_memories" ON memories
    FOR DELETE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );

-- Authenticated users: health entries
CREATE POLICY "users_read_own_health" ON health_entries
    FOR SELECT USING (
        auth.uid() = user_id
        OR user_id IS NULL
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_insert_own_health" ON health_entries
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_update_own_health" ON health_entries
    FOR UPDATE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_delete_own_health" ON health_entries
    FOR DELETE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );

-- Authenticated users: training logs
CREATE POLICY "users_read_own_training" ON training_logs
    FOR SELECT USING (
        auth.uid() = user_id
        OR user_id IS NULL
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_insert_own_training" ON training_logs
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_update_own_training" ON training_logs
    FOR UPDATE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_delete_own_training" ON training_logs
    FOR DELETE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );

-- Authenticated users: projects
CREATE POLICY "users_read_own_projects" ON projects
    FOR SELECT USING (
        auth.uid() = user_id
        OR user_id IS NULL
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_insert_own_projects" ON projects
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
CREATE POLICY "users_update_own_projects" ON projects
    FOR UPDATE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );

-- ============================================================
-- GRANTS
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_summaries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_mentions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_log TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO authenticated;
GRANT SELECT ON entities TO authenticated;
GRANT SELECT ON entity_mentions TO authenticated;
GRANT SELECT ON health_summaries TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
