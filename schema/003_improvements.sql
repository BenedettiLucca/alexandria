-- ============================================================
-- Alexandria: Schema Improvements (Phase 1 + 2)
-- Run after 001_core.sql and 002_security.sql
-- ============================================================

-- 1.1 Bi-temporal timestamps: event_time tracks when the event
--     actually happened (distinct from created_at = ingestion time)
ALTER TABLE health_entries ADD COLUMN IF NOT EXISTS event_time TIMESTAMPTZ;
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS event_time TIMESTAMPTZ;

-- Backfill event_time from existing timestamp columns
UPDATE health_entries SET event_time = timestamp WHERE event_time IS NULL;
UPDATE training_logs SET event_time = 
    workout_date::timestamptz + interval '12 hours' 
WHERE event_time IS NULL;

-- Index for temporal queries
CREATE INDEX IF NOT EXISTS idx_health_event_time 
    ON health_entries (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_training_event_time 
    ON training_logs (event_time DESC);

-- 1.2 Typed numeric value for efficient range queries
ALTER TABLE health_entries ADD COLUMN IF NOT EXISTS numeric_value NUMERIC;

CREATE INDEX IF NOT EXISTS idx_health_type_numeric 
    ON health_entries (entry_type, numeric_value DESC);

-- 2.1 Add body_composition entry type
ALTER TABLE health_entries DROP CONSTRAINT IF EXISTS health_entries_entry_type_check;
ALTER TABLE health_entries ADD CONSTRAINT health_entries_entry_type_check
    CHECK (entry_type IN (
        'sleep', 'exercise', 'heart_rate', 'steps',
        'weight', 'water', 'nutrition', 'blood_pressure',
        'stress', 'cycle', 'body_composition'
    ));

-- 1.3 Clean up source enums — remove samsung-health, add health-connect variants
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_source_check;
ALTER TABLE memories ADD CONSTRAINT memories_source_check
    CHECK (source IN (
        'manual', 'mcp', 'import', 'capture',
        'health-connect', 'iron-log', 'auto'
    ));

-- Add ingestion_source and external_id for better upsert tracking
ALTER TABLE health_entries ADD COLUMN IF NOT EXISTS ingestion_source TEXT;
ALTER TABLE health_entries ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS ingestion_source TEXT;
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Unique index on external_id per source for upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_external_id 
    ON health_entries (ingestion_source, external_id)
    WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_external_id 
    ON training_logs (ingestion_source, external_id)
    WHERE external_id IS NOT NULL;

-- 2.4 Sync state tracking
CREATE TABLE IF NOT EXISTS sync_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source              TEXT NOT NULL
                        CHECK (source IN ('iron-log', 'health-connect', 'health-api')),
    sync_type           TEXT NOT NULL DEFAULT 'incremental'
                        CHECK (sync_type IN ('full', 'incremental')),
    records_processed   INTEGER DEFAULT 0,
    records_imported    INTEGER DEFAULT 0,
    records_skipped     INTEGER DEFAULT 0,
    records_failed      INTEGER DEFAULT 0,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
    error_message       TEXT,
    metadata            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sync_log_source 
    ON sync_log (source, started_at DESC);

-- Enable RLS on sync_log
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON sync_log
    FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_log TO service_role;

-- Grant access to new columns (no-op if already granted, but safe)
GRANT SELECT, INSERT, UPDATE, DELETE ON health_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON training_logs TO service_role;
