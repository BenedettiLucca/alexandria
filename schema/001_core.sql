-- ============================================================
-- Alexandria: Core Schema
-- Personal context store for multi-AI shared memory
-- ============================================================
-- Run these in order in your Supabase SQL Editor:
--   001_core.sql (this file)
--   002_security.sql
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- MEMORIES -- personal notes, observations, ideas, decisions
-- ============================================================
CREATE TABLE memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
                    'samsung-health', 'iron-log', 'auto'
                )),
    importance  SMALLINT DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
    tags        TEXT[] DEFAULT '{}',
    people      TEXT[] DEFAULT '{}',
    dates       TEXT[] DEFAULT '{}',
    metadata    JSONB DEFAULT '{}',
    content_fingerprint TEXT,
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- PROJECTS -- codebase context, architecture decisions
-- ============================================================
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    path        TEXT,
    description TEXT,
    stack       TEXT[] DEFAULT '{}',
    conventions JSONB DEFAULT '{}',
    decisions   JSONB DEFAULT '[]',
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- PROFILE -- who you are, preferences, conventions
-- ============================================================
CREATE TABLE profile (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT NOT NULL UNIQUE,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- HEALTH -- Samsung Health data
-- ============================================================
CREATE TABLE health_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_type  TEXT NOT NULL
                CHECK (entry_type IN (
                    'sleep', 'exercise', 'heart_rate', 'steps',
                    'weight', 'water', 'nutrition', 'blood_pressure',
                    'stress', 'cycle'
                )),
    timestamp   TIMESTAMPTZ NOT NULL,
    duration_s  INTEGER,
    value       JSONB NOT NULL DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    source      TEXT DEFAULT 'samsung-health',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- TRAINING -- Iron-Log workout data
-- ============================================================
CREATE TABLE training_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workout_date DATE NOT NULL,
    workout_type TEXT NOT NULL,
    name        TEXT NOT NULL,
    exercises   JSONB NOT NULL DEFAULT '[]',
    duration_s  INTEGER,
    volume_kg   NUMERIC(8,2),
    rpe         SMALLINT CHECK (rpe BETWEEN 1 AND 10),
    notes       TEXT,
    tags        TEXT[] DEFAULT '{}',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_memories_embedding ON memories
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_memories_metadata ON memories USING gin (metadata);
CREATE INDEX idx_memories_tags ON memories USING gin (tags);
CREATE INDEX idx_memories_category ON memories (category);
CREATE INDEX idx_memories_source ON memories (source);
CREATE INDEX idx_memories_importance ON memories (importance DESC);
CREATE INDEX idx_memories_created ON memories (created_at DESC);
CREATE UNIQUE INDEX idx_memories_fingerprint
    ON memories (content_fingerprint)
    WHERE content_fingerprint IS NOT NULL;
CREATE INDEX idx_projects_name ON projects (name);
CREATE INDEX idx_projects_status ON projects (status);
CREATE INDEX idx_health_type_ts ON health_entries (entry_type, timestamp DESC);
CREATE INDEX idx_health_timestamp ON health_entries (timestamp DESC);
CREATE INDEX idx_health_metadata ON health_entries USING gin (metadata);
CREATE INDEX idx_training_date ON training_logs (workout_date DESC);
CREATE INDEX idx_training_type ON training_logs (workout_type);
CREATE INDEX idx_training_metadata ON training_logs USING gin (metadata);

-- ============================================================
-- AUTO-UPDATE TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_updated_at
    BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER projects_updated_at
    BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER training_logs_updated_at
    BEFORE UPDATE ON training_logs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- SEARCH FUNCTIONS
-- ============================================================
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
    FROM memories m WHERE m.content_fingerprint = v_fingerprint;
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
    INSERT INTO memories (content, title, category, source, importance, tags, people, metadata, content_fingerprint)
    VALUES (p_content, p_title, p_category, p_source, p_importance, p_tags, p_people, p_metadata, v_fingerprint)
    RETURNING jsonb_build_object('id', id, 'status', 'created') INTO v_new_id;
    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;
