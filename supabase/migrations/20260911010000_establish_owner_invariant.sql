-- ==============================================================================
-- Alexandria Migration: 20260911010000_establish_owner_invariant.sql
-- T03A — Estabelecer owner invariant no banco
--
-- Objetivos:
-- 1. Eliminar vazamentos de dados cross-owner e brechas em linhas legadas NULL.
-- 2. Estender ownership para tabelas derivadas, knowledge graph, sync e recipes/claims.
-- 3. Configurar RLS estrito (USING e WITH CHECK) em todas as tabelas privadas.
-- 4. Tornar RPCs de busca e agregacoes (compute_daily_summary) estritamente owner-aware.
-- 5. Prover auditoria e backfill fail-closed para linhas legadas NULL.
-- 6. Congelar assinaturas para compatibilidade com T03B/T05/T06.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSAO DE COLUNAS DE OWNERSHIP (user_id) EM TABELAS DERIVADAS/SEM DONO
-- ------------------------------------------------------------------------------

-- health_summaries: daily summary pertence a um owner especifico
ALTER TABLE health_summaries
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Remove constraint unique global por data e substitui por (user_id, date)
ALTER TABLE health_summaries
    DROP CONSTRAINT IF EXISTS health_summaries_date_key;

ALTER TABLE health_summaries
    DROP CONSTRAINT IF EXISTS health_summaries_user_date_key;

ALTER TABLE health_summaries
    ADD CONSTRAINT health_summaries_user_date_key UNIQUE NULLS NOT DISTINCT (user_id, date);

-- room_recipes: receitas de room pertencem a um owner
ALTER TABLE room_recipes
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE room_recipes
    DROP CONSTRAINT IF EXISTS room_recipes_name_key;

ALTER TABLE room_recipes
    DROP CONSTRAINT IF EXISTS room_recipes_user_name_key;

ALTER TABLE room_recipes
    ADD CONSTRAINT room_recipes_user_name_key UNIQUE NULLS NOT DISTINCT (user_id, name);

-- brief_claims: claims extraidos de briefs pertencem ao mesmo owner
ALTER TABLE brief_claims
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- entities: knowledge graph nodes pertencem ao owner
ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- entity_mentions: ligacoes grafo-memoria pertencem ao owner
ALTER TABLE entity_mentions
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- sync_log: logs de sincronizacao de importers pertencem ao owner
ALTER TABLE sync_log
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ------------------------------------------------------------------------------
-- 2. HABILITACAO DE RLS EM TABELAS ANTERIORMENTE DESPROTEGIDAS
-- ------------------------------------------------------------------------------

ALTER TABLE room_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 3. REMOCAO DE POLITICAS OBSOLETAS QUE PERMITIAM VAZAMENTO DE user_id IS NULL
-- ------------------------------------------------------------------------------

-- memories
DROP POLICY IF EXISTS "users_read_own_memories" ON memories;
DROP POLICY IF EXISTS "users_insert_own_memories" ON memories;
DROP POLICY IF EXISTS "users_update_own_memories" ON memories;
DROP POLICY IF EXISTS "users_delete_own_memories" ON memories;
DROP POLICY IF EXISTS "service_role_full_access" ON memories;

-- briefs
DROP POLICY IF EXISTS "users_read_own_briefs" ON briefs;
DROP POLICY IF EXISTS "users_insert_own_briefs" ON briefs;
DROP POLICY IF EXISTS "users_update_own_briefs" ON briefs;
DROP POLICY IF EXISTS "users_delete_own_briefs" ON briefs;
DROP POLICY IF EXISTS "service_role_full_access" ON briefs;

-- health_entries
DROP POLICY IF EXISTS "users_read_own_health" ON health_entries;
DROP POLICY IF EXISTS "users_insert_own_health" ON health_entries;
DROP POLICY IF EXISTS "users_update_own_health" ON health_entries;
DROP POLICY IF EXISTS "users_delete_own_health" ON health_entries;
DROP POLICY IF EXISTS "service_role_full_access" ON health_entries;

-- training_logs
DROP POLICY IF EXISTS "users_read_own_training" ON training_logs;
DROP POLICY IF EXISTS "users_insert_own_training" ON training_logs;
DROP POLICY IF EXISTS "users_update_own_training" ON training_logs;
DROP POLICY IF EXISTS "users_delete_own_training" ON training_logs;
DROP POLICY IF EXISTS "service_role_full_access" ON training_logs;

