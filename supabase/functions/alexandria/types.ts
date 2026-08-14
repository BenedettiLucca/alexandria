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

export interface MemoryRow {
  id: string;
  user_id: string | null;
  content: string;
  title: string | null;
  category: string;
  source: string;
  importance: number | null;
  tags: string[] | null;
  people: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string | null;
  name: string;
  path: string | null;
  description: string | null;
  stack: string[] | null;
  conventions: Record<string, unknown> | null;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type HealthEntryType =
  | "sleep"
  | "exercise"
  | "heart_rate"
  | "steps"
  | "weight"
  | "water"
  | "nutrition"
  | "blood_pressure"
  | "stress"
  | "cycle"
  | "body_composition"
  | "personal_record"
  | "measurement_goal";

export interface HealthEntryRow {
  id: string;
  user_id: string | null;
  entry_type: HealthEntryType;
  timestamp: string;
  duration_s: number | null;
  value: Record<string, unknown> | null;
  numeric_value: number | null;
  embedding: number[] | null;
  tags: string[] | null;
  source: string | null;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface TrainingLogRow {
  id: string;
  user_id: string | null;
  workout_date: string;
  workout_type: string;
  name: string;
  exercises: Record<string, unknown>[] | null;
  duration_s: number | null;
  volume_kg: number | null;
  numeric_value: number | null;
  rpe: number | null;
  notes: string | null;
  tags: string[] | null;
  external_id: string | null;
  embedding: number[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface HealthSummaryRow {
  id: string;
  date: string;
  sleep_total_hours: number | null;
  sleep_sessions: number | null;
  steps_total: number | null;
  steps_active_minutes: number | null;
  hr_avg: number | null;
  hr_min: number | null;
  hr_max: number | null;
  hr_samples: number | null;
  weight_kg: number | null;
  exercise_count: number | null;
  exercise_total_minutes: number | null;
  exercise_types: string[] | null;
  workout_count: number | null;
  training_volume_kg: number | null;
  training_types: string[] | null;
  sources: string[] | null;
  computed_at: string;
}

export type EntityType =
  | "person"
  | "project"
  | "concept"
  | "location"
  | "technology"
  | "organization"
  | "event"
  | "other";

export interface EntityRow {
  id: string;
  name: string;
  entity_type: EntityType;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface EntityMentionRow {
  id: string;
  memory_id: string;
  entity_id: string;
  context: string | null;
  created_at: string;
}

export interface SyncLogRow {
  id: string;
  source: string;
  sync_type: string;
  records_processed: number | null;
  records_imported: number | null;
  records_skipped: number | null;
  records_failed: number | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ProfileRow {
  id: string;
  owner_id: string | null;
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

export interface RoomRecipeRow {
  id: string;
  name: string;
  description: string | null;
  profile_hint: string | null;
  topic_seed: string | null;
  allowed_kinds: string[] | null;
  allowed_source_jobs: string[] | null;
  excluded_kinds: string[] | null;
  excluded_source_jobs: string[] | null;
  required_project_refs: string[] | null;
  required_entity_refs: string[] | null;
  freshness_window_days: number | null;
  priority_weights: Record<string, unknown> | null;
  max_items_default: number | null;
  token_budget_hint: number | null;
  created_at: string;
  updated_at: string;
}

export interface BriefClaimRow {
  id: string;
  brief_id: string;
  entity: string;
  metric: string;
  value_numeric: number | null;
  value_text: string | null;
  unit: string | null;
  time_scope: string | null;
  source_snippet: string | null;
  confidence: string | null;
  created_at: string;
}

export type CoverageStatus =
  | "current"
  | "late"
  | "summary_stale"
  | "missing"
  | "never_seen";

export interface CoverageRow {
  source_name: string;
  lane: string;
  last_event_at: string | null;
  last_ingested_at: string | null;
  last_summary_refresh_at: string | null;
  expected_cadence_hours: number;
  gap_hours: number | null;
  coverage_status: CoverageStatus;
  true_zero_possible: boolean;
  notes: string[];
}

export type TransitionType =
  | "NEW"
  | "ONGOING"
  | "RECOVERED"
  | "STEADY";

export type ArtifactFreshnessStatus = "fresh" | "stale" | "missing" | "n/a";

export interface TransitionRow {
  source_kind: string;
  source_name: string;
  lane: string;
  prev_status: string | null;
  prev_captured_at: string | null;
  current_status: string;
  current_captured_at: string;
  transition_type: TransitionType;
  first_degraded_at: string | null;
  degradation_streak: number;
  gap_hours: number | null;
  expected_cadence_hours: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_expected_run_at: string | null;
  artifact_freshness_status: ArtifactFreshnessStatus;
  trust_blocking: boolean;
}

export interface SearchMemoryRow extends MemoryRow {
  similarity: number;
}

export interface SearchBriefRow extends BriefRow {
  similarity: number;
}

export interface SearchHealthEntryRow {
  id: string;
  entry_type: string;
  timestamp: string;
  duration_s: number | null;
  numeric_value: number | null;
  value: Record<string, unknown> | null;
  tags: string[] | null;
  source: string | null;
  similarity: number;
}

export interface SearchTrainingLogRow {
  id: string;
  workout_date: string;
  workout_type: string;
  name: string;
  exercises: Record<string, unknown>[] | null;
  volume_kg: number | null;
  numeric_value: number | null;
  rpe: number | null;
  notes: string | null;
  tags: string[] | null;
  duration_s: number | null;
  similarity: number;
}

export interface UpsertMemoryResult {
  id: string;
  status: "created" | "updated";
}

export interface DailySummaryResult extends Record<string, unknown> {}

export type Database = {
  public: {
    Tables: {
      memories: {
        Row: MemoryRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      projects: {
        Row: ProjectRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      briefs: {
        Row: BriefRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      profile: {
        Row: ProfileRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      health_entries: {
        Row: HealthEntryRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      training_logs: {
        Row: TrainingLogRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      health_summaries: {
        Row: HealthSummaryRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      entities: {
        Row: EntityRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      entity_mentions: {
        Row: EntityMentionRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      sync_log: {
        Row: SyncLogRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      room_recipes: {
        Row: RoomRecipeRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      brief_claims: {
        Row: BriefClaimRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      search_memories: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          filter_category?: string;
          filter_tags?: string[];
        };
        Returns: SearchMemoryRow[];
      };
      search_briefs: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          filter_kind?: string;
          filter_source_job?: string;
          filter_date_from?: string;
          filter_date_to?: string;
          filter_topics?: string[];
          filter_project_refs?: string[];
          filter_entity_refs?: string[];
        };
        Returns: SearchBriefRow[];
      };
      upsert_memory: {
        Args: {
          p_content: string;
          p_title?: string;
          p_category?: string;
          p_source?: string;
          p_importance?: number;
          p_tags?: string[];
          p_people?: string[];
          p_metadata?: Record<string, unknown>;
        };
        Returns: UpsertMemoryResult[];
      };
      compute_daily_summary: {
        Args: { target_date: string };
        Returns: DailySummaryResult[];
      };
      search_health_entries: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          filter_entry_type?: string;
        };
        Returns: SearchHealthEntryRow[];
      };
      search_training_logs: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          filter_workout_type?: string;
        };
        Returns: SearchTrainingLogRow[];
      };
      compute_source_coverage: {
        Args: { target_days?: number };
        Returns: CoverageRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
