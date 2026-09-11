-- Migration: 20260911020000_identity_and_upserts.sql
-- Task: T06 — Unicidade, upserts e tratamento de legacy
-- Issues: #15, #30, #37, #38, #48, #62
-- Description:
--   1. profile: substitui indexes parciais por UNIQUE NULLS NOT DISTINCT (key, owner_id) e adiciona upsert_profile RPC.
--   2. health_entries: garante unicidade por (user_id, source, external_id) WHERE external_id IS NOT NULL e adiciona upsert_health_entry RPC.
--   3. training_logs: adiciona coluna canonica 'source' DEFAULT 'iron-log', garante unicidade por (user_id, source, external_id) WHERE external_id IS NOT NULL e adiciona upsert_training_log RPC.
--   4. memories: adiciona exact-byte content_hash, trigger de integridade, UNIQUE NULLS NOT DISTINCT (user_id, content_hash), re-aponta FKs entity_mentions em deduplicações e atualiza upsert_memory atomico.
--   5. briefs: adiciona source_path estavel, remove UNIQUE global de content_hash, garante unicidade por (user_id, source_job, source_path) WHERE source_path IS NOT NULL, re-aponta FKs brief_claims e adiciona upsert_brief RPC.
--   6. projects: garante unicidade por (user_id, lower(trim(name))) e adiciona upsert_project RPC com diagnostico de erro.

-- ============================================================================
-- 1. PROFILE: Unicidade (key, owner_id) e upsert_profile
-- ============================================================================

-- Deduplica registros legados equivalentes antes da constraint
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
BEGIN
    FOR r IN (
        SELECT key, owner_id, count(*) AS cnt
        FROM profile
        GROUP BY key, owner_id
        HAVING count(*) > 1
    ) LOOP
        -- Verifica se ha conflito irreconciliavel de valores
        IF (SELECT count(DISTINCT value) FROM profile WHERE key = r.key AND owner_id IS NOT DISTINCT FROM r.owner_id) > 1 THEN
            RAISE EXCEPTION 'Conflicting duplicates found in profile for key % and owner %', r.key, r.owner_id;
        END IF;

        -- Seleciona sobrevivente mais recente
        SELECT id INTO v_surviving_id
        FROM profile
        WHERE key = r.key AND owner_id IS NOT DISTINCT FROM r.owner_id
        ORDER BY updated_at DESC, id ASC
        LIMIT 1;

        DELETE FROM profile
        WHERE key = r.key
          AND owner_id IS NOT DISTINCT FROM r.owner_id
          AND id <> v_surviving_id;
    END LOOP;
END;
$$;

ALTER TABLE profile DROP CONSTRAINT IF EXISTS profile_key_owner_unique;
DROP INDEX IF EXISTS profile_key_owner_unique;
DROP INDEX IF EXISTS profile_key_null_owner;

ALTER TABLE profile
    ADD CONSTRAINT profile_key_owner_unique UNIQUE NULLS NOT DISTINCT (key, owner_id);

