export interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  category: string;
  tags: string[] | null;
  source: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
  embedding: number[] | null;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  conventions: string | null;
  status: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HealthEntryRow {
  id: string;
  user_id: string;
  timestamp: string;
  entry_type: string;
  value: string | null;
  numeric_value: number | null;
  duration_s: number | null;
  source: string | null;
  external_id: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingLogRow {
  id: string;
  user_id: string;
  workout_date: string;
  workout_type: string | null;
  name: string;
  exercises: Record<string, unknown>[] | null;
  duration_s: number | null;
  volume_kg: number | null;
  numeric_value: number | null;
  rpe: number | null;
  notes: string | null;
  tags: string[] | null;
  source: string | null;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityMentionRow {
  id: string;
  entity_id: string;
  memory_id: string | null;
  context: string | null;
  created_at: string;
}

export interface HealthSummaryRow {
  id: string;
  user_id: string;
  summary_date: string;
  entry_type: string;
  summary_text: string;
  computed_at: string;
  created_at: string;
}

export interface SyncLogRow {
  id: string;
  user_id: string;
  source: string;
  sync_type: string;
  status: string;
  records_processed: number;
  records_imported: number;
  records_skipped: number;
  records_failed: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  owner_id: string | null;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}
