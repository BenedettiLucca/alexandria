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