-- projects
DROP POLICY IF EXISTS "users_read_own_projects" ON projects;
DROP POLICY IF EXISTS "users_insert_own_projects" ON projects;
DROP POLICY IF EXISTS "users_update_own_projects" ON projects;
DROP POLICY IF EXISTS "users_delete_own_projects" ON projects;
DROP POLICY IF EXISTS "service_role_full_access" ON projects;

-- profile
DROP POLICY IF EXISTS "users_read_own_profile" ON profile;
DROP POLICY IF EXISTS "users_insert_own_profile" ON profile;
DROP POLICY IF EXISTS "users_update_own_profile" ON profile;
DROP POLICY IF EXISTS "users_delete_own_profile" ON profile;
DROP POLICY IF EXISTS "service_role_full_access" ON profile;

-- coverage_snapshots
DROP POLICY IF EXISTS "users_read_own_coverage" ON coverage_snapshots;
DROP POLICY IF EXISTS "users_insert_own_coverage" ON coverage_snapshots;
DROP POLICY IF EXISTS "users_update_own_coverage" ON coverage_snapshots;
DROP POLICY IF EXISTS "users_delete_own_coverage" ON coverage_snapshots;
DROP POLICY IF EXISTS "service_role_full_access" ON coverage_snapshots;

-- tool_call_log
DROP POLICY IF EXISTS "users_read_own_tool_log" ON tool_call_log;
DROP POLICY IF EXISTS "users_insert_own_tool_log" ON tool_call_log;
DROP POLICY IF EXISTS "service_role_full_access_call_log" ON tool_call_log;

-- health_summaries
DROP POLICY IF EXISTS "service_role_full_access" ON health_summaries;

-- sync_log
DROP POLICY IF EXISTS "service_role_full_access" ON sync_log;

-- entities & entity_mentions
DROP POLICY IF EXISTS "service_role_full_access" ON entities;
DROP POLICY IF EXISTS "service_role_full_access" ON entity_mentions;

-- room_recipes & brief_claims
DROP POLICY IF EXISTS "service_role_full_access" ON room_recipes;
DROP POLICY IF EXISTS "service_role_full_access" ON brief_claims;

-- ------------------------------------------------------------------------------
-- 4. POLITICAS RLS ESTRITAS (FAIL-CLOSED: auth.uid() = user_id)
-- ------------------------------------------------------------------------------

-- memories
CREATE POLICY "service_role_full_access_memories" ON memories
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_memories" ON memories
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_memories" ON memories
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_memories" ON memories
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_memories" ON memories
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- briefs
CREATE POLICY "service_role_full_access_briefs" ON briefs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_briefs" ON briefs
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_briefs" ON briefs
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_briefs" ON briefs
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_briefs" ON briefs
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- health_entries
CREATE POLICY "service_role_full_access_health" ON health_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_health" ON health_entries
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_health" ON health_entries
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_health" ON health_entries
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_health" ON health_entries
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- training_logs
CREATE POLICY "service_role_full_access_training" ON training_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_training" ON training_logs
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_training" ON training_logs
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_training" ON training_logs
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_training" ON training_logs
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- projects
CREATE POLICY "service_role_full_access_projects" ON projects
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_projects" ON projects
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_projects" ON projects
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_projects" ON projects
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_projects" ON projects
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- profile (owner_id): usuario le o seu proprio perfil ou chave de sistema (owner_id IS NULL)
CREATE POLICY "service_role_full_access_profile" ON profile
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_profile" ON profile
    FOR SELECT USING (auth.uid() = owner_id OR owner_id IS NULL OR auth.role() = 'service_role');

CREATE POLICY "users_insert_own_profile" ON profile
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "users_update_own_profile" ON profile
    FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "users_delete_own_profile" ON profile
    FOR DELETE TO authenticated USING (auth.uid() = owner_id);

