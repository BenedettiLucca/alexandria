CREATE TABLE IF NOT EXISTS briefs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES auth.users(id),
    source_job    TEXT NOT NULL,
    title         TEXT NOT NULL,
    brief_date    DATE NOT NULL,
    kind          TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    topics        TEXT[] DEFAULT '{}',
    project_refs  TEXT[] DEFAULT '{}',
    entity_refs   TEXT[] DEFAULT '{}',
    content_hash  TEXT NOT NULL UNIQUE,
    embedding     vector(1536),
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_briefs_date ON briefs (brief_date DESC);
CREATE INDEX IF NOT EXISTS idx_briefs_kind ON briefs (kind);
CREATE INDEX IF NOT EXISTS idx_briefs_source_job ON briefs (source_job);
CREATE INDEX IF NOT EXISTS idx_briefs_topics ON briefs USING gin (topics);
CREATE INDEX IF NOT EXISTS idx_briefs_project_refs ON briefs USING gin (project_refs);
CREATE INDEX IF NOT EXISTS idx_briefs_entity_refs ON briefs USING gin (entity_refs);
CREATE INDEX IF NOT EXISTS idx_briefs_metadata ON briefs USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_briefs_user_id ON briefs(user_id);
CREATE INDEX IF NOT EXISTS idx_briefs_embedding ON briefs
    USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION search_briefs(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.4,
    match_count INT DEFAULT 10,
    filter_kind TEXT DEFAULT NULL,
    filter_source_job TEXT DEFAULT NULL,
    filter_date_from DATE DEFAULT NULL,
    filter_date_to DATE DEFAULT NULL,
    filter_topics TEXT[] DEFAULT NULL,
    filter_project_refs TEXT[] DEFAULT NULL,
    filter_entity_refs TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    source_job TEXT,
    title TEXT,
    brief_date DATE,
    kind TEXT,
    body_markdown TEXT,
    topics TEXT[],
    project_refs TEXT[],
    entity_refs TEXT[],
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT b.id, b.source_job, b.title, b.brief_date, b.kind, b.body_markdown,
        b.topics, b.project_refs, b.entity_refs, b.metadata,
        1 - (b.embedding <=> query_embedding) AS similarity,
        b.created_at
    FROM briefs b
    WHERE (1 - (b.embedding <=> query_embedding)) > match_threshold
      AND (filter_kind IS NULL OR b.kind = filter_kind)
      AND (filter_source_job IS NULL OR b.source_job = filter_source_job)
      AND (filter_date_from IS NULL OR b.brief_date >= filter_date_from)
      AND (filter_date_to IS NULL OR b.brief_date <= filter_date_to)
      AND (filter_topics IS NULL OR b.topics @> filter_topics)
      AND (filter_project_refs IS NULL OR b.project_refs @> filter_project_refs)
      AND (filter_entity_refs IS NULL OR b.entity_refs @> filter_entity_refs)
    ORDER BY b.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

DROP TRIGGER IF EXISTS briefs_updated_at ON briefs;
CREATE TRIGGER briefs_updated_at
    BEFORE UPDATE ON briefs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON briefs;
CREATE POLICY "service_role_full_access" ON briefs
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "users_read_own_briefs" ON briefs;
CREATE POLICY "users_read_own_briefs" ON briefs
    FOR SELECT USING (
        auth.uid() = user_id
        OR user_id IS NULL
        OR auth.role() = 'service_role'
    );
DROP POLICY IF EXISTS "users_insert_own_briefs" ON briefs;
CREATE POLICY "users_insert_own_briefs" ON briefs
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
DROP POLICY IF EXISTS "users_update_own_briefs" ON briefs;
CREATE POLICY "users_update_own_briefs" ON briefs
    FOR UPDATE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );
DROP POLICY IF EXISTS "users_delete_own_briefs" ON briefs;
CREATE POLICY "users_delete_own_briefs" ON briefs
    FOR DELETE USING (
        auth.uid() = user_id
        OR auth.role() = 'service_role'
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON briefs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON briefs TO authenticated;
