-- ============================================================
-- Alexandria: Knowledge Graph
-- Entity extraction from memories
-- ============================================================

CREATE TABLE entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN (
                    'person', 'project', 'concept', 'location',
                    'technology', 'organization', 'event', 'other'
                )),
    description TEXT,
    aliases     TEXT[] DEFAULT '{}',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(name, entity_type)
);

CREATE TABLE entity_mentions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    context     TEXT,
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(memory_id, entity_id)
);

CREATE INDEX idx_entities_name ON entities (name);
CREATE INDEX idx_entities_type ON entities (entity_type);
CREATE INDEX idx_entity_mentions_memory ON entity_mentions (memory_id);
CREATE INDEX idx_entity_mentions_entity ON entity_mentions (entity_id);

CREATE TRIGGER entities_updated_at
    BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON entities
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_full_access" ON entity_mentions
    FOR ALL USING (auth.role() = 'service_role');

GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_mentions TO service_role;
