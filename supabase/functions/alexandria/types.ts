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

export interface BriefRow {
  id: string;
  user_id: string | null;
  source_job: string;
  title: string;
  brief_date: string;
  kind: string;
  body_markdown: string;
  topics: string[] | null;
  project_refs: string[] | null;
  entity_refs: string[] | null;
  content_hash: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  embedding: number[] | null;
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