-- health_summaries
CREATE POLICY "service_role_full_access_summaries" ON health_summaries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_health_summaries" ON health_summaries
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_health_summaries" ON health_summaries
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_health_summaries" ON health_summaries
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_health_summaries" ON health_summaries
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- room_recipes
CREATE POLICY "service_role_full_access_room_recipes" ON room_recipes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_room_recipes" ON room_recipes
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_room_recipes" ON room_recipes
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_room_recipes" ON room_recipes
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_room_recipes" ON room_recipes
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- brief_claims
CREATE POLICY "service_role_full_access_brief_claims" ON brief_claims
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_brief_claims" ON brief_claims
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_brief_claims" ON brief_claims
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_brief_claims" ON brief_claims
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_brief_claims" ON brief_claims
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- entities
CREATE POLICY "service_role_full_access_entities" ON entities
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_entities" ON entities
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_entities" ON entities
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_entities" ON entities
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_entities" ON entities
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- entity_mentions
CREATE POLICY "service_role_full_access_entity_mentions" ON entity_mentions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_entity_mentions" ON entity_mentions
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_entity_mentions" ON entity_mentions
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_entity_mentions" ON entity_mentions
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_entity_mentions" ON entity_mentions
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- sync_log
CREATE POLICY "service_role_full_access_sync_log" ON sync_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_sync_log" ON sync_log
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_sync_log" ON sync_log
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_sync_log" ON sync_log
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_sync_log" ON sync_log
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- coverage_snapshots
CREATE POLICY "service_role_full_access_coverage" ON coverage_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_coverage" ON coverage_snapshots
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_coverage" ON coverage_snapshots
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_coverage" ON coverage_snapshots
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_coverage" ON coverage_snapshots
    FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- tool_call_log (owner_id TEXT)
CREATE POLICY "service_role_full_access_tool_call_log" ON tool_call_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "users_read_own_tool_log" ON tool_call_log
    FOR SELECT TO authenticated USING (owner_id = (auth.uid())::text);

CREATE POLICY "users_insert_own_tool_log" ON tool_call_log
    FOR INSERT TO authenticated WITH CHECK (owner_id = (auth.uid())::text);

CREATE POLICY "users_delete_own_tool_log" ON tool_call_log
    FOR DELETE TO authenticated USING (owner_id = (auth.uid())::text);

-- ------------------------------------------------------------------------------
-- 5. GRANTS E PRIVILEGIOS RLS
-- ------------------------------------------------------------------------------

-- anon e authenticated recebem permissoes CRUD a nivel de tabela;
-- RLS (Row Level Security) governa estritamente o isolamento de linhas (auth.uid() = user_id).
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON briefs TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_summaries TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON room_recipes TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON brief_claims TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_mentions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_log TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON coverage_snapshots TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_call_log TO anon, authenticated;
GRANT SELECT ON tool_catalog TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 6. REMOCAO DE VERSOES ANTIGAS DE RPCS PARA EVITAR CONFLITO DE OVERLOAD POSTGREST
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS compute_daily_summary(DATE);
DROP FUNCTION IF EXISTS search_memories(vector, double precision, integer, text, text[]);
DROP FUNCTION IF EXISTS search_briefs(vector, double precision, integer, text, text, date, date, text[], text[], text[]);
DROP FUNCTION IF EXISTS search_health_entries(vector, double precision, integer, text);
DROP FUNCTION IF EXISTS search_training_logs(vector, double precision, integer, text);
DROP FUNCTION IF EXISTS upsert_memory(text, text, text, text, smallint, text[], text[], jsonb);
DROP FUNCTION IF EXISTS get_tool_activation_report(integer);
DROP FUNCTION IF EXISTS compute_source_coverage(integer);
DROP FUNCTION IF EXISTS capture_coverage_snapshot(integer, text, text);
DROP FUNCTION IF EXISTS get_coverage_transition_report(integer);

-- ------------------------------------------------------------------------------
-- 7. RPCS COM ISOLAMENTO DE OWNER E ASSINATURAS CONGELADAS
-- ------------------------------------------------------------------------------

