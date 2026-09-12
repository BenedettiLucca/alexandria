-- ==============================================================================
-- Alexandria Migration: Memory / Knowledge Graph Integrity and Aggregates (T13)
--
-- 1. Entities uniqueness scoped to owner (user_id, name, entity_type)
-- 2. Performance indexes for entity_mentions and entities
-- 3. Atomic reconcile_memory_entities RPC with owner & version guards
-- 4. Bounded SQL aggregates: get_memory_stats and list_entities_ranked
-- ==============================================================================

-- 1. Entities uniqueness per owner
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_name_entity_type_key;
ALTER TABLE entities ADD CONSTRAINT entities_user_name_type_key UNIQUE NULLS NOT DISTINCT (user_id, name, entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_user_name_type ON entities (user_id, name, entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities (user_id, entity_type);

-- 2. Indexes on entity_mentions
CREATE INDEX IF NOT EXISTS idx_entity_mentions_user_memory ON entity_mentions (user_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_user_entity ON entity_mentions (user_id, entity_id);

-- 3. Atomic graph reconciliation RPC
CREATE OR REPLACE FUNCTION reconcile_memory_entities(
    p_memory_id UUID,
    p_entities JSONB,
    p_source_version INT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_mem RECORD;
    v_elem JSONB;
    v_name TEXT;
    v_type TEXT;
    v_context TEXT;
    v_entity_id UUID;
    v_active_entity_ids UUID[] := '{}';
    v_mention_count INT := 0;
BEGIN
    -- 1. Owner guard
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: reconcile_memory_entities requires an authenticated owner or explicit user_id';
    END IF;

    -- 2. Memory existence & owner verification
    SELECT id, user_id, embedding_version, content_hash
    INTO v_mem
    FROM memories
    WHERE id = p_memory_id AND user_id = v_owner;

    IF v_mem.id IS NULL THEN
        RAISE EXCEPTION 'Memory % not found or not owned by %', p_memory_id, v_owner;
    END IF;

    -- 3. Source version CAS guard
    IF p_source_version IS NOT NULL AND v_mem.embedding_version <> p_source_version THEN
        RAISE EXCEPTION 'CAS version mismatch: memory % has embedding_version %, expected %',
            p_memory_id, v_mem.embedding_version, p_source_version;
    END IF;

    -- 4. Reconcile entities and mentions
    IF p_entities IS NOT NULL AND jsonb_typeof(p_entities) = 'array' THEN
        FOR v_elem IN SELECT * FROM jsonb_array_elements(p_entities)
        LOOP
            v_name := trim(v_elem->>'name');
            v_type := lower(trim(v_elem->>'type'));
            v_context := v_elem->>'context';

            IF v_name IS NOT NULL AND length(v_name) > 0 AND
               v_type IN ('person', 'project', 'concept', 'location', 'technology', 'organization', 'event', 'other') THEN

                -- Upsert entity for owner
                INSERT INTO entities (user_id, name, entity_type, created_at, updated_at)
                VALUES (v_owner, v_name, v_type, now(), now())
                ON CONFLICT (user_id, name, entity_type) DO UPDATE
                SET updated_at = now()
                RETURNING id INTO v_entity_id;

                v_active_entity_ids := array_append(v_active_entity_ids, v_entity_id);

                -- Upsert mention
                INSERT INTO entity_mentions (user_id, memory_id, entity_id, context, created_at)
                VALUES (v_owner, p_memory_id, v_entity_id, v_context, now())
                ON CONFLICT (memory_id, entity_id) DO UPDATE
                SET context = COALESCE(EXCLUDED.context, entity_mentions.context),
                    user_id = EXCLUDED.user_id;

                v_mention_count := v_mention_count + 1;
            END IF;
        END LOOP;
    END IF;

    -- 5. Atomic replacement: delete stale mentions for this memory
    IF array_length(v_active_entity_ids, 1) > 0 THEN
        DELETE FROM entity_mentions
        WHERE memory_id = p_memory_id
          AND user_id = v_owner
          AND NOT (entity_id = ANY(v_active_entity_ids));
    ELSE
        DELETE FROM entity_mentions
        WHERE memory_id = p_memory_id
          AND user_id = v_owner;
    END IF;

    -- 6. Mark enrichment ready
    UPDATE memories
    SET enrichment_status = 'ready',
        enriched_at = now()
    WHERE id = p_memory_id
      AND user_id = v_owner;

    RETURN jsonb_build_object(
        'success', true,
        'memory_id', p_memory_id,
        'active_mentions', v_mention_count,
        'version', v_mem.embedding_version
    );
END;
$$;

GRANT EXECUTE ON FUNCTION reconcile_memory_entities TO authenticated, service_role, anon;

-- 4. Bounded SQL Aggregates for memory stats
CREATE OR REPLACE FUNCTION get_memory_stats(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_total_count BIGINT;
    v_min_date TIMESTAMPTZ;
    v_max_date TIMESTAMPTZ;
    v_categories JSONB;
    v_top_tags JSONB;
    v_top_people JSONB;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: get_memory_stats requires an authenticated owner or explicit user_id';
    END IF;

    SELECT
        COUNT(*),
        MIN(created_at),
        MAX(created_at)
    INTO
        v_total_count,
        v_min_date,
        v_max_date
    FROM memories
    WHERE user_id = v_owner;

    -- Categories top 10
    SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'count', cat_count)), '[]'::jsonb)
    INTO v_categories
    FROM (
        SELECT category, COUNT(*) AS cat_count
        FROM memories
        WHERE user_id = v_owner AND category IS NOT NULL
        GROUP BY category
        ORDER BY cat_count DESC, category ASC
        LIMIT 10
    ) c;

    -- Top tags top 10
    SELECT COALESCE(jsonb_agg(jsonb_build_object('tag', tag, 'count', tag_count)), '[]'::jsonb)
    INTO v_top_tags
    FROM (
        SELECT trim(t) AS tag, COUNT(*) AS tag_count
        FROM memories, unnest(tags) AS t
        WHERE user_id = v_owner AND t IS NOT NULL AND trim(t) <> ''
        GROUP BY trim(t)
        ORDER BY tag_count DESC, tag ASC
        LIMIT 10
    ) tg;

    -- Top people top 10
    SELECT COALESCE(jsonb_agg(jsonb_build_object('person', person, 'count', person_count)), '[]'::jsonb)
    INTO v_top_people
    FROM (
        SELECT trim(p) AS person, COUNT(*) AS person_count
        FROM memories, unnest(people) AS p
        WHERE user_id = v_owner AND p IS NOT NULL AND trim(p) <> ''
        GROUP BY trim(p)
        ORDER BY person_count DESC, person ASC
        LIMIT 10
    ) pp;

    RETURN jsonb_build_object(
        'total_count', COALESCE(v_total_count, 0),
        'earliest_date', v_min_date,
        'latest_date', v_max_date,
        'categories', v_categories,
        'top_tags', v_top_tags,
        'top_people', v_top_people
    );
END;
$$;

GRANT EXECUTE ON FUNCTION get_memory_stats TO authenticated, service_role, anon;

-- 5. Bounded SQL Aggregates for list_entities
CREATE OR REPLACE FUNCTION list_entities_ranked(
    p_entity_type TEXT DEFAULT NULL,
    p_limit INT DEFAULT 25,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    entity_type TEXT,
    description TEXT,
    created_at TIMESTAMPTZ,
    mention_count BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: list_entities_ranked requires an authenticated owner or explicit user_id';
    END IF;

    RETURN QUERY
    SELECT
        e.id,
        e.name,
        e.entity_type,
        e.description,
        e.created_at,
        COUNT(em.id) AS mention_count
    FROM entities e
    LEFT JOIN entity_mentions em
        ON em.entity_id = e.id
       AND em.user_id = v_owner
    WHERE e.user_id = v_owner
      AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
    GROUP BY e.id, e.name, e.entity_type, e.description, e.created_at
    ORDER BY mention_count DESC, e.name ASC
    LIMIT COALESCE(p_limit, 25);
END;
$$;

GRANT EXECUTE ON FUNCTION list_entities_ranked TO authenticated, service_role, anon;
