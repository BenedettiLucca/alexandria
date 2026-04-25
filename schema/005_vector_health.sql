-- ============================================================
-- Alexandria: Vector Search for Health & Training (Phase 5)
-- Run after 001_core.sql
-- ============================================================

ALTER TABLE health_entries ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_health_entries_embedding
    ON health_entries USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_training_logs_embedding
    ON training_logs USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- SEARCH HEALTH ENTRIES
-- ============================================================
CREATE OR REPLACE FUNCTION search_health_entries(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_entry_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID, entry_type TEXT, timestamp TIMESTAMPTZ, event_time TIMESTAMPTZ,
    duration_s INTEGER, numeric_value NUMERIC, value JSONB, tags TEXT[],
    source TEXT, ingestion_source TEXT, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT h.id, h.entry_type, h.timestamp, h.event_time,
        h.duration_s, h.numeric_value, h.value, h.tags,
        h.source, h.ingestion_source,
        1 - (h.embedding <=> query_embedding) AS similarity
    FROM health_entries h
    WHERE h.embedding IS NOT NULL
      AND (1 - (h.embedding <=> query_embedding)) > match_threshold
      AND (filter_entry_type IS NULL OR h.entry_type = filter_entry_type)
    ORDER BY h.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================
-- SEARCH TRAINING LOGS
-- ============================================================
CREATE OR REPLACE FUNCTION search_training_logs(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_workout_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID, workout_date DATE, workout_type TEXT, name TEXT,
    exercises JSONB, volume_kg NUMERIC, rpe SMALLINT, notes TEXT,
    tags TEXT[], duration_s INTEGER, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.workout_date, t.workout_type, t.name,
        t.exercises, t.volume_kg, t.rpe, t.notes,
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