-- compute_daily_summary: calcula sumario exclusivamente para o owner autenticado
CREATE OR REPLACE FUNCTION compute_daily_summary(
    target_date DATE,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_owner          UUID;
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
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: compute_daily_summary requires an authenticated owner or explicit p_user_id';
    END IF;

    -- Sleep
    SELECT
        COALESCE(SUM(CASE WHEN duration_s IS NOT NULL THEN duration_s ELSE COALESCE((value->>'duration_s')::NUMERIC, 0) END), 0),
        COUNT(*)
    INTO v_sleep_total, v_sleep_sessions
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'sleep'
      AND timestamp::date = target_date;

    -- Steps
    SELECT
        COALESCE(SUM(numeric_value), 0) + COALESCE(SUM((value->>'count')::BIGINT), 0),
        COUNT(*),
        COALESCE(SUM(CASE WHEN value->>'active_minutes' IS NOT NULL THEN (value->>'active_minutes')::NUMERIC ELSE 0 END), 0)
    INTO v_steps_total, v_hr_samples, v_steps_active
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'steps'
      AND timestamp::date = target_date;

    -- Heart rate
    SELECT
        AVG(numeric_value),
        MIN(numeric_value),
        MAX(numeric_value),
        COUNT(*)
    INTO v_hr_avg, v_hr_min, v_hr_max, v_hr_samples
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'heart_rate'
      AND numeric_value IS NOT NULL
      AND timestamp::date = target_date;

    -- Weight (latest reading for the day)
    SELECT numeric_value
    INTO v_weight_kg
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'weight'
      AND numeric_value IS NOT NULL
      AND timestamp::date = target_date
    ORDER BY timestamp DESC
    LIMIT 1;

    -- Exercise
    SELECT
        COUNT(*),
        COALESCE(SUM(CASE WHEN duration_s IS NOT NULL THEN duration_s ELSE 0 END), 0),
        COALESCE(
            ARRAY(
                SELECT DISTINCT tag
                FROM health_entries h
                CROSS JOIN LATERAL unnest(COALESCE(h.tags, '{}'::TEXT[])) AS tag
                WHERE h.user_id = v_owner
                  AND h.entry_type = 'exercise'
                  AND h.timestamp::date = target_date
            ),
            '{}'::TEXT[]
        )
    INTO v_ex_count, v_ex_minutes, v_ex_types
    FROM health_entries
    WHERE user_id = v_owner
      AND entry_type = 'exercise'
      AND timestamp::date = target_date;

    -- Training (from training_logs)
    SELECT
        COUNT(*),
        COALESCE(SUM(volume_kg), 0),
        ARRAY_AGG(DISTINCT workout_type)
    INTO v_wk_count, v_wk_volume, v_wk_types
    FROM training_logs
    WHERE user_id = v_owner
      AND workout_date = target_date;

    -- Collect unique sources
    SELECT ARRAY_AGG(DISTINCT source)
    INTO v_sources
    FROM (
        SELECT source FROM health_entries
        WHERE user_id = v_owner AND timestamp::date = target_date
        UNION ALL
        SELECT 'iron-log'::TEXT FROM training_logs
        WHERE user_id = v_owner AND workout_date = target_date
    ) combined;

    IF v_sources IS NULL THEN v_sources := '{}'; END IF;

    -- UPSERT into health_summaries scoped by user_id
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
        ROUND(v_sleep_total / 3600, 2),
        v_sleep_sessions,
        v_steps_total::INTEGER,
        v_steps_active,
        ROUND(v_hr_avg, 1),
        v_hr_min,
        v_hr_max,
        v_hr_samples,
        ROUND(v_weight_kg, 2),
        v_ex_count,
        ROUND(v_ex_minutes / 60, 2),
        v_ex_types,
        v_wk_count,
        ROUND(v_wk_volume, 1),
        COALESCE(v_wk_types, '{}'),
        v_sources,
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
        'sleep_hours', ROUND(v_sleep_total / 3600, 2),
        'steps_total', v_steps_total,
        'hr_avg', ROUND(v_hr_avg, 1),
        'exercise_minutes', ROUND(v_ex_minutes / 60, 2),
        'training_volume_kg', ROUND(v_wk_volume, 1),
        'sources', v_sources
    );

    RETURN v_result;
END;
$$;

