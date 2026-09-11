-- Migration: 20260911040000_indexing_lifecycle_and_outbox.sql
-- Task: T05B — Indexação durável e recuperável (#33, #61)
-- Scope:
--   1. Adiciona colunas de lifecycle e versionamento em memories, briefs, health_entries, training_logs.
--   2. Cria tabela durável indexing_outbox com RLS e isolamento por owner.
--   3. Triggers atômicos BEFORE e AFTER para capturar row changes de MCP tools e importers diretos.
--   4. Atualiza search RPCs (search_memories, search_briefs, search_health_entries, search_training_logs) com guard por embedding_space e status = ready.
--   5. Cria RPCs operacionais de lifecycle: claim_indexing_jobs, complete_indexing_job, backfill_indexing_jobs, get_indexing_lifecycle_status.

-- ============================================================================
-- 1. COLUNAS DE LIFECYCLE E VERSIONAMENTO NAS QUATRO TABELAS
-- ============================================================================

-- 1.1 memories
ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS embedding_space TEXT DEFAULT 'openai/text-embedding-3-small',
    ADD COLUMN IF NOT EXISTS embedding_version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending', 'processing', 'ready', 'failed', 'none')),
    ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

-- 1.2 briefs
ALTER TABLE briefs
    ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS embedding_space TEXT DEFAULT 'openai/text-embedding-3-small',
    ADD COLUMN IF NOT EXISTS embedding_version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- 1.3 health_entries
ALTER TABLE health_entries
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS embedding_space TEXT DEFAULT 'openai/text-embedding-3-small',
    ADD COLUMN IF NOT EXISTS embedding_version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- 1.4 training_logs
ALTER TABLE training_logs
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS embedding_space TEXT DEFAULT 'openai/text-embedding-3-small',
    ADD COLUMN IF NOT EXISTS embedding_version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- Backfill hashes para registros legados que não possuem content_hash
UPDATE health_entries
SET content_hash = encode(sha256((entry_type || ':' || timestamp::text || ':' || value::text || ':' || COALESCE(numeric_value::text, ''))::bytea), 'hex')
WHERE content_hash IS NULL;

UPDATE training_logs
SET content_hash = encode(sha256((workout_date::text || ':' || name || ':' || workout_type || ':' || exercises::text || ':' || COALESCE(notes, ''))::bytea), 'hex')
WHERE content_hash IS NULL;

-- Alinha estado de registros preexistentes que já possuíam vetor
UPDATE memories
SET embedding_status = 'ready',
    embedding_space = 'openai/text-embedding-3-small',
    embedded_at = COALESCE(embedded_at, updated_at)
WHERE embedding IS NOT NULL;

UPDATE briefs
SET embedding_status = 'ready',
    embedding_space = 'openai/text-embedding-3-small',
    embedded_at = COALESCE(embedded_at, updated_at)
WHERE embedding IS NOT NULL;

UPDATE health_entries
SET embedding_status = 'ready',
    embedding_space = 'openai/text-embedding-3-small',
    embedded_at = COALESCE(embedded_at, created_at)
WHERE embedding IS NOT NULL;

UPDATE training_logs
SET embedding_status = 'ready',
    embedding_space = 'openai/text-embedding-3-small',
    embedded_at = COALESCE(embedded_at, updated_at)
WHERE embedding IS NOT NULL;

-- Registros de memórias com menções existentes marcam enrichment como ready
UPDATE memories
SET enrichment_status = 'ready',
    enriched_at = COALESCE(enriched_at, updated_at)
WHERE id IN (SELECT DISTINCT memory_id FROM entity_mentions);

-- ============================================================================
-- 2. TABELA INDEXING_OUTBOX E POLÍTICAS DE RLS
-- ============================================================================

CREATE TABLE IF NOT EXISTS indexing_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),
    source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'briefs', 'health_entries', 'training_logs')),
    source_id UUID NOT NULL,
    source_version INT NOT NULL DEFAULT 1,
    content_hash TEXT NOT NULL,
    target_space TEXT NOT NULL DEFAULT 'openai/text-embedding-3-small',
    target_dimension INT NOT NULL DEFAULT 1536,
    job_type TEXT NOT NULL DEFAULT 'embedding' CHECK (job_type IN ('embedding', 'entity_enrichment')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'superseded')),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    error_class TEXT,
    locked_until TIMESTAMPTZ,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT indexing_outbox_source_job_unique UNIQUE (source_table, source_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_indexing_outbox_queue
    ON indexing_outbox (status, scheduled_at, target_space);

CREATE INDEX IF NOT EXISTS idx_indexing_outbox_owner
    ON indexing_outbox (user_id, status);

CREATE INDEX IF NOT EXISTS idx_indexing_outbox_source
    ON indexing_outbox (source_table, source_id);

ALTER TABLE indexing_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS indexing_outbox_owner_isolation ON indexing_outbox;
CREATE POLICY indexing_outbox_owner_isolation ON indexing_outbox
    FOR ALL
    USING (
        auth.role() = 'service_role'
        OR (auth.uid() IS NOT NULL AND user_id = auth.uid())
    )
    WITH CHECK (
        auth.role() = 'service_role'
        OR (auth.uid() IS NOT NULL AND user_id = auth.uid())
    );

GRANT ALL ON indexing_outbox TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON indexing_outbox TO authenticated;

-- ============================================================================
-- 3. TRIGGERS ATÔMICOS NAS QUATRO TABELAS (BEFORE + AFTER)
-- ============================================================================

-- 3.1 MEMORIES TRIGGERS
CREATE OR REPLACE FUNCTION trg_memories_indexing_lifecycle_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := encode(sha256(NEW.content::bytea), 'hex');
    IF TG_OP = 'INSERT' THEN
        IF NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
            NEW.embedded_at := COALESCE(NEW.embedded_at, now());
        ELSE
            NEW.embedding_status := 'pending';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
        END IF;
        NEW.embedding_version := COALESCE(NEW.embedding_version, 1);
        NEW.enrichment_status := COALESCE(NEW.enrichment_status, 'pending');
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.content IS DISTINCT FROM OLD.content THEN
            NEW.embedding_version := OLD.embedding_version + 1;
            IF NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
                NEW.embedding_status := 'pending';
            ELSE
                NEW.embedding_status := 'ready';
                NEW.embedded_at := now();
            END IF;
            NEW.enrichment_status := 'pending';
        ELSIF NEW.embedding IS DISTINCT FROM OLD.embedding AND NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedded_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_memories_indexing_before ON memories;
CREATE TRIGGER trigger_memories_indexing_before
    BEFORE INSERT OR UPDATE ON memories
    FOR EACH ROW
    EXECUTE FUNCTION trg_memories_indexing_lifecycle_before();

-- 3.2 BRIEFS TRIGGERS
CREATE OR REPLACE FUNCTION trg_briefs_indexing_lifecycle_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.content_hash IS NULL THEN
        NEW.content_hash := encode(sha256((NEW.title || E'\n' || NEW.body_markdown)::bytea), 'hex');
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
            NEW.embedded_at := COALESCE(NEW.embedded_at, now());
        ELSE
            NEW.embedding_status := 'pending';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
        END IF;
        NEW.embedding_version := COALESCE(NEW.embedding_version, 1);
    ELSIF TG_OP = 'UPDATE' THEN
        IF (NEW.body_markdown IS DISTINCT FROM OLD.body_markdown) OR (NEW.title IS DISTINCT FROM OLD.title) THEN
            NEW.content_hash := encode(sha256((NEW.title || E'\n' || NEW.body_markdown)::bytea), 'hex');
            NEW.embedding_version := OLD.embedding_version + 1;
            IF NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
                NEW.embedding_status := 'pending';
            ELSE
                NEW.embedding_status := 'ready';
                NEW.embedded_at := now();
            END IF;
        ELSIF NEW.embedding IS DISTINCT FROM OLD.embedding AND NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedded_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_briefs_indexing_before ON briefs;
CREATE TRIGGER trigger_briefs_indexing_before
    BEFORE INSERT OR UPDATE ON briefs
    FOR EACH ROW
    EXECUTE FUNCTION trg_briefs_indexing_lifecycle_before();

-- 3.3 HEALTH_ENTRIES TRIGGERS
CREATE OR REPLACE FUNCTION trg_health_indexing_lifecycle_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := encode(sha256((NEW.entry_type || ':' || NEW.timestamp::text || ':' || NEW.value::text || ':' || COALESCE(NEW.numeric_value::text, ''))::bytea), 'hex');

    IF TG_OP = 'INSERT' THEN
        IF NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
            NEW.embedded_at := COALESCE(NEW.embedded_at, now());
        ELSE
            NEW.embedding_status := 'pending';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
        END IF;
        NEW.embedding_version := COALESCE(NEW.embedding_version, 1);
    ELSIF TG_OP = 'UPDATE' THEN
        IF (NEW.value IS DISTINCT FROM OLD.value) OR (NEW.entry_type IS DISTINCT FROM OLD.entry_type) OR (NEW.numeric_value IS DISTINCT FROM OLD.numeric_value) THEN
            NEW.embedding_version := OLD.embedding_version + 1;
            IF NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
                NEW.embedding_status := 'pending';
            ELSE
                NEW.embedding_status := 'ready';
                NEW.embedded_at := now();
            END IF;
        ELSIF NEW.embedding IS DISTINCT FROM OLD.embedding AND NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedded_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_health_indexing_before ON health_entries;
CREATE TRIGGER trigger_health_indexing_before
    BEFORE INSERT OR UPDATE ON health_entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_health_indexing_lifecycle_before();

-- 3.4 TRAINING_LOGS TRIGGERS
CREATE OR REPLACE FUNCTION trg_training_indexing_lifecycle_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := encode(sha256((NEW.workout_date::text || ':' || NEW.name || ':' || NEW.workout_type || ':' || NEW.exercises::text || ':' || COALESCE(NEW.notes, ''))::bytea), 'hex');

    IF TG_OP = 'INSERT' THEN
        IF NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
            NEW.embedded_at := COALESCE(NEW.embedded_at, now());
        ELSE
            NEW.embedding_status := 'pending';
            NEW.embedding_space := COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small');
        END IF;
        NEW.embedding_version := COALESCE(NEW.embedding_version, 1);
    ELSIF TG_OP = 'UPDATE' THEN
        IF (NEW.exercises IS DISTINCT FROM OLD.exercises) OR (NEW.name IS DISTINCT FROM OLD.name) OR (NEW.workout_type IS DISTINCT FROM OLD.workout_type) OR (NEW.notes IS DISTINCT FROM OLD.notes) OR (NEW.volume_kg IS DISTINCT FROM OLD.volume_kg) THEN
            NEW.embedding_version := OLD.embedding_version + 1;
            IF NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
                NEW.embedding_status := 'pending';
            ELSE
                NEW.embedding_status := 'ready';
                NEW.embedded_at := now();
            END IF;
        ELSIF NEW.embedding IS DISTINCT FROM OLD.embedding AND NEW.embedding IS NOT NULL THEN
            NEW.embedding_status := 'ready';
            NEW.embedded_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_training_indexing_before ON training_logs;
CREATE TRIGGER trigger_training_indexing_before
    BEFORE INSERT OR UPDATE ON training_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_training_indexing_lifecycle_before();

-- 3.5 TRIGGER UNIFICADO AFTER INSERT OR UPDATE -> INDEXING_OUTBOX
CREATE OR REPLACE FUNCTION trg_indexing_outbox_after()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Job de embedding
    IF NEW.embedding_status = 'pending' THEN
        INSERT INTO indexing_outbox (
            user_id,
            source_table,
            source_id,
            source_version,
            content_hash,
            target_space,
            target_dimension,
            job_type,
            status,
            scheduled_at,
            updated_at
        ) VALUES (
            NEW.user_id,
            TG_TABLE_NAME,
            NEW.id,
            NEW.embedding_version,
            NEW.content_hash,
            COALESCE(NEW.embedding_space, 'openai/text-embedding-3-small'),
            1536,
            'embedding',
            'pending',
            now(),
            now()
        )
        ON CONFLICT (source_table, source_id, job_type) DO UPDATE
        SET
            source_version = EXCLUDED.source_version,
            content_hash = EXCLUDED.content_hash,
            target_space = EXCLUDED.target_space,
            status = 'pending',
            attempts = 0,
            last_error = NULL,
            error_class = NULL,
            scheduled_at = now(),
            updated_at = now();
    ELSIF NEW.embedding_status = 'ready' THEN
        UPDATE indexing_outbox
        SET status = 'ready',
            processed_at = now(),
            updated_at = now()
        WHERE source_table = TG_TABLE_NAME
          AND source_id = NEW.id
          AND job_type = 'embedding'
          AND status IN ('pending', 'processing');
    END IF;

    -- 2. Job de enriquecimento de entidades para memories
    IF TG_TABLE_NAME = 'memories' THEN
        IF NEW.enrichment_status = 'pending' THEN
            INSERT INTO indexing_outbox (
                user_id,
                source_table,
                source_id,
                source_version,
                content_hash,
                target_space,
                target_dimension,
                job_type,
                status,
                scheduled_at,
                updated_at
            ) VALUES (
                NEW.user_id,
                'memories',
                NEW.id,
                NEW.embedding_version,
                NEW.content_hash,
                'entity-enrichment-v1',
                0,
                'entity_enrichment',
                'pending',
                now(),
                now()
            )
            ON CONFLICT (source_table, source_id, job_type) DO UPDATE
            SET
                source_version = EXCLUDED.source_version,
                content_hash = EXCLUDED.content_hash,
                status = 'pending',
                attempts = 0,
                last_error = NULL,
                error_class = NULL,
                scheduled_at = now(),
                updated_at = now();
        ELSIF NEW.enrichment_status = 'ready' THEN
            UPDATE indexing_outbox
            SET status = 'ready',
                processed_at = now(),
                updated_at = now()
            WHERE source_table = 'memories'
              AND source_id = NEW.id
              AND job_type = 'entity_enrichment'
              AND status IN ('pending', 'processing');
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_memories_indexing_after ON memories;
CREATE TRIGGER trigger_memories_indexing_after
    AFTER INSERT OR UPDATE ON memories
    FOR EACH ROW
    EXECUTE FUNCTION trg_indexing_outbox_after();

DROP TRIGGER IF EXISTS trigger_briefs_indexing_after ON briefs;
CREATE TRIGGER trigger_briefs_indexing_after
    AFTER INSERT OR UPDATE ON briefs
    FOR EACH ROW
    EXECUTE FUNCTION trg_indexing_outbox_after();

DROP TRIGGER IF EXISTS trigger_health_indexing_after ON health_entries;
CREATE TRIGGER trigger_health_indexing_after
    AFTER INSERT OR UPDATE ON health_entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_indexing_outbox_after();

DROP TRIGGER IF EXISTS trigger_training_indexing_after ON training_logs;
CREATE TRIGGER trigger_training_indexing_after
    AFTER INSERT OR UPDATE ON training_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_indexing_outbox_after();

-- ============================================================================
-- 4. SEARCH RPCS COM GUARD DE SPACE E STATUS READY
-- ============================================================================

-- Remove versões anteriores das funções para permitir a nova assinatura única com default
DROP FUNCTION IF EXISTS search_memories(vector, double precision, integer, text, text[], uuid);
DROP FUNCTION IF EXISTS search_memories(vector, double precision, integer, text, text[], uuid, text);
DROP FUNCTION IF EXISTS search_briefs(vector, double precision, integer, text, text, date, date, text[], text[], text[], uuid);
DROP FUNCTION IF EXISTS search_briefs(vector, double precision, integer, text, text, date, date, text[], text[], text[], uuid, text);
DROP FUNCTION IF EXISTS search_health_entries(vector, double precision, integer, text, uuid);
DROP FUNCTION IF EXISTS search_health_entries(vector, double precision, integer, text, uuid, text);
DROP FUNCTION IF EXISTS search_training_logs(vector, double precision, integer, text, uuid);
DROP FUNCTION IF EXISTS search_training_logs(vector, double precision, integer, text, uuid, text);

-- 4.1 search_memories
CREATE OR REPLACE FUNCTION search_memories(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter_category TEXT DEFAULT NULL,
    filter_tags TEXT[] DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_space TEXT DEFAULT 'openai/text-embedding-3-small'
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    title TEXT,
    category TEXT,
    source TEXT,
    importance SMALLINT,
    tags TEXT[],
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_space TEXT;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;
    v_space := COALESCE(p_space, 'openai/text-embedding-3-small');

    RETURN QUERY
    SELECT
        m.id,
        m.content,
        m.title,
        m.category,
        m.source,
        m.importance,
        m.tags,
        m.metadata,
        (1 - (m.embedding <=> query_embedding))::FLOAT AS similarity,
        m.created_at
    FROM memories m
    WHERE m.user_id = v_owner
      AND m.embedding IS NOT NULL
      AND m.embedding_status = 'ready'
      AND m.embedding_space = v_space
      AND (1 - (m.embedding <=> query_embedding)) > match_threshold
      AND (filter_category IS NULL OR m.category = filter_category)
      AND (filter_tags IS NULL OR m.tags @> filter_tags)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 4.2 search_briefs
CREATE OR REPLACE FUNCTION search_briefs(
    query_embedding vector(1536),
    match_threshold float DEFAULT 0.4,
    match_count int DEFAULT 10,
    filter_kind text DEFAULT NULL,
    filter_source_job text DEFAULT NULL,
    filter_date_from date DEFAULT NULL,
    filter_date_to date DEFAULT NULL,
    filter_topics text[] DEFAULT NULL,
    filter_project_refs text[] DEFAULT NULL,
    filter_entity_refs text[] DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_space TEXT DEFAULT 'openai/text-embedding-3-small'
)
RETURNS TABLE (
    id uuid,
    source_job text,
    title text,
    brief_date date,
    kind text,
    body_markdown text,
    topics text[],
    project_refs text[],
    entity_refs text[],
    metadata jsonb,
    similarity float,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_space TEXT;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;
    v_space := COALESCE(p_space, 'openai/text-embedding-3-small');

    RETURN QUERY
    SELECT
        b.id,
        b.source_job,
        b.title,
        b.brief_date,
        b.kind,
        b.body_markdown,
        b.topics,
        b.project_refs,
        b.entity_refs,
        b.metadata,
        (1 - (b.embedding <=> query_embedding))::float AS similarity,
        b.created_at
    FROM briefs b
    WHERE b.user_id = v_owner
      AND b.embedding IS NOT NULL
      AND b.embedding_status = 'ready'
      AND b.embedding_space = v_space
      AND (1 - (b.embedding <=> query_embedding)) > match_threshold
      AND (filter_kind IS NULL OR b.kind = filter_kind)
      AND (filter_source_job IS NULL OR b.source_job = filter_source_job)
      AND (filter_date_from IS NULL OR b.brief_date >= filter_date_from)
      AND (filter_date_to IS NULL OR b.brief_date <= filter_date_to)
      AND (filter_topics IS NULL OR b.topics && filter_topics)
      AND (filter_project_refs IS NULL OR b.project_refs && filter_project_refs)
      AND (filter_entity_refs IS NULL OR b.entity_refs && filter_entity_refs)
    ORDER BY b.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 4.3 search_health_entries
CREATE OR REPLACE FUNCTION search_health_entries(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_entry_type TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_space TEXT DEFAULT 'openai/text-embedding-3-small'
)
RETURNS TABLE (
    id UUID,
    entry_type TEXT,
    "timestamp" TIMESTAMPTZ,
    duration_s INTEGER,
    numeric_value NUMERIC,
    value JSONB,
    tags TEXT[],
    source TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_space TEXT;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;
    v_space := COALESCE(p_space, 'openai/text-embedding-3-small');

    RETURN QUERY
    SELECT
        h.id,
        h.entry_type,
        h.timestamp,
        h.duration_s,
        h.numeric_value,
        h.value,
        h.tags,
        h.source,
        (1 - (h.embedding <=> query_embedding))::FLOAT AS similarity
    FROM health_entries h
    WHERE h.user_id = v_owner
      AND h.embedding IS NOT NULL
      AND h.embedding_status = 'ready'
      AND h.embedding_space = v_space
      AND (1 - (h.embedding <=> query_embedding)) > match_threshold
      AND (filter_entry_type IS NULL OR h.entry_type = filter_entry_type)
    ORDER BY h.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 4.4 search_training_logs
CREATE OR REPLACE FUNCTION search_training_logs(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_workout_type TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_space TEXT DEFAULT 'openai/text-embedding-3-small'
)
RETURNS TABLE (
    id UUID,
    workout_date DATE,
    workout_type TEXT,
    name TEXT,
    exercises JSONB,
    volume_kg NUMERIC,
    numeric_value NUMERIC,
    rpe SMALLINT,
    notes TEXT,
    tags TEXT[],
    duration_s INTEGER,
    similarity FLOAT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_space TEXT;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;
    v_space := COALESCE(p_space, 'openai/text-embedding-3-small');

    RETURN QUERY
    SELECT
        t.id,
        t.workout_date,
        t.workout_type,
        t.name,
        t.exercises,
        t.volume_kg,
        t.numeric_value,
        t.rpe,
        t.notes,
        t.tags,
        t.duration_s,
        (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity
    FROM training_logs t
    WHERE t.user_id = v_owner
      AND t.embedding IS NOT NULL
      AND t.embedding_status = 'ready'
      AND t.embedding_space = v_space
      AND (1 - (t.embedding <=> query_embedding)) > match_threshold
      AND (filter_workout_type IS NULL OR t.workout_type = filter_workout_type)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_memories TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION search_briefs TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION search_health_entries TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION search_training_logs TO authenticated, service_role, anon;

-- ============================================================================
-- 5. RPCS OPERACIONAIS DO LIFECYCLE (CLAIM, COMPLETE, BACKFILL, STATUS)
-- ============================================================================

-- 5.1 claim_indexing_jobs: reserva transacional de lote (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_indexing_jobs(
    p_limit INT DEFAULT 20,
    p_target_space TEXT DEFAULT 'openai/text-embedding-3-small',
    p_owner_id UUID DEFAULT NULL,
    p_lock_seconds INT DEFAULT 60
)
RETURNS TABLE (
    id UUID,
    user_id UUID,
    source_table TEXT,
    source_id UUID,
    source_version INT,
    content_hash TEXT,
    target_space TEXT,
    target_dimension INT,
    job_type TEXT,
    status TEXT,
    attempts INT,
    max_attempts INT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
BEGIN
    v_owner := COALESCE(auth.uid(), p_owner_id);
    
    RETURN QUERY
    WITH candidate AS (
        SELECT o.id
        FROM indexing_outbox o
        WHERE (v_owner IS NULL OR o.user_id = v_owner)
          AND (o.target_space = p_target_space OR o.job_type = 'entity_enrichment')
          AND o.status IN ('pending', 'processing')
          AND (
              (o.status = 'pending' AND o.scheduled_at <= now())
              OR
              (o.status = 'processing' AND o.locked_until < now())
          )
          AND o.attempts < o.max_attempts
        ORDER BY o.scheduled_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(p_limit, 100)
    )
    UPDATE indexing_outbox o
    SET status = 'processing',
        locked_until = now() + (p_lock_seconds || ' seconds')::interval,
        updated_at = now()
    FROM candidate
    WHERE o.id = candidate.id
    RETURNING
        o.id,
        o.user_id,
        o.source_table,
        o.source_id,
        o.source_version,
        o.content_hash,
        o.target_space,
        o.target_dimension,
        o.job_type,
        o.status,
        o.attempts,
        o.max_attempts;
END;
$$;

-- 5.2 complete_indexing_job: atualiza status do job com retry/backoff
CREATE OR REPLACE FUNCTION complete_indexing_job(
    p_job_id UUID,
    p_status TEXT,
    p_error TEXT DEFAULT NULL,
    p_error_class TEXT DEFAULT NULL,
    p_backoff_seconds INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_job RECORD;
    v_new_attempts INT;
    v_final_status TEXT;
    v_next_schedule TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_job
    FROM indexing_outbox
    WHERE id = p_job_id;

    IF v_job.id IS NULL THEN
        RAISE EXCEPTION 'Job % not found in indexing_outbox', p_job_id;
    END IF;

    IF p_status = 'ready' THEN
        UPDATE indexing_outbox
        SET status = 'ready',
            processed_at = now(),
            last_error = NULL,
            error_class = NULL,
            locked_until = NULL,
            updated_at = now()
        WHERE id = p_job_id;
        RETURN jsonb_build_object('id', p_job_id, 'status', 'ready');
    ELSIF p_status = 'superseded' THEN
        UPDATE indexing_outbox
        SET status = 'superseded',
            processed_at = now(),
            last_error = p_error,
            error_class = p_error_class,
            locked_until = NULL,
            updated_at = now()
        WHERE id = p_job_id;
        RETURN jsonb_build_object('id', p_job_id, 'status', 'superseded');
    ELSE
        -- Failure handling with retry
        v_new_attempts := v_job.attempts + 1;
        IF v_new_attempts >= v_job.max_attempts THEN
            v_final_status := 'failed';
            v_next_schedule := now();

            -- Atualiza tabela fonte se excedeu max_attempts
            IF v_job.job_type = 'embedding' THEN
                IF v_job.source_table = 'memories' THEN
                    UPDATE memories SET embedding_status = 'failed' WHERE id = v_job.source_id AND embedding_version = v_job.source_version;
                ELSIF v_job.source_table = 'briefs' THEN
                    UPDATE briefs SET embedding_status = 'failed' WHERE id = v_job.source_id AND embedding_version = v_job.source_version;
                ELSIF v_job.source_table = 'health_entries' THEN
                    UPDATE health_entries SET embedding_status = 'failed' WHERE id = v_job.source_id AND embedding_version = v_job.source_version;
                ELSIF v_job.source_table = 'training_logs' THEN
                    UPDATE training_logs SET embedding_status = 'failed' WHERE id = v_job.source_id AND embedding_version = v_job.source_version;
                END IF;
            ELSIF v_job.job_type = 'entity_enrichment' AND v_job.source_table = 'memories' THEN
                UPDATE memories SET enrichment_status = 'failed' WHERE id = v_job.source_id AND embedding_version = v_job.source_version;
            END IF;
        ELSE
            v_final_status := 'pending';
            v_next_schedule := now() + (COALESCE(p_backoff_seconds, power(2, v_new_attempts)::int) || ' seconds')::interval;
        END IF;

        UPDATE indexing_outbox
        SET status = v_final_status,
            attempts = v_new_attempts,
            last_error = p_error,
            error_class = p_error_class,
            scheduled_at = v_next_schedule,
            locked_until = NULL,
            updated_at = now()
        WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'id', p_job_id,
            'status', v_final_status,
            'attempts', v_new_attempts,
            'error_class', p_error_class
        );
    END IF;
END;
$$;

-- 5.3 backfill_indexing_jobs: backfill explícito e orçado para dados legados
CREATE OR REPLACE FUNCTION backfill_indexing_jobs(
    p_space TEXT,
    p_budget_limit INT,
    p_source_table TEXT DEFAULT NULL,
    p_owner_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_queued INT := 0;
    v_remaining_budget INT;
    v_table_counts JSONB := '{}'::jsonb;
    v_count INT;
BEGIN
    v_owner := COALESCE(auth.uid(), p_owner_id);
    IF v_owner IS NULL AND auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Backfill requires an authenticated owner or service_role';
    END IF;

    IF p_space IS NULL OR trim(p_space) = '' THEN
        RAISE EXCEPTION 'Explicit target space is required for legacy backfill';
    END IF;

    IF p_budget_limit IS NULL OR p_budget_limit <= 0 THEN
        RAISE EXCEPTION 'Explicit positive budget limit is required for legacy backfill';
    END IF;

    v_remaining_budget := LEAST(p_budget_limit, 1000);

    -- 1. memories
    IF (p_source_table IS NULL OR p_source_table = 'memories') AND v_remaining_budget > 0 THEN
        WITH queued_memories AS (
            SELECT m.id, m.user_id, m.embedding_version, m.content_hash
            FROM memories m
            WHERE (v_owner IS NULL OR m.user_id = v_owner)
              AND (m.embedding IS NULL OR m.embedding_space <> p_space OR m.embedding_status <> 'ready')
            ORDER BY m.created_at ASC
            LIMIT v_remaining_budget
        )
        INSERT INTO indexing_outbox (
            user_id, source_table, source_id, source_version, content_hash, target_space, target_dimension, job_type, status, scheduled_at
        )
        SELECT
            qm.user_id, 'memories', qm.id, qm.embedding_version, qm.content_hash, p_space, 1536, 'embedding', 'pending', now()
        FROM queued_memories qm
        ON CONFLICT (source_table, source_id, job_type) DO UPDATE
        SET status = 'pending',
            target_space = EXCLUDED.target_space,
            attempts = 0,
            scheduled_at = now()
        RETURNING 1;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_queued := v_queued + v_count;
        v_remaining_budget := v_remaining_budget - v_count;
        v_table_counts := jsonb_set(v_table_counts, '{memories}', to_jsonb(v_count));
    END IF;

    -- 2. briefs
    IF (p_source_table IS NULL OR p_source_table = 'briefs') AND v_remaining_budget > 0 THEN
        WITH queued_briefs AS (
            SELECT b.id, b.user_id, b.embedding_version, b.content_hash
            FROM briefs b
            WHERE (v_owner IS NULL OR b.user_id = v_owner)
              AND (b.embedding IS NULL OR b.embedding_space <> p_space OR b.embedding_status <> 'ready')
            ORDER BY b.created_at ASC
            LIMIT v_remaining_budget
        )
        INSERT INTO indexing_outbox (
            user_id, source_table, source_id, source_version, content_hash, target_space, target_dimension, job_type, status, scheduled_at
        )
        SELECT
            qb.user_id, 'briefs', qb.id, qb.embedding_version, qb.content_hash, p_space, 1536, 'embedding', 'pending', now()
        FROM queued_briefs qb
        ON CONFLICT (source_table, source_id, job_type) DO UPDATE
        SET status = 'pending',
            target_space = EXCLUDED.target_space,
            attempts = 0,
            scheduled_at = now()
        RETURNING 1;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_queued := v_queued + v_count;
        v_remaining_budget := v_remaining_budget - v_count;
        v_table_counts := jsonb_set(v_table_counts, '{briefs}', to_jsonb(v_count));
    END IF;

    -- 3. health_entries
    IF (p_source_table IS NULL OR p_source_table = 'health_entries') AND v_remaining_budget > 0 THEN
        WITH queued_health AS (
            SELECT h.id, h.user_id, h.embedding_version, h.content_hash
            FROM health_entries h
            WHERE (v_owner IS NULL OR h.user_id = v_owner)
              AND (h.embedding IS NULL OR h.embedding_space <> p_space OR h.embedding_status <> 'ready')
            ORDER BY h.created_at ASC
            LIMIT v_remaining_budget
        )
        INSERT INTO indexing_outbox (
            user_id, source_table, source_id, source_version, content_hash, target_space, target_dimension, job_type, status, scheduled_at
        )
        SELECT
            qh.user_id, 'health_entries', qh.id, qh.embedding_version, qh.content_hash, p_space, 1536, 'embedding', 'pending', now()
        FROM queued_health qh
        ON CONFLICT (source_table, source_id, job_type) DO UPDATE
        SET status = 'pending',
            target_space = EXCLUDED.target_space,
            attempts = 0,
            scheduled_at = now()
        RETURNING 1;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_queued := v_queued + v_count;
        v_remaining_budget := v_remaining_budget - v_count;
        v_table_counts := jsonb_set(v_table_counts, '{health_entries}', to_jsonb(v_count));
    END IF;

    -- 4. training_logs
    IF (p_source_table IS NULL OR p_source_table = 'training_logs') AND v_remaining_budget > 0 THEN
        WITH queued_training AS (
            SELECT t.id, t.user_id, t.embedding_version, t.content_hash
            FROM training_logs t
            WHERE (v_owner IS NULL OR t.user_id = v_owner)
              AND (t.embedding IS NULL OR t.embedding_space <> p_space OR t.embedding_status <> 'ready')
            ORDER BY t.created_at ASC
            LIMIT v_remaining_budget
        )
        INSERT INTO indexing_outbox (
            user_id, source_table, source_id, source_version, content_hash, target_space, target_dimension, job_type, status, scheduled_at
        )
        SELECT
            qt.user_id, 'training_logs', qt.id, qt.embedding_version, qt.content_hash, p_space, 1536, 'embedding', 'pending', now()
        FROM queued_training qt
        ON CONFLICT (source_table, source_id, job_type) DO UPDATE
        SET status = 'pending',
            target_space = EXCLUDED.target_space,
            attempts = 0,
            scheduled_at = now()
        RETURNING 1;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_queued := v_queued + v_count;
        v_remaining_budget := v_remaining_budget - v_count;
        v_table_counts := jsonb_set(v_table_counts, '{training_logs}', to_jsonb(v_count));
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'target_space', p_space,
        'budget_requested', p_budget_limit,
        'total_queued', v_queued,
        'counts_by_table', v_table_counts
    );
END;
$$;

-- 5.4 get_indexing_lifecycle_status: visão observável por tabela e fila
CREATE OR REPLACE FUNCTION get_indexing_lifecycle_status(
    p_owner_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_outbox_stats JSONB;
    v_tables_stats JSONB;
BEGIN
    v_owner := COALESCE(auth.uid(), p_owner_id);

    SELECT jsonb_build_object(
        'total', count(*),
        'pending', count(*) FILTER (WHERE status = 'pending'),
        'processing', count(*) FILTER (WHERE status = 'processing'),
        'ready', count(*) FILTER (WHERE status = 'ready'),
        'failed', count(*) FILTER (WHERE status = 'failed'),
        'oldest_pending_at', min(scheduled_at) FILTER (WHERE status = 'pending')
    )
    INTO v_outbox_stats
    FROM indexing_outbox
    WHERE (v_owner IS NULL OR user_id = v_owner);

    SELECT jsonb_build_object(
        'memories', (
            SELECT jsonb_build_object(
                'total', count(*),
                'ready', count(*) FILTER (WHERE embedding_status = 'ready'),
                'pending', count(*) FILTER (WHERE embedding_status = 'pending'),
                'failed', count(*) FILTER (WHERE embedding_status = 'failed'),
                'enrichment_pending', count(*) FILTER (WHERE enrichment_status = 'pending')
            ) FROM memories WHERE (v_owner IS NULL OR user_id = v_owner)
        ),
        'briefs', (
            SELECT jsonb_build_object(
                'total', count(*),
                'ready', count(*) FILTER (WHERE embedding_status = 'ready'),
                'pending', count(*) FILTER (WHERE embedding_status = 'pending'),
                'failed', count(*) FILTER (WHERE embedding_status = 'failed')
            ) FROM briefs WHERE (v_owner IS NULL OR user_id = v_owner)
        ),
        'health_entries', (
            SELECT jsonb_build_object(
                'total', count(*),
                'ready', count(*) FILTER (WHERE embedding_status = 'ready'),
                'pending', count(*) FILTER (WHERE embedding_status = 'pending'),
                'failed', count(*) FILTER (WHERE embedding_status = 'failed')
            ) FROM health_entries WHERE (v_owner IS NULL OR user_id = v_owner)
        ),
        'training_logs', (
            SELECT jsonb_build_object(
                'total', count(*),
                'ready', count(*) FILTER (WHERE embedding_status = 'ready'),
                'pending', count(*) FILTER (WHERE embedding_status = 'pending'),
                'failed', count(*) FILTER (WHERE embedding_status = 'failed')
            ) FROM training_logs WHERE (v_owner IS NULL OR user_id = v_owner)
        )
    )
    INTO v_tables_stats;

    RETURN jsonb_build_object(
        'outbox', v_outbox_stats,
        'tables', v_tables_stats
    );
END;
$$;

GRANT EXECUTE ON FUNCTION claim_indexing_jobs TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION complete_indexing_job TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION backfill_indexing_jobs TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_indexing_lifecycle_status TO authenticated, service_role;
