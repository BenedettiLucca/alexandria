-- ============================================================
-- Alexandria: Security (Row Level Security + Permissions)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_logs ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by Edge Functions)
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

-- Grant service_role permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO service_role;

-- Grant usage on sequences (for potential future use)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