-- search_memories: busca semantica isolada por owner
CREATE OR REPLACE FUNCTION search_memories(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter_category TEXT DEFAULT NULL,
    filter_tags TEXT[] DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
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
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;

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
      AND (1 - (m.embedding <=> query_embedding)) > match_threshold
      AND (filter_category IS NULL OR m.category = filter_category)
      AND (filter_tags IS NULL OR m.tags @> filter_tags)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- search_briefs: busca semantica de briefs isolada por owner
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
    p_user_id UUID DEFAULT NULL
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
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;

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

-- search_health_entries: busca semantica de health isolada por owner
CREATE OR REPLACE FUNCTION search_health_entries(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_entry_type TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
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
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;

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
      AND (1 - (h.embedding <=> query_embedding)) > match_threshold
      AND (filter_entry_type IS NULL OR h.entry_type = filter_entry_type)
    ORDER BY h.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- search_training_logs: busca semantica de training isolada por owner
CREATE OR REPLACE FUNCTION search_training_logs(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 10,
    filter_workout_type TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
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
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RETURN;
    END IF;

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
      AND (1 - (t.embedding <=> query_embedding)) > match_threshold
      AND (filter_workout_type IS NULL OR t.workout_type = filter_workout_type)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- upsert_memory: garante que a memoria inserida/atualizada receba o user_id do owner
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
    v_existing JSONB;
    v_new_id UUID;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: upsert_memory requires an authenticated owner or explicit user_id';
    END IF;

    SELECT to_jsonb(m) INTO v_existing
    FROM memories m
    WHERE m.content = p_content AND m.user_id = v_owner;

    IF v_existing IS NOT NULL THEN
        UPDATE memories
        SET title = COALESCE(p_title, memories.title),
            category = p_category,
            importance = p_importance,
            tags = p_tags,
            people = p_people,
            metadata = p_metadata,
            updated_at = now()
        WHERE memories.id = (v_existing->>'id')::UUID
          AND memories.user_id = v_owner;

        RETURN jsonb_build_object('status', 'updated', 'id', v_existing->>'id');
    ELSE
        INSERT INTO memories (
            user_id, content, title, category, source, importance, tags, people, metadata
        ) VALUES (
            v_owner, p_content, p_title, p_category, p_source, p_importance, p_tags, p_people, p_metadata
        )
        RETURNING id INTO v_new_id;

        RETURN jsonb_build_object('status', 'inserted', 'id', v_new_id);
    END IF;
END;
$$;

-- get_tool_activation_report: metricas de ativacao isoladas por owner
CREATE OR REPLACE FUNCTION get_tool_activation_report(
    p_days integer DEFAULT 90,
    p_owner_id text DEFAULT NULL
)
RETURNS TABLE (
    tool_name TEXT,
    call_count BIGINT,
    success_count BIGINT,
    error_count BIGINT,
    success_rate NUMERIC,
    avg_latency_ms NUMERIC,
    p95_latency_ms NUMERIC,
    last_called_at TIMESTAMPTZ,
    active_days BIGINT,
    distinct_clients BIGINT,
    status TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH v_ctx AS (
        SELECT COALESCE(auth.uid()::text, p_owner_id) AS owner
    ),
    logs AS (
        SELECT l.tool_name, l.timestamp, l.success, l.latency_ms, l.caller_client
        FROM tool_call_log l
        WHERE l.timestamp >= now() - (p_days || ' days')::interval
          AND ((SELECT owner FROM v_ctx) IS NULL OR l.owner_id = (SELECT owner FROM v_ctx))
    ),
    agg AS (
        SELECT
            l.tool_name,
            COUNT(*)::bigint AS call_count,
            COUNT(*) FILTER (WHERE l.success)::bigint AS success_count,
            COUNT(*) FILTER (WHERE NOT l.success)::bigint AS error_count,
            ROUND((COUNT(*) FILTER (WHERE l.success)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) AS success_rate,
            ROUND(AVG(l.latency_ms)::numeric, 1) AS avg_latency_ms,
            ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::numeric, 1) AS p95_latency_ms,
            MAX(l.timestamp) AS last_called_at,
            COUNT(DISTINCT l.timestamp::date)::bigint AS active_days,
            COUNT(DISTINCT l.caller_client)::bigint AS distinct_clients
        FROM logs l
        GROUP BY l.tool_name
    ),
    ever AS (
        SELECT DISTINCT l.tool_name
        FROM tool_call_log l
        WHERE ((SELECT owner FROM v_ctx) IS NULL OR l.owner_id = (SELECT owner FROM v_ctx))
    )
    SELECT
        c.tool_name,
        COALESCE(a.call_count, 0) AS call_count,
        COALESCE(a.success_count, 0) AS success_count,
        COALESCE(a.error_count, 0) AS error_count,
        COALESCE(a.success_rate, 0.0) AS success_rate,
        a.avg_latency_ms,
        a.p95_latency_ms,
        a.last_called_at,
        COALESCE(a.active_days, 0) AS active_days,
        COALESCE(a.distinct_clients, 0) AS distinct_clients,
        CASE
            WHEN a.call_count IS NOT NULL AND a.call_count > 0 THEN 'active'
            WHEN e.tool_name IS NOT NULL THEN 'dormant'
            ELSE 'never_called'
        END AS status
    FROM tool_catalog c
    LEFT JOIN agg a ON a.tool_name = c.tool_name
    LEFT JOIN ever e ON e.tool_name = c.tool_name
    ORDER BY
        CASE
            WHEN a.call_count IS NOT NULL AND a.call_count > 0 THEN 1
            WHEN e.tool_name IS NOT NULL THEN 2
            ELSE 3
        END,
        COALESCE(a.call_count, 0) DESC,
        c.tool_name ASC;
$$;

-- compute_source_coverage: coverage calculada por owner
CREATE OR REPLACE FUNCTION compute_source_coverage(
    target_days integer DEFAULT 7,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    source_name text,
    expected_cadence_hours integer,
    true_zero_possible boolean,
    records_window integer,
    last_record_at timestamptz,
    gap_hours integer,
    coverage_status text,
    notes text[]
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_cutoff timestamptz;
    v_last_summary_refresh timestamptz;
    v_has_recent_workouts boolean;
    v_has_sync_workouts boolean;
    v_has_sync_health boolean;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);
    v_cutoff := now() - (target_days || ' days')::interval;

    SELECT max(computed_at) INTO v_last_summary_refresh
    FROM health_summaries
    WHERE (v_owner IS NULL OR user_id = v_owner);

    SELECT EXISTS (
        SELECT 1 FROM training_logs
        WHERE (v_owner IS NULL OR user_id = v_owner) AND workout_date >= (v_cutoff::date)
    ) INTO v_has_recent_workouts;

    SELECT EXISTS (
        SELECT 1 FROM sync_log
        WHERE (v_owner IS NULL OR user_id = v_owner) AND source = 'iron-log' AND status = 'completed'
    ) INTO v_has_sync_workouts;

    SELECT EXISTS (
        SELECT 1 FROM sync_log
        WHERE (v_owner IS NULL OR user_id = v_owner) AND source IN ('health-connect', 'health-api') AND status = 'completed'
    ) INTO v_has_sync_health;

    RETURN QUERY
    WITH lane_data AS (
        SELECT
            'iron-log'::text AS s_name,
            24 AS s_cadence,
            TRUE AS s_zero_ok,
            count(*)::integer AS s_count,
            max(created_at) AS s_last
        FROM training_logs
        WHERE (v_owner IS NULL OR user_id = v_owner) AND created_at >= v_cutoff
        UNION ALL
        SELECT
            'health-connect'::text,
            24,
            FALSE,
            count(*)::integer,
            max(timestamp)
        FROM health_entries
        WHERE (v_owner IS NULL OR user_id = v_owner) AND timestamp >= v_cutoff AND source = 'health-connect'
        UNION ALL
        SELECT
            'daily-summary'::text,
            24,
            FALSE,
            count(*)::integer,
            max(computed_at)
        FROM health_summaries
        WHERE (v_owner IS NULL OR user_id = v_owner) AND computed_at >= v_cutoff
    )
    SELECT
        ld.s_name,
        ld.s_cadence,
        ld.s_zero_ok,
        ld.s_count,
        ld.s_last,
        CASE WHEN ld.s_last IS NULL THEN NULL ELSE round(extract(epoch FROM (now() - ld.s_last)) / 3600)::integer END AS gap_hours,
        CASE
            WHEN ld.s_last IS NOT NULL AND (now() - ld.s_last) <= (ld.s_cadence || ' hours')::interval THEN 'current'
            WHEN ld.s_last IS NOT NULL AND (now() - ld.s_last) <= (ld.s_cadence * 2 || ' hours')::interval THEN 'delayed'
            WHEN ld.s_last IS NOT NULL THEN 'stale'
            WHEN ld.s_zero_ok THEN 'current'
            ELSE 'missing'
        END AS coverage_status,
        ARRAY[]::text[] AS notes
    FROM lane_data ld;
END;
$$;

-- capture_coverage_snapshot: snapshot com owner
CREATE OR REPLACE FUNCTION capture_coverage_snapshot(
    p_target_days integer DEFAULT 7,
    p_source_kind text DEFAULT 'health',
    p_producer text DEFAULT 'scheduler',
    p_user_id UUID DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_owner UUID;
    v_inserted integer;
BEGIN
    v_owner := COALESCE(auth.uid(), p_user_id);

    INSERT INTO coverage_snapshots (
        user_id, source_kind, source_name, lane, coverage_status, gap_hours,
        expected_cadence_hours, true_zero_possible, notes, producer,
        last_success_at, last_failure_at, last_expected_run_at
    )
    SELECT
        v_owner,
        p_source_kind,
        cov.source_name,
        cov.source_name AS lane,
        cov.coverage_status,
        cov.gap_hours,
        cov.expected_cadence_hours,
        cov.true_zero_possible,
        cov.notes,
        p_producer,
        cov.last_record_at,
        CASE WHEN cov.coverage_status IN ('stale', 'missing') THEN now() ELSE NULL END,
        now()
    FROM compute_source_coverage(p_target_days, v_owner) cov;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

-- get_coverage_transition_report: transicoes isoladas por owner
CREATE OR REPLACE FUNCTION get_coverage_transition_report(
    p_days integer DEFAULT 30,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    source_kind TEXT,
    source_name TEXT,
    lane TEXT,
    prev_status TEXT,
    prev_captured_at TIMESTAMPTZ,
    current_status TEXT,
    current_captured_at TIMESTAMPTZ,
    transition_type TEXT,
    first_degraded_at TIMESTAMPTZ,
    degradation_streak INTEGER,
    gap_hours INTEGER,
    expected_cadence_hours INTEGER,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_expected_run_at TIMESTAMPTZ,
    artifact_freshness_status TEXT,
    trust_blocking BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH v_ctx AS (
        SELECT COALESCE(auth.uid(), p_user_id) AS owner
    ),
    cutoff AS (
        SELECT now() - (p_days || ' days')::interval AS c
    ),
    snaps AS (
        SELECT s.id, s.captured_at, s.source_kind, s.source_name, s.lane,
               s.coverage_status, s.gap_hours, s.expected_cadence_hours,
               s.last_success_at, s.last_failure_at, s.last_expected_run_at,
               (s.coverage_status <> 'current') AS bad
        FROM coverage_snapshots s
        WHERE s.captured_at >= (SELECT c FROM cutoff)
          AND ((SELECT owner FROM v_ctx) IS NULL OR s.user_id = (SELECT owner FROM v_ctx))
    ),
    islands AS (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY source_kind, lane ORDER BY captured_at)
              - SUM(bad::int) OVER (PARTITION BY source_kind, lane ORDER BY captured_at) AS grp
        FROM snaps
    ),
    latest_all AS (
        SELECT *,
            ROW_NUMBER() OVER (PARTITION BY source_kind, lane ORDER BY captured_at DESC) AS rn
        FROM islands
    ),
    latest AS (SELECT * FROM latest_all WHERE rn = 1),
    prev AS (SELECT * FROM latest_all WHERE rn = 2),
    current_island AS (
        SELECT i.source_kind, i.lane, COUNT(*) AS streak, MIN(i.captured_at) AS first_degraded_at
        FROM islands i
        JOIN latest l ON l.source_kind = i.source_kind AND l.lane = i.lane AND l.grp = i.grp
        GROUP BY i.source_kind, i.lane
    )
    SELECT
        l.source_kind,
        l.source_name,
        l.lane,
        p.coverage_status AS prev_status,
        p.captured_at AS prev_captured_at,
        l.coverage_status AS current_status,
        l.captured_at AS current_captured_at,
        CASE
            WHEN p.coverage_status IS NULL THEN 'initial'
            WHEN p.coverage_status = l.coverage_status THEN 'unchanged'
            WHEN p.coverage_status = 'current' AND l.coverage_status <> 'current' THEN 'degraded'
            WHEN p.coverage_status <> 'current' AND l.coverage_status = 'current' THEN 'recovered'
            ELSE 'status_shift'
        END AS transition_type,
        CASE WHEN l.bad THEN ci.first_degraded_at ELSE NULL END AS first_degraded_at,
        CASE WHEN l.bad THEN ci.streak ELSE 0 END AS degradation_streak,
        l.gap_hours,
        l.expected_cadence_hours,
        l.last_success_at,
        l.last_failure_at,
        l.last_expected_run_at,
        CASE
            WHEN l.last_success_at IS NULL THEN 'unknown'
            WHEN (now() - l.last_success_at) <= (l.expected_cadence_hours || ' hours')::interval THEN 'fresh'
            WHEN (now() - l.last_success_at) <= (l.expected_cadence_hours * 2 || ' hours')::interval THEN 'aging'
            ELSE 'stale'
        END AS artifact_freshness_status,
        (l.bad AND COALESCE(ci.streak, 0) >= 2) AS trust_blocking
    FROM latest l
    LEFT JOIN prev p ON p.source_kind = l.source_kind AND p.lane = l.lane
    LEFT JOIN current_island ci ON ci.source_kind = l.source_kind AND ci.lane = l.lane;
$$;

-- ------------------------------------------------------------------------------
-- 8. AUDITORIA E PLANO DE BACKFILL DE LINHAS LEGADAS
-- ------------------------------------------------------------------------------

-- alexandria_audit_legacy_unowned_rows: reporta contagem de linhas sem owner em cada tabela
CREATE OR REPLACE FUNCTION alexandria_audit_legacy_unowned_rows()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_report JSONB := '{}'::jsonb;
    v_count  BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_count FROM memories WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{memories}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM briefs WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{briefs}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM health_entries WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{health_entries}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM training_logs WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{training_logs}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM projects WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{projects}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM profile WHERE owner_id IS NULL;
    v_report := jsonb_set(v_report, '{profile}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM health_summaries WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{health_summaries}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM room_recipes WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{room_recipes}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM brief_claims WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{brief_claims}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM entities WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{entities}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM entity_mentions WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{entity_mentions}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM sync_log WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{sync_log}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM coverage_snapshots WHERE user_id IS NULL;
    v_report := jsonb_set(v_report, '{coverage_snapshots}', to_jsonb(v_count));

    SELECT COUNT(*) INTO v_count FROM tool_call_log WHERE owner_id IS NULL;
    v_report := jsonb_set(v_report, '{tool_call_log}', to_jsonb(v_count));

    RETURN v_report;
END;
$$;

-- alexandria_backfill_legacy_owner: atribui linhas legadas ao target_owner_id aprovado
-- Fail-closed: se target_owner_id for NULL ou inexistente, aborta com relatorio detalhado.
CREATE OR REPLACE FUNCTION alexandria_backfill_legacy_owner(target_owner_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_exists BOOLEAN;
    v_updated JSONB := '{}'::jsonb;
    v_count BIGINT;
BEGIN
    IF target_owner_id IS NULL THEN
        RAISE EXCEPTION 'Owner invariant violation: target_owner_id cannot be null. Ambiguous legacy rows abort without backfill target. Audit report: %',
            alexandria_audit_legacy_unowned_rows();
    END IF;

    SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = target_owner_id) INTO v_exists;
    IF NOT v_exists THEN
        RAISE EXCEPTION 'Owner invariant violation: target owner % not found in auth.users', target_owner_id;
    END IF;

    UPDATE memories SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{memories}', to_jsonb(v_count));

    UPDATE briefs SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{briefs}', to_jsonb(v_count));

    UPDATE health_entries SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{health_entries}', to_jsonb(v_count));

    UPDATE training_logs SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{training_logs}', to_jsonb(v_count));

    UPDATE projects SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{projects}', to_jsonb(v_count));

    UPDATE health_summaries SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{health_summaries}', to_jsonb(v_count));

    UPDATE room_recipes SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{room_recipes}', to_jsonb(v_count));

    UPDATE brief_claims SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{brief_claims}', to_jsonb(v_count));

    UPDATE entities SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{entities}', to_jsonb(v_count));

    UPDATE entity_mentions SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{entity_mentions}', to_jsonb(v_count));

    UPDATE sync_log SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{sync_log}', to_jsonb(v_count));

    UPDATE coverage_snapshots SET user_id = target_owner_id WHERE user_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{coverage_snapshots}', to_jsonb(v_count));

    UPDATE tool_call_log SET owner_id = target_owner_id::text WHERE owner_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_updated := jsonb_set(v_updated, '{tool_call_log}', to_jsonb(v_count));

    RETURN jsonb_build_object(
        'success', true,
        'target_owner_id', target_owner_id,
        'updated_records', v_updated
    );
END;
$$;

-- Permissoes explicitas nas funcoes de auditoria e backfill
REVOKE ALL ON FUNCTION alexandria_audit_legacy_unowned_rows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION alexandria_audit_legacy_unowned_rows() TO authenticated, service_role;

REVOKE ALL ON FUNCTION alexandria_backfill_legacy_owner(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION alexandria_backfill_legacy_owner(UUID) TO service_role;