CREATE OR REPLACE FUNCTION upsert_profile(
    p_key TEXT,
    p_value JSONB,
    p_owner_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_existing RECORD;
    v_id UUID;
    v_was_inserted BOOLEAN;
BEGIN
    v_owner := COALESCE(auth.uid(), p_owner_id);

    IF p_key IS NULL OR trim(p_key) = '' THEN
        RAISE EXCEPTION 'Profile key cannot be empty';
    END IF;

    -- Verifica se ja existe registro identico para idempotencia / lost response
    SELECT id, value INTO v_existing
    FROM profile
    WHERE key = trim(p_key) AND owner_id IS NOT DISTINCT FROM v_owner;

    IF v_existing.id IS NOT NULL AND v_existing.value = p_value THEN
        RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged', 'key', trim(p_key));
    END IF;

    INSERT INTO profile (key, value, owner_id, updated_at)
    VALUES (trim(p_key), p_value, v_owner, now())
    ON CONFLICT (key, owner_id) DO UPDATE
    SET
        value = EXCLUDED.value,
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created', 'key', trim(p_key));
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated', 'key', trim(p_key));
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_profile TO authenticated, service_role, anon;

-- ============================================================================
-- 2. HEALTH_ENTRIES: Unicidade (user_id, source, external_id) e upsert_health_entry
-- ============================================================================

-- Deduplica registros legados equivalentes antes da constraint
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
BEGIN
    FOR r IN (
        SELECT user_id, source, external_id, count(*) AS cnt
        FROM health_entries
        WHERE external_id IS NOT NULL
        GROUP BY user_id, source, external_id
        HAVING count(*) > 1
    ) LOOP
        -- Seleciona sobrevivente mais antigo
        SELECT id INTO v_surviving_id
        FROM health_entries
        WHERE external_id = r.external_id
          AND source = r.source
          AND user_id IS NOT DISTINCT FROM r.user_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        DELETE FROM health_entries
        WHERE external_id = r.external_id
          AND source = r.source
          AND user_id IS NOT DISTINCT FROM r.user_id
          AND id <> v_surviving_id;
    END LOOP;
END;
$$;

DROP INDEX IF EXISTS health_entries_owner_source_ext_idx;
CREATE UNIQUE INDEX health_entries_owner_source_ext_idx
    ON health_entries (user_id, source, external_id)
    NULLS NOT DISTINCT
    WHERE external_id IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_health_entry(
    p_entry_type TEXT,
    p_timestamp TIMESTAMPTZ,
    p_value JSONB DEFAULT '{}',
    p_numeric_value NUMERIC DEFAULT NULL,
    p_duration_s INTEGER DEFAULT NULL,
    p_tags TEXT[] DEFAULT '{}',
    p_source TEXT DEFAULT 'health-connect',
    p_external_id TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}',
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_id UUID;
    v_was_inserted BOOLEAN;
    v_tags TEXT[];
    v_existing RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    v_tags := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);

    IF p_external_id IS NULL THEN
        INSERT INTO health_entries (
            user_id, entry_type, "timestamp", duration_s, value, numeric_value, tags, source, external_id, metadata, created_at
        ) VALUES (
            v_owner, p_entry_type, p_timestamp, p_duration_s, COALESCE(p_value, '{}'::jsonb), p_numeric_value, v_tags, COALESCE(p_source, 'health-connect'), NULL, COALESCE(p_metadata, '{}'::jsonb), now()
        )
        RETURNING id INTO v_id;
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    END IF;

    -- Verifica existencia previa identica
    SELECT id, entry_type, "timestamp", duration_s, value, numeric_value, tags, metadata
    INTO v_existing
    FROM health_entries
    WHERE user_id IS NOT DISTINCT FROM v_owner
      AND source = COALESCE(p_source, 'health-connect')
      AND external_id = p_external_id;

    IF v_existing.id IS NOT NULL THEN
        IF (v_existing.entry_type = p_entry_type)
           AND (v_existing."timestamp" = p_timestamp)
           AND (v_existing.duration_s IS NOT DISTINCT FROM p_duration_s)
           AND (v_existing.value = COALESCE(p_value, '{}'::jsonb))
           AND (v_existing.numeric_value IS NOT DISTINCT FROM p_numeric_value)
           AND (v_existing.tags @> v_tags AND v_tags @> v_existing.tags)
           AND (v_existing.metadata @> COALESCE(p_metadata, '{}'::jsonb) AND COALESCE(p_metadata, '{}'::jsonb) @> v_existing.metadata)
        THEN
            RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged');
        END IF;
    END IF;

    INSERT INTO health_entries (
        user_id, entry_type, "timestamp", duration_s, value, numeric_value, tags, source, external_id, metadata, created_at
    ) VALUES (
        v_owner, p_entry_type, p_timestamp, p_duration_s, COALESCE(p_value, '{}'::jsonb), p_numeric_value, v_tags, COALESCE(p_source, 'health-connect'), p_external_id, COALESCE(p_metadata, '{}'::jsonb), now()
    )
    ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE
    SET
        entry_type = EXCLUDED.entry_type,
        "timestamp" = EXCLUDED."timestamp",
        duration_s = EXCLUDED.duration_s,
        value = EXCLUDED.value,
        numeric_value = EXCLUDED.numeric_value,
        tags = EXCLUDED.tags,
        metadata = COALESCE(health_entries.metadata, '{}'::jsonb) || EXCLUDED.metadata
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_health_entry TO authenticated, service_role, anon;

-- ============================================================================
-- 3. TRAINING_LOGS: Canonical source, Unicidade e upsert_training_log
-- ============================================================================

