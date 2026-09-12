-- T07: canonical importer sync sources and lifecycle statuses

ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_source_check;
ALTER TABLE sync_log
    ADD CONSTRAINT sync_log_source_check
    CHECK (source IN ('iron-log', 'health-connect', 'health-api', 'meetcap'));

ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_status_check;
ALTER TABLE sync_log
    ADD CONSTRAINT sync_log_status_check
    CHECK (status IN ('running', 'completed', 'partial', 'failed'));
