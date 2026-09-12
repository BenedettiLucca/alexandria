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

export interface ToolCatalogRow {
  tool_name: string;
  created_at: string;
}

export interface ToolCallLogRow {
  id: number;
  tool_name: string;
  caller_client: string | null;
  timestamp: string;
  params_hash: string | null;
  success: boolean;
  latency_ms: number | null;
  owner_id: string | null;
}

export type ToolActivationTrend =
  | "never"
  | "dormant"
  | "rising"
  | "falling"
  | "stable";

export interface ToolActivationRow {
  tool_name: string;
  never_called: boolean;
  called_7d: boolean;
  called_30d: boolean;
  called_90d: boolean;
  total_calls: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  last_called_at: string | null;
  client_count: number;
  clients: string[];
  trend: ToolActivationTrend;
}

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
      tool_catalog: {
        Row: ToolCatalogRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      tool_call_log: {
        Row: ToolCallLogRow;
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
      get_coverage_transition_report: {
        Args: { p_days?: number };
        Returns: TransitionRow[];
      };
      get_tool_activation_report: {
        Args: { p_days?: number };
        Returns: ToolActivationRow[];
      };
      prune_tool_call_log: {
        Args: { p_retention_days?: number };
        Returns: number[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

// ===== BEGIN GENERATED SCHEMA TYPES (#65) — fonte da verdade do schema =====
// Regenerar: supabase gen types typescript --local --schema public
// STATUS: baseline de drift. O hand-written `Database` abaixo permanece canonical
// ate migracao gradual das tools (checklist: lifecycle cols faltam nas interfaces,
// embedding chega como string via PostgREST, nullability mais estrita => ~57 fixes).
// NAO editar a mao o bloco gerado.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type DatabaseGenerated = {
  public: {
    Tables: {
      brief_claims: {
        Row: {
          brief_id: string
          confidence: string | null
          created_at: string | null
          entity: string
          id: string
          metric: string
          source_snippet: string | null
          time_scope: string | null
          unit: string | null
          user_id: string | null
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          brief_id: string
          confidence?: string | null
          created_at?: string | null
          entity?: string
          id?: string
          metric?: string
          source_snippet?: string | null
          time_scope?: string | null
          unit?: string | null
          user_id?: string | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          brief_id?: string
          confidence?: string | null
          created_at?: string | null
          entity?: string
          id?: string
          metric?: string
          source_snippet?: string | null
          time_scope?: string | null
          unit?: string | null
          user_id?: string | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brief_claims_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
        ]
      }
      briefs: {
        Row: {
          body_markdown: string
          brief_date: string
          content_hash: string
          created_at: string
          embedded_at: string | null
          embedding: string | null
          embedding_space: string | null
          embedding_status: string
          embedding_version: number
          entity_refs: string[] | null
          id: string
          kind: string
          metadata: Json | null
          project_refs: string[] | null
          source_job: string
          source_path: string | null
          title: string
          topics: string[] | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          body_markdown: string
          brief_date: string
          content_hash: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          entity_refs?: string[] | null
          id?: string
          kind: string
          metadata?: Json | null
          project_refs?: string[] | null
          source_job: string
          source_path?: string | null
          title: string
          topics?: string[] | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          body_markdown?: string
          brief_date?: string
          content_hash?: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          entity_refs?: string[] | null
          id?: string
          kind?: string
          metadata?: Json | null
          project_refs?: string[] | null
          source_job?: string
          source_path?: string | null
          title?: string
          topics?: string[] | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      coverage_snapshots: {
        Row: {
          captured_at: string
          coverage_status: string
          expected_cadence_hours: number | null
          gap_hours: number | null
          id: number
          lane: string
          last_event_at: string | null
          last_expected_run_at: string | null
          last_failure_at: string | null
          last_ingested_at: string | null
          last_success_at: string | null
          notes: string[]
          producer: string
          source_kind: string
          source_name: string
          true_zero_possible: boolean
          user_id: string | null
        }
        Insert: {
          captured_at?: string
          coverage_status: string
          expected_cadence_hours?: number | null
          gap_hours?: number | null
          id?: number
          lane: string
          last_event_at?: string | null
          last_expected_run_at?: string | null
          last_failure_at?: string | null
          last_ingested_at?: string | null
          last_success_at?: string | null
          notes?: string[]
          producer?: string
          source_kind?: string
          source_name: string
          true_zero_possible?: boolean
          user_id?: string | null
        }
        Update: {
          captured_at?: string
          coverage_status?: string
          expected_cadence_hours?: number | null
          gap_hours?: number | null
          id?: number
          lane?: string
          last_event_at?: string | null
          last_expected_run_at?: string | null
          last_failure_at?: string | null
          last_ingested_at?: string | null
          last_success_at?: string | null
          notes?: string[]
          producer?: string
          source_kind?: string
          source_name?: string
          true_zero_possible?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      entities: {
        Row: {
          created_at: string
          description: string | null
          entity_type: string
          id: string
          metadata: Json | null
          name: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          entity_type: string
          id?: string
          metadata?: Json | null
          name: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          entity_type?: string
          id?: string
          metadata?: Json | null
          name?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      entity_mentions: {
        Row: {
          context: string | null
          created_at: string
          entity_id: string
          id: string
          memory_id: string
          user_id: string | null
        }
        Insert: {
          context?: string | null
          created_at?: string
          entity_id: string
          id?: string
          memory_id: string
          user_id?: string | null
        }
        Update: {
          context?: string | null
          created_at?: string
          entity_id?: string
          id?: string
          memory_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "entity_mentions_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_mentions_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      health_entries: {
        Row: {
          content_hash: string | null
          created_at: string
          duration_s: number | null
          embedded_at: string | null
          embedding: string | null
          embedding_space: string | null
          embedding_status: string
          embedding_version: number
          entry_type: string
          external_id: string | null
          id: string
          metadata: Json | null
          numeric_value: number | null
          source: string | null
          tags: string[] | null
          timestamp: string
          user_id: string | null
          value: Json
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          duration_s?: number | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          entry_type: string
          external_id?: string | null
          id?: string
          metadata?: Json | null
          numeric_value?: number | null
          source?: string | null
          tags?: string[] | null
          timestamp: string
          user_id?: string | null
          value?: Json
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          duration_s?: number | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          entry_type?: string
          external_id?: string | null
          id?: string
          metadata?: Json | null
          numeric_value?: number | null
          source?: string | null
          tags?: string[] | null
          timestamp?: string
          user_id?: string | null
          value?: Json
        }
        Relationships: []
      }
      health_summaries: {
        Row: {
          computed_at: string
          date: string
          exercise_count: number | null
          exercise_total_minutes: number | null
          exercise_types: string[] | null
          hr_avg: number | null
          hr_max: number | null
          hr_min: number | null
          hr_samples: number | null
          id: string
          sleep_sessions: number | null
          sleep_total_hours: number | null
          sources: string[] | null
          steps_active_minutes: number | null
          steps_total: number | null
          training_types: string[] | null
          training_volume_kg: number | null
          user_id: string | null
          weight_kg: number | null
          workout_count: number | null
        }
        Insert: {
          computed_at?: string
          date: string
          exercise_count?: number | null
          exercise_total_minutes?: number | null
          exercise_types?: string[] | null
          hr_avg?: number | null
          hr_max?: number | null
          hr_min?: number | null
          hr_samples?: number | null
          id?: string
          sleep_sessions?: number | null
          sleep_total_hours?: number | null
          sources?: string[] | null
          steps_active_minutes?: number | null
          steps_total?: number | null
          training_types?: string[] | null
          training_volume_kg?: number | null
          user_id?: string | null
          weight_kg?: number | null
          workout_count?: number | null
        }
        Update: {
          computed_at?: string
          date?: string
          exercise_count?: number | null
          exercise_total_minutes?: number | null
          exercise_types?: string[] | null
          hr_avg?: number | null
          hr_max?: number | null
          hr_min?: number | null
          hr_samples?: number | null
          id?: string
          sleep_sessions?: number | null
          sleep_total_hours?: number | null
          sources?: string[] | null
          steps_active_minutes?: number | null
          steps_total?: number | null
          training_types?: string[] | null
          training_volume_kg?: number | null
          user_id?: string | null
          weight_kg?: number | null
          workout_count?: number | null
        }
        Relationships: []
      }
      indexing_outbox: {
        Row: {
          attempts: number
          content_hash: string
          created_at: string
          error_class: string | null
          id: string
          job_type: string
          last_error: string | null
          locked_until: string | null
          max_attempts: number
          processed_at: string | null
          scheduled_at: string
          source_id: string
          source_table: string
          source_version: number
          status: string
          target_dimension: number
          target_space: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          attempts?: number
          content_hash: string
          created_at?: string
          error_class?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          locked_until?: string | null
          max_attempts?: number
          processed_at?: string | null
          scheduled_at?: string
          source_id: string
          source_table: string
          source_version?: number
          status?: string
          target_dimension?: number
          target_space?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          attempts?: number
          content_hash?: string
          created_at?: string
          error_class?: string | null
          id?: string
          job_type?: string
          last_error?: string | null
          locked_until?: string | null
          max_attempts?: number
          processed_at?: string | null
          scheduled_at?: string
          source_id?: string
          source_table?: string
          source_version?: number
          status?: string
          target_dimension?: number
          target_space?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      memories: {
        Row: {
          category: string
          content: string
          content_hash: string
          created_at: string
          embedded_at: string | null
          embedding: string | null
          embedding_space: string | null
          embedding_status: string
          embedding_version: number
          enriched_at: string | null
          enrichment_status: string
          id: string
          importance: number | null
          metadata: Json | null
          people: string[] | null
          source: string
          tags: string[] | null
          title: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          category?: string
          content: string
          content_hash: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          enriched_at?: string | null
          enrichment_status?: string
          id?: string
          importance?: number | null
          metadata?: Json | null
          people?: string[] | null
          source?: string
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          category?: string
          content?: string
          content_hash?: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          enriched_at?: string | null
          enrichment_status?: string
          id?: string
          importance?: number | null
          metadata?: Json | null
          people?: string[] | null
          source?: string
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      profile: {
        Row: {
          id: string
          key: string
          owner_id: string | null
          updated_at: string
          value: Json
        }
        Insert: {
          id?: string
          key: string
          owner_id?: string | null
          updated_at?: string
          value: Json
        }
        Update: {
          id?: string
          key?: string
          owner_id?: string | null
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      projects: {
        Row: {
          conventions: Json | null
          created_at: string
          description: string | null
          id: string
          metadata: Json | null
          name: string
          path: string | null
          stack: string[] | null
          status: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          conventions?: Json | null
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json | null
          name: string
          path?: string | null
          stack?: string[] | null
          status?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          conventions?: Json | null
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          path?: string | null
          stack?: string[] | null
          status?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      room_recipes: {
        Row: {
          allowed_kinds: string[] | null
          allowed_source_jobs: string[] | null
          created_at: string | null
          description: string | null
          excluded_kinds: string[] | null
          excluded_source_jobs: string[] | null
          freshness_window_days: number | null
          id: string
          max_items_default: number | null
          name: string
          priority_weights: Json | null
          profile_hint: string | null
          required_entity_refs: string[] | null
          required_project_refs: string[] | null
          token_budget_hint: number | null
          topic_seed: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          allowed_kinds?: string[] | null
          allowed_source_jobs?: string[] | null
          created_at?: string | null
          description?: string | null
          excluded_kinds?: string[] | null
          excluded_source_jobs?: string[] | null
          freshness_window_days?: number | null
          id?: string
          max_items_default?: number | null
          name: string
          priority_weights?: Json | null
          profile_hint?: string | null
          required_entity_refs?: string[] | null
          required_project_refs?: string[] | null
          token_budget_hint?: number | null
          topic_seed?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          allowed_kinds?: string[] | null
          allowed_source_jobs?: string[] | null
          created_at?: string | null
          description?: string | null
          excluded_kinds?: string[] | null
          excluded_source_jobs?: string[] | null
          freshness_window_days?: number | null
          id?: string
          max_items_default?: number | null
          name?: string
          priority_weights?: Json | null
          profile_hint?: string | null
          required_entity_refs?: string[] | null
          required_project_refs?: string[] | null
          token_budget_hint?: number | null
          topic_seed?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      sync_log: {
        Row: {
          completed_at: string | null
          error_message: string | null
          id: string
          metadata: Json | null
          records_failed: number | null
          records_imported: number | null
          records_processed: number | null
          records_skipped: number | null
          source: string
          started_at: string
          status: string
          sync_type: string
          user_id: string | null
        }
        Insert: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          records_failed?: number | null
          records_imported?: number | null
          records_processed?: number | null
          records_skipped?: number | null
          source: string
          started_at?: string
          status?: string
          sync_type?: string
          user_id?: string | null
        }
        Update: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          records_failed?: number | null
          records_imported?: number | null
          records_processed?: number | null
          records_skipped?: number | null
          source?: string
          started_at?: string
          status?: string
          sync_type?: string
          user_id?: string | null
        }
        Relationships: []
      }
      tool_call_log: {
        Row: {
          caller_client: string | null
          id: number
          latency_ms: number | null
          owner_id: string | null
          params_hash: string | null
          success: boolean
          timestamp: string
          tool_name: string
        }
        Insert: {
          caller_client?: string | null
          id?: number
          latency_ms?: number | null
          owner_id?: string | null
          params_hash?: string | null
          success: boolean
          timestamp?: string
          tool_name: string
        }
        Update: {
          caller_client?: string | null
          id?: number
          latency_ms?: number | null
          owner_id?: string | null
          params_hash?: string | null
          success?: boolean
          timestamp?: string
          tool_name?: string
        }
        Relationships: []
      }
      tool_catalog: {
        Row: {
          created_at: string
          tool_name: string
        }
        Insert: {
          created_at?: string
          tool_name: string
        }
        Update: {
          created_at?: string
          tool_name?: string
        }
        Relationships: []
      }
      training_logs: {
        Row: {
          content_hash: string | null
          created_at: string
          duration_s: number | null
          embedded_at: string | null
          embedding: string | null
          embedding_space: string | null
          embedding_status: string
          embedding_version: number
          exercises: Json
          external_id: string | null
          id: string
          metadata: Json | null
          name: string
          notes: string | null
          numeric_value: number | null
          rpe: number | null
          source: string
          tags: string[] | null
          updated_at: string
          user_id: string | null
          volume_kg: number | null
          workout_date: string
          workout_type: string
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          duration_s?: number | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          exercises?: Json
          external_id?: string | null
          id?: string
          metadata?: Json | null
          name: string
          notes?: string | null
          numeric_value?: number | null
          rpe?: number | null
          source?: string
          tags?: string[] | null
          updated_at?: string
          user_id?: string | null
          volume_kg?: number | null
          workout_date: string
          workout_type: string
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          duration_s?: number | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_space?: string | null
          embedding_status?: string
          embedding_version?: number
          exercises?: Json
          external_id?: string | null
          id?: string
          metadata?: Json | null
          name?: string
          notes?: string | null
          numeric_value?: number | null
          rpe?: number | null
          source?: string
          tags?: string[] | null
          updated_at?: string
          user_id?: string | null
          volume_kg?: number | null
          workout_date?: string
          workout_type?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      alexandria_audit_legacy_unowned_rows: { Args: never; Returns: Json }
      alexandria_backfill_legacy_owner: {
        Args: { target_owner_id: string }
        Returns: Json
      }
      backfill_indexing_jobs: {
        Args: {
          p_budget_limit: number
          p_owner_id?: string
          p_source_table?: string
          p_space: string
        }
        Returns: Json
      }
      capture_coverage_snapshot: {
        Args: {
          p_producer?: string
          p_source_kind?: string
          p_target_days?: number
          p_user_id?: string
        }
        Returns: number
      }
      claim_indexing_jobs: {
        Args: {
          p_limit?: number
          p_lock_seconds?: number
          p_owner_id?: string
          p_target_space?: string
        }
        Returns: {
          attempts: number
          content_hash: string
          id: string
          job_type: string
          max_attempts: number
          source_id: string
          source_table: string
          source_version: number
          status: string
          target_dimension: number
          target_space: string
          user_id: string
        }[]
      }
      complete_indexing_job: {
        Args: {
          p_backoff_seconds?: number
          p_error?: string
          p_error_class?: string
          p_job_id: string
          p_status: string
        }
        Returns: Json
      }
      compute_daily_summary: {
        Args: { p_timezone?: string; p_user_id?: string; target_date: string }
        Returns: Json
      }
      compute_source_coverage: {
        Args: { p_user_id?: string; target_days?: number }
        Returns: {
          coverage_status: string
          expected_cadence_hours: number
          gap_hours: number
          last_record_at: string
          notes: string[]
          records_window: number
          source_name: string
          true_zero_possible: boolean
        }[]
      }
      get_coverage_transition_report: {
        Args: { p_days?: number; p_user_id?: string }
        Returns: {
          artifact_freshness_status: string
          current_captured_at: string
          current_status: string
          degradation_streak: number
          expected_cadence_hours: number
          first_degraded_at: string
          gap_hours: number
          lane: string
          last_expected_run_at: string
          last_failure_at: string
          last_success_at: string
          prev_captured_at: string
          prev_status: string
          source_kind: string
          source_name: string
          transition_type: string
          trust_blocking: boolean
        }[]
      }
      get_indexing_lifecycle_status: {
        Args: { p_owner_id?: string }
        Returns: Json
      }
      get_memory_stats: { Args: { p_user_id?: string }; Returns: Json }
      get_tool_activation_report: {
        Args: { p_days?: number; p_owner_id?: string }
        Returns: {
          active_days: number
          avg_latency_ms: number
          call_count: number
          distinct_clients: number
          error_count: number
          last_called_at: string
          p95_latency_ms: number
          status: string
          success_count: number
          success_rate: number
          tool_name: string
        }[]
      }
      list_entities_ranked: {
        Args: { p_entity_type?: string; p_limit?: number; p_user_id?: string }
        Returns: {
          created_at: string
          description: string
          entity_type: string
          id: string
          mention_count: number
          name: string
        }[]
      }
      prune_tool_call_log: {
        Args: { p_retention_days?: number }
        Returns: number
      }
      publish_lane_heartbeat: {
        Args: {
          p_expected_cadence_hours?: number
          p_lane: string
          p_notes?: string[]
          p_source_name: string
          p_success: boolean
        }
        Returns: number
      }
      reconcile_memory_entities: {
        Args: {
          p_entities: Json
          p_memory_id: string
          p_source_version?: number
          p_user_id?: string
        }
        Returns: Json
      }
      search_briefs: {
        Args: {
          filter_date_from?: string
          filter_date_to?: string
          filter_entity_refs?: string[]
          filter_kind?: string
          filter_project_refs?: string[]
          filter_source_job?: string
          filter_topics?: string[]
          match_count?: number
          match_threshold?: number
          p_space?: string
          p_user_id?: string
          query_embedding: string
        }
        Returns: {
          body_markdown: string
          brief_date: string
          created_at: string
          entity_refs: string[]
          id: string
          kind: string
          metadata: Json
          project_refs: string[]
          similarity: number
          source_job: string
          title: string
          topics: string[]
        }[]
      }
      search_health_entries: {
        Args: {
          filter_entry_type?: string
          match_count?: number
          match_threshold?: number
          p_space?: string
          p_user_id?: string
          query_embedding: string
        }
        Returns: {
          duration_s: number
          entry_type: string
          id: string
          numeric_value: number
          similarity: number
          source: string
          tags: string[]
          timestamp: string
          value: Json
        }[]
      }
      search_memories: {
        Args: {
          filter_category?: string
          filter_tags?: string[]
          match_count?: number
          match_threshold?: number
          p_space?: string
          p_user_id?: string
          query_embedding: string
        }
        Returns: {
          category: string
          content: string
          created_at: string
          id: string
          importance: number
          metadata: Json
          similarity: number
          source: string
          tags: string[]
          title: string
        }[]
      }
      search_training_logs: {
        Args: {
          filter_workout_type?: string
          match_count?: number
          match_threshold?: number
          p_space?: string
          p_user_id?: string
          query_embedding: string
        }
        Returns: {
          duration_s: number
          exercises: Json
          id: string
          name: string
          notes: string
          numeric_value: number
          rpe: number
          similarity: number
          tags: string[]
          volume_kg: number
          workout_date: string
          workout_type: string
        }[]
      }
      upsert_brief: {
        Args: {
          p_body_markdown: string
          p_brief_date: string
          p_content_hash?: string
          p_entity_refs?: string[]
          p_kind: string
          p_metadata?: Json
          p_project_refs?: string[]
          p_source_job?: string
          p_source_path?: string
          p_title: string
          p_topics?: string[]
          p_user_id?: string
        }
        Returns: Json
      }
      upsert_health_entry: {
        Args: {
          p_duration_s?: number
          p_entry_type: string
          p_external_id?: string
          p_metadata?: Json
          p_numeric_value?: number
          p_source?: string
          p_tags?: string[]
          p_timestamp: string
          p_user_id?: string
          p_value?: Json
        }
        Returns: Json
      }
      upsert_memory: {
        Args: {
          p_category?: string
          p_content: string
          p_importance?: number
          p_metadata?: Json
          p_people?: string[]
          p_source?: string
          p_tags?: string[]
          p_title?: string
          p_user_id?: string
        }
        Returns: Json
      }
      upsert_profile: {
        Args: { p_key: string; p_owner_id?: string; p_value: Json }
        Returns: Json
      }
      upsert_project: {
        Args: {
          p_conventions?: Json
          p_description?: string
          p_metadata?: Json
          p_name: string
          p_path?: string
          p_stack?: string[]
          p_status?: string
          p_user_id?: string
        }
        Returns: Json
      }
      upsert_training_log: {
        Args: {
          p_duration_s?: number
          p_exercises?: Json
          p_external_id?: string
          p_metadata?: Json
          p_name: string
          p_notes?: string
          p_numeric_value?: number
          p_rpe?: number
          p_source?: string
          p_tags?: string[]
          p_user_id?: string
          p_volume_kg?: number
          p_workout_date: string
          p_workout_type: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

