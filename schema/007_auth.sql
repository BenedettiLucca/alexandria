-- ============================================================
-- Alexandria: Supabase Auth + Per-user Scoping
-- ============================================================

-- Add owner_id to profile for per-user scoping
ALTER TABLE profile ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id);

-- Replace single-key unique constraint with partial indexes
-- Profiles WITH an owner_id: unique per (key, owner_id)
-- Profiles WITHOUT an owner_id: unique per key (legacy/key-auth)
DROP INDEX IF EXISTS profile_key_unique;
CREATE UNIQUE INDEX profile_key_owner_unique ON profile (key, owner_id)
    WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX profile_key_null_owner ON profile (key)
    WHERE owner_id IS NULL;

-- Enable RLS on entities + entity_mentions if not already
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_summaries ENABLE ROW LEVEL SECURITY;

-- Service role keeps full access (for importers, sync jobs, etc.)
CREATE POLICY "service_role_full_access" ON entities
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON entity_mentions
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON health_summaries
    FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users can read/write their own profile sections
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

-- Authenticated users can read/write their own memories
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

-- Authenticated users can read/write their own health entries
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

-- Authenticated users can read/write their own training logs
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

-- Authenticated users can read/write their own projects
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

-- Grant authenticated users permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO authenticated;
GRANT SELECT ON entities TO authenticated;
GRANT SELECT ON entity_mentions TO authenticated;
GRANT SELECT ON health_summaries TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
