CREATE TABLE IF NOT EXISTS brief_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  entity text NOT NULL DEFAULT '',
  metric text NOT NULL DEFAULT '',
  value_numeric double precision,
  value_text text DEFAULT '',
  unit text DEFAULT '',
  time_scope text DEFAULT '',
  source_snippet text DEFAULT '',
  confidence text DEFAULT 'medium',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brief_claims_entity_metric
  ON brief_claims (entity, metric);

CREATE INDEX IF NOT EXISTS idx_brief_claims_brief_id
  ON brief_claims (brief_id);
