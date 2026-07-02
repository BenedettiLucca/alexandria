CREATE TABLE IF NOT EXISTS room_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text DEFAULT '',
  profile_hint text DEFAULT '',
  topic_seed text DEFAULT '',
  allowed_kinds text[] DEFAULT '{}',
  allowed_source_jobs text[] DEFAULT '{}',
  excluded_kinds text[] DEFAULT '{}',
  excluded_source_jobs text[] DEFAULT '{}',
  required_project_refs text[] DEFAULT '{}',
  required_entity_refs text[] DEFAULT '{}',
  freshness_window_days int DEFAULT 14,
  priority_weights jsonb DEFAULT '{}'::jsonb,
  max_items_default int DEFAULT 15,
  token_budget_hint int,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
