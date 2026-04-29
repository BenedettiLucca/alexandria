
CREATE OR REPLACE FUNCTION upsert_memory(
    p_content TEXT, p_title TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'note', p_source TEXT DEFAULT 'mcp',
    p_importance SMALLINT DEFAULT 5, p_tags TEXT[] DEFAULT '{}',
    p_people TEXT[] DEFAULT '{}', p_metadata JSONB DEFAULT '{}'
)
RETURNS JSONB AS $$
DECLARE
    v_fingerprint TEXT; v_existing JSONB; v_merged_meta JSONB; v_new_id JSONB;
BEGIN
    v_fingerprint := encode(sha256(p_content::bytea), 'hex');
    SELECT to_jsonb(m) INTO v_existing
    FROM memories m WHERE m.content = p_content;
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
    INSERT INTO memories (content, title, category, source, importance, tags, people, metadata)
    VALUES (p_content, p_title, p_category, p_source, p_importance, p_tags, p_people, p_metadata)
    RETURNING jsonb_build_object('id', id, 'status', 'created') INTO v_new_id;
    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;