ALTER TABLE training_logs
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'iron-log';

UPDATE training_logs
SET source = COALESCE(metadata->>'source', metadata->>'ingestion_source', 'iron-log')
WHERE source IS NULL;

-- Deduplica registros legados equivalentes antes da constraint
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
BEGIN
    FOR r IN (
        SELECT user_id, source, external_id, count(*) AS cnt
        FROM training_logs
        WHERE external_id IS NOT NULL
        GROUP BY user_id, source, external_id
        HAVING count(*) > 1
    ) LOOP
        SELECT id INTO v_surviving_id
        FROM training_logs
        WHERE external_id = r.external_id
          AND source = r.source
          AND user_id IS NOT DISTINCT FROM r.user_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        DELETE FROM training_logs
        WHERE external_id = r.external_id
          AND source = r.source
          AND user_id IS NOT DISTINCT FROM r.user_id
          AND id <> v_surviving_id;
    END LOOP;
END;
$$;

DROP INDEX IF EXISTS training_logs_owner_source_ext_idx;
CREATE UNIQUE INDEX training_logs_owner_source_ext_idx
    ON training_logs (user_id, source, external_id)
    NULLS NOT DISTINCT
    WHERE external_id IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_training_log(
    p_workout_date DATE,
    p_workout_type TEXT,
    p_name TEXT,
    p_exercises JSONB DEFAULT '[]',
    p_duration_s INTEGER DEFAULT NULL,
    p_volume_kg NUMERIC(8,2) DEFAULT NULL,
    p_numeric_value NUMERIC DEFAULT NULL,
    p_rpe SMALLINT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_tags TEXT[] DEFAULT '{}',
    p_source TEXT DEFAULT 'iron-log',
    p_external_id TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}',
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_id UUID;
    v_was_inserted BOOLEAN;
    v_tags TEXT[];
    v_existing RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    v_tags := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);

    IF p_external_id IS NULL THEN
        INSERT INTO training_logs (
            user_id, workout_date, workout_type, name, exercises, duration_s, volume_kg, numeric_value, rpe, notes, tags, source, external_id, metadata, created_at, updated_at
        ) VALUES (
            v_owner, p_workout_date, p_workout_type, p_name, COALESCE(p_exercises, '[]'::jsonb), p_duration_s, p_volume_kg, p_numeric_value, p_rpe, p_notes, v_tags, COALESCE(p_source, 'iron-log'), NULL, COALESCE(p_metadata, '{}'::jsonb), now(), now()
        )
        RETURNING id INTO v_id;
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    END IF;

    -- Verifica se ja existe registro identico
    SELECT id, workout_date, workout_type, name, exercises, duration_s, volume_kg, numeric_value, rpe, notes, tags, metadata
    INTO v_existing
    FROM training_logs
    WHERE user_id IS NOT DISTINCT FROM v_owner
      AND source = COALESCE(p_source, 'iron-log')
      AND external_id = p_external_id;

    IF v_existing.id IS NOT NULL THEN
        IF (v_existing.workout_date = p_workout_date)
           AND (v_existing.workout_type = p_workout_type)
           AND (v_existing.name = p_name)
           AND (v_existing.exercises = COALESCE(p_exercises, '[]'::jsonb))
           AND (v_existing.duration_s IS NOT DISTINCT FROM p_duration_s)
           AND (v_existing.volume_kg IS NOT DISTINCT FROM p_volume_kg)
           AND (v_existing.numeric_value IS NOT DISTINCT FROM p_numeric_value)
           AND (v_existing.rpe IS NOT DISTINCT FROM p_rpe)
           AND (v_existing.notes IS NOT DISTINCT FROM p_notes)
           AND (v_existing.tags @> v_tags AND v_tags @> v_existing.tags)
           AND (v_existing.metadata @> COALESCE(p_metadata, '{}'::jsonb) AND COALESCE(p_metadata, '{}'::jsonb) @> v_existing.metadata)
        THEN
            RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged');
        END IF;
    END IF;

    INSERT INTO training_logs (
        user_id, workout_date, workout_type, name, exercises, duration_s, volume_kg, numeric_value, rpe, notes, tags, source, external_id, metadata, created_at, updated_at
    ) VALUES (
        v_owner, p_workout_date, p_workout_type, p_name, COALESCE(p_exercises, '[]'::jsonb), p_duration_s, p_volume_kg, p_numeric_value, p_rpe, p_notes, v_tags, COALESCE(p_source, 'iron-log'), p_external_id, COALESCE(p_metadata, '{}'::jsonb), now(), now()
    )
    ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE
    SET
        workout_date = EXCLUDED.workout_date,
        workout_type = EXCLUDED.workout_type,
        name = EXCLUDED.name,
        exercises = EXCLUDED.exercises,
        duration_s = EXCLUDED.duration_s,
        volume_kg = EXCLUDED.volume_kg,
        numeric_value = EXCLUDED.numeric_value,
        rpe = EXCLUDED.rpe,
        notes = EXCLUDED.notes,
        tags = EXCLUDED.tags,
        metadata = COALESCE(training_logs.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_training_log TO authenticated, service_role, anon;

-- ============================================================================
-- 4. MEMORIES: Exact-byte content_hash, FK preservation e upsert_memory atomico
-- ============================================================================

ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS content_hash TEXT;

UPDATE memories
SET content_hash = encode(sha256(content::bytea), 'hex')
WHERE content_hash IS NULL;

ALTER TABLE memories
    ALTER COLUMN content_hash SET NOT NULL;

-- Trigger para garantir que qualquer insert/update de content calcule o content_hash exato
CREATE OR REPLACE FUNCTION memories_compute_content_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := encode(sha256(NEW.content::bytea), 'hex');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_memories_content_hash ON memories;
CREATE TRIGGER trigger_memories_content_hash
    BEFORE INSERT OR UPDATE OF content ON memories
    FOR EACH ROW
    EXECUTE FUNCTION memories_compute_content_hash();

-- Deduplica memories preservando entity_mentions (FKs) e mesclando metadados
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
    v_dup RECORD;
BEGIN
    FOR r IN (
        SELECT user_id, content_hash, count(*) AS cnt
        FROM memories
        GROUP BY user_id, content_hash
        HAVING count(*) > 1
    ) LOOP
        -- Seleciona a mais antiga como canônica
        SELECT id INTO v_surviving_id
        FROM memories
        WHERE content_hash = r.content_hash
          AND user_id IS NOT DISTINCT FROM r.user_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        -- Processa cada duplicata redundante
        FOR v_dup IN (
            SELECT * FROM memories
            WHERE content_hash = r.content_hash
              AND user_id IS NOT DISTINCT FROM r.user_id
              AND id <> v_surviving_id
        ) LOOP
            -- 1. Remove menções redundantes para a mesma entidade no sobrevivente
            DELETE FROM entity_mentions
            WHERE memory_id = v_dup.id
              AND entity_id IN (SELECT entity_id FROM entity_mentions WHERE memory_id = v_surviving_id);

            -- 2. Re-aponta FKs restantes de entity_mentions para o sobrevivente
            UPDATE entity_mentions
            SET memory_id = v_surviving_id
            WHERE memory_id = v_dup.id;

            -- 3. Mescla tags, people, importance e metadata no sobrevivente
            UPDATE memories
            SET
                tags = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(memories.tags, '{}'::text[]) || COALESCE(v_dup.tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1),
                people = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(memories.people, '{}'::text[]) || COALESCE(v_dup.people, '{}'::text[])) AS p(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1),
                importance = GREATEST(memories.importance, v_dup.importance),
                metadata = COALESCE(memories.metadata, '{}'::jsonb) || COALESCE(v_dup.metadata, '{}'::jsonb),
                updated_at = now()
            WHERE id = v_surviving_id;

            -- 4. Remove a linha duplicada
            DELETE FROM memories WHERE id = v_dup.id;
        END LOOP;
    END LOOP;
END;
$$;

ALTER TABLE memories
    DROP CONSTRAINT IF EXISTS memories_owner_content_hash_key;
DROP INDEX IF EXISTS memories_owner_content_hash_key;

ALTER TABLE memories
    ADD CONSTRAINT memories_owner_content_hash_key UNIQUE NULLS NOT DISTINCT (user_id, content_hash);

CREATE OR REPLACE FUNCTION upsert_memory(
    p_content TEXT,
    p_title TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'note',
    p_source TEXT DEFAULT 'mcp',
    p_importance SMALLINT DEFAULT 5,
    p_tags TEXT[] DEFAULT '{}',
    p_people TEXT[] DEFAULT '{}',
    p_metadata JSONB DEFAULT '{}',
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_fingerprint TEXT;
    v_id UUID;
    v_was_inserted BOOLEAN;
    v_tags TEXT[];
    v_people TEXT[];
    v_existing RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: upsert_memory requires an authenticated owner or explicit user_id';
    END IF;

    IF p_content IS NULL OR length(p_content) = 0 THEN
        RAISE EXCEPTION 'Memory content cannot be empty';
    END IF;

    v_fingerprint := encode(sha256(p_content::bytea), 'hex');
    v_tags := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);
    v_people := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_people, '{}'::text[])) AS p(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);

    -- Verifica se ja existe exatamente igual (lost-response / repeat)
    SELECT id, title, category, importance, tags, people, metadata
    INTO v_existing
    FROM memories
    WHERE user_id = v_owner AND content_hash = v_fingerprint;

    IF v_existing.id IS NOT NULL THEN
        IF (v_existing.title IS NOT DISTINCT FROM COALESCE(p_title, v_existing.title))
           AND (v_existing.category = COALESCE(p_category, 'note'))
           AND (v_existing.importance >= COALESCE(p_importance, 5::smallint))
           AND (v_existing.tags @> v_tags AND v_tags @> v_existing.tags)
           AND (v_existing.people @> v_people AND v_people @> v_existing.people)
           AND (v_existing.metadata @> COALESCE(p_metadata, '{}'::jsonb) AND COALESCE(p_metadata, '{}'::jsonb) @> v_existing.metadata)
        THEN
            RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged');
        END IF;
    END IF;

    INSERT INTO memories (
        user_id, content, content_hash, title, category, source, importance, tags, people, metadata, created_at, updated_at
    ) VALUES (
        v_owner, p_content, v_fingerprint, p_title, COALESCE(p_category, 'note'), COALESCE(p_source, 'mcp'), COALESCE(p_importance, 5::smallint),
        v_tags, v_people, COALESCE(p_metadata, '{}'::jsonb), now(), now()
    )
    ON CONFLICT (user_id, content_hash) DO UPDATE
    SET
        title = COALESCE(EXCLUDED.title, memories.title),
        category = EXCLUDED.category,
        importance = GREATEST(memories.importance, EXCLUDED.importance),
        tags = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(memories.tags, '{}'::text[]) || COALESCE(EXCLUDED.tags, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1),
        people = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(memories.people, '{}'::text[]) || COALESCE(EXCLUDED.people, '{}'::text[])) AS p(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1),
        metadata = COALESCE(memories.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_memory TO authenticated, service_role, anon;

-- ============================================================================
-- 5. BRIEFS: source_path estavel, FK preservation e upsert_brief
-- ============================================================================

ALTER TABLE briefs
    ADD COLUMN IF NOT EXISTS source_path TEXT DEFAULT NULL;

UPDATE briefs
SET source_path = COALESCE(metadata->>'source_path', metadata->>'note_path')
WHERE source_path IS NULL AND (metadata->>'source_path' IS NOT NULL OR metadata->>'note_path' IS NOT NULL);

-- Remove restricao global em content_hash (incompativel com multi-owner e re-edições no mesmo source_path)
ALTER TABLE briefs DROP CONSTRAINT IF EXISTS briefs_content_hash_key;
DROP INDEX IF EXISTS briefs_content_hash_key;

-- Deduplica briefs redundantes por source_path preservando brief_claims (FKs)
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
    v_dup RECORD;
BEGIN
    FOR r IN (
        SELECT user_id, source_job, source_path, count(*) AS cnt
        FROM briefs
        WHERE source_path IS NOT NULL
        GROUP BY user_id, source_job, source_path
        HAVING count(*) > 1
    ) LOOP
        -- Seleciona a mais antiga como canônica
        SELECT id INTO v_surviving_id
        FROM briefs
        WHERE source_path = r.source_path
          AND source_job = r.source_job
          AND user_id IS NOT DISTINCT FROM r.user_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        FOR v_dup IN (
            SELECT * FROM briefs
            WHERE source_path = r.source_path
              AND source_job = r.source_job
              AND user_id IS NOT DISTINCT FROM r.user_id
              AND id <> v_surviving_id
        ) LOOP
            -- 1. Re-aponta FKs de brief_claims para o sobrevivente
            UPDATE brief_claims
            SET brief_id = v_surviving_id
            WHERE brief_id = v_dup.id;

            -- 2. Remove linha redundante
            DELETE FROM briefs WHERE id = v_dup.id;
        END LOOP;
    END LOOP;
END;
$$;

DROP INDEX IF EXISTS briefs_owner_source_job_path_idx;
CREATE UNIQUE INDEX briefs_owner_source_job_path_idx
    ON briefs (user_id, source_job, source_path)
    NULLS NOT DISTINCT
    WHERE source_path IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_brief(
    p_title TEXT,
    p_brief_date DATE,
    p_kind TEXT,
    p_body_markdown TEXT,
    p_source_job TEXT DEFAULT 'manual',
    p_source_path TEXT DEFAULT NULL,
    p_topics TEXT[] DEFAULT '{}',
    p_project_refs TEXT[] DEFAULT '{}',
    p_entity_refs TEXT[] DEFAULT '{}',
    p_metadata JSONB DEFAULT '{}',
    p_content_hash TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_content_hash TEXT;
    v_id UUID;
    v_was_inserted BOOLEAN;
    v_topics TEXT[];
    v_projects TEXT[];
    v_entities TEXT[];
    v_existing RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    v_content_hash := COALESCE(p_content_hash, encode(sha256(p_body_markdown::bytea), 'hex'));

    v_topics := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_topics, '{}'::text[])) AS t(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);
    v_projects := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_project_refs, '{}'::text[])) AS p(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);
    v_entities := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_entity_refs, '{}'::text[])) AS e(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);

    IF p_source_path IS NULL THEN
        INSERT INTO briefs (
            user_id, title, brief_date, kind, content_hash, source_job, source_path, body_markdown, topics, project_refs, entity_refs, metadata, created_at, updated_at
        ) VALUES (
            v_owner, trim(p_title), p_brief_date, trim(p_kind), v_content_hash, trim(p_source_job), NULL, p_body_markdown, v_topics, v_projects, v_entities, COALESCE(p_metadata, '{}'::jsonb), now(), now()
        )
        RETURNING id INTO v_id;
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    END IF;

    -- Verifica existencia previa identica
    SELECT id, title, brief_date, kind, content_hash, body_markdown, topics, project_refs, entity_refs, metadata
    INTO v_existing
    FROM briefs
    WHERE user_id IS NOT DISTINCT FROM v_owner
      AND source_job = trim(p_source_job)
      AND source_path = trim(p_source_path);

    IF v_existing.id IS NOT NULL THEN
        IF (v_existing.title = trim(p_title))
           AND (v_existing.brief_date = p_brief_date)
           AND (v_existing.kind = trim(p_kind))
           AND (v_existing.content_hash = v_content_hash)
           AND (v_existing.body_markdown = p_body_markdown)
           AND (v_existing.topics @> v_topics AND v_topics @> v_existing.topics)
           AND (v_existing.project_refs @> v_projects AND v_projects @> v_existing.project_refs)
           AND (v_existing.entity_refs @> v_entities AND v_entities @> v_existing.entity_refs)
           AND (v_existing.metadata @> COALESCE(p_metadata, '{}'::jsonb) AND COALESCE(p_metadata, '{}'::jsonb) @> v_existing.metadata)
        THEN
            RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged');
        END IF;
    END IF;

    INSERT INTO briefs (
        user_id, title, brief_date, kind, content_hash, source_job, source_path, body_markdown, topics, project_refs, entity_refs, metadata, created_at, updated_at
    ) VALUES (
        v_owner, trim(p_title), p_brief_date, trim(p_kind), v_content_hash, trim(p_source_job), trim(p_source_path), p_body_markdown, v_topics, v_projects, v_entities, COALESCE(p_metadata, '{}'::jsonb), now(), now()
    )
    ON CONFLICT (user_id, source_job, source_path) WHERE source_path IS NOT NULL DO UPDATE
    SET
        title = EXCLUDED.title,
        brief_date = EXCLUDED.brief_date,
        kind = EXCLUDED.kind,
        content_hash = EXCLUDED.content_hash,
        body_markdown = EXCLUDED.body_markdown,
        topics = EXCLUDED.topics,
        project_refs = EXCLUDED.project_refs,
        entity_refs = EXCLUDED.entity_refs,
        metadata = COALESCE(briefs.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_brief TO authenticated, service_role, anon;

-- ============================================================================
-- 6. PROJECTS: Unicidade (user_id, lower(trim(name))) e upsert_project
-- ============================================================================

-- Deduplica projetos com mesmo nome normalizado antes da constraint
DO $$
DECLARE
    r RECORD;
    v_surviving_id UUID;
BEGIN
    FOR r IN (
        SELECT user_id, lower(trim(name)) AS norm_name, count(*) AS cnt
        FROM projects
        GROUP BY user_id, lower(trim(name))
        HAVING count(*) > 1
    ) LOOP
        SELECT id INTO v_surviving_id
        FROM projects
        WHERE lower(trim(name)) = r.norm_name
          AND user_id IS NOT DISTINCT FROM r.user_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;

        DELETE FROM projects
        WHERE lower(trim(name)) = r.norm_name
          AND user_id IS NOT DISTINCT FROM r.user_id
          AND id <> v_surviving_id;
    END LOOP;
END;
$$;

DROP INDEX IF EXISTS projects_owner_normalized_name_idx;
CREATE UNIQUE INDEX projects_owner_normalized_name_idx
    ON projects (user_id, lower(trim(name)))
    NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION upsert_project(
    p_name TEXT,
    p_path TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_stack TEXT[] DEFAULT '{}',
    p_conventions JSONB DEFAULT '{}',
    p_status TEXT DEFAULT 'active',
    p_metadata JSONB DEFAULT '{}',
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_id UUID;
    v_was_inserted BOOLEAN;
    v_stack TEXT[];
    v_existing RECORD;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);

    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Project name cannot be empty';
    END IF;

    v_stack := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_stack, '{}'::text[])) AS s(x) WHERE x IS NOT NULL AND trim(x) <> '' ORDER BY 1);

    -- Verifica existencia previa identica
    SELECT id, name, path, description, stack, conventions, status, metadata
    INTO v_existing
    FROM projects
    WHERE user_id IS NOT DISTINCT FROM v_owner
      AND lower(trim(name)) = lower(trim(p_name));

    IF v_existing.id IS NOT NULL THEN
        IF (v_existing.name = trim(p_name))
           AND (p_path IS NULL OR v_existing.path IS NOT DISTINCT FROM p_path)
           AND (p_description IS NULL OR v_existing.description IS NOT DISTINCT FROM p_description)
           AND (v_stack = '{}'::text[] OR (v_existing.stack @> v_stack AND v_stack @> v_existing.stack))
           AND (p_conventions = '{}'::jsonb OR (v_existing.conventions @> p_conventions AND p_conventions @> v_existing.conventions))
           AND (p_status IS NULL OR v_existing.status = p_status)
           AND (p_metadata = '{}'::jsonb OR (v_existing.metadata @> p_metadata AND p_metadata @> v_existing.metadata))
        THEN
            RETURN jsonb_build_object('id', v_existing.id, 'status', 'unchanged');
        END IF;
    END IF;

    INSERT INTO projects (
        user_id, name, path, description, stack, conventions, status, metadata, created_at, updated_at
    ) VALUES (
        v_owner, trim(p_name), p_path, p_description, v_stack, COALESCE(p_conventions, '{}'::jsonb), COALESCE(p_status, 'active'), COALESCE(p_metadata, '{}'::jsonb), now(), now()
    )
    ON CONFLICT (user_id, lower(trim(name))) DO UPDATE
    SET
        name = EXCLUDED.name,
        path = COALESCE(EXCLUDED.path, projects.path),
        description = COALESCE(EXCLUDED.description, projects.description),
        stack = CASE WHEN EXCLUDED.stack <> '{}'::text[] THEN EXCLUDED.stack ELSE projects.stack END,
        conventions = COALESCE(projects.conventions, '{}'::jsonb) || EXCLUDED.conventions,
        status = EXCLUDED.status,
        metadata = COALESCE(projects.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
    RETURNING id, (xmax = 0) INTO v_id, v_was_inserted;

    IF v_was_inserted THEN
        RETURN jsonb_build_object('id', v_id, 'status', 'created');
    ELSE
        RETURN jsonb_build_object('id', v_id, 'status', 'updated');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_project TO authenticated, service_role, anon;
