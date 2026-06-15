import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";
import type { BriefRow } from "../types.ts";
import {
  briefToText,
  computeBriefContentHash,
  normalizeBriefBody,
  normalizeStringArray,
} from "../lib.ts";

export function registerBriefsTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "capture_brief",
    {
      title: "Capture Brief",
      description:
        "Store a structured markdown brief/report artifact with dedupe and semantic indexing. Use for cron outputs like research packs, content coach notes, synapse diffs, and client watches.",
      inputSchema: {
        source_job: z.string().describe("Source cron/job name or producer"),
        title: z.string().describe("Human-readable brief title"),
        brief_date: z.string().describe("Date YYYY-MM-DD for the brief"),
        kind: z.string().describe(
          "Brief type, e.g. night_research, content_coach, synapse_diff, client_watch",
        ),
        body_markdown: z.string().describe("Full markdown body of the brief"),
        topics: z.array(z.string()).optional().describe("High-level topical tags"),
        project_refs: z.array(z.string()).optional().describe(
          "Project names or slugs referenced by the brief",
        ),
        entity_refs: z.array(z.string()).optional().describe(
          "Entity names referenced by the brief",
        ),
        metadata: z.record(z.any()).optional().describe("Optional structured metadata"),
      },
    },
    wrapHandler(
      async ({
        source_job,
        title,
        brief_date,
        kind,
        body_markdown,
        topics,
        project_refs,
        entity_refs,
        metadata,
      }) => {
        const normalizedBody = normalizeBriefBody(body_markdown);
        const normalizedTopics = normalizeStringArray(topics, { lowercase: true });
        const normalizedProjectRefs = normalizeStringArray(project_refs);
        const normalizedEntityRefs = normalizeStringArray(entity_refs);
        const contentHash = await computeBriefContentHash({
          source_job,
          title,
          brief_date,
          kind,
          body_markdown: normalizedBody,
        });

        const { data: existing, error: existingError } = await supabase
          .from("briefs")
          .select("id, title, brief_date, kind, source_job")
          .eq("content_hash", contentHash)
          .maybeSingle();
        if (existingError) throw new Error("Brief lookup failed");

        if (existing) {
          return `Duplicate brief blocked: \"${existing.title}\" (${existing.kind}) from ${existing.source_job} on ${existing.brief_date}.`;
        }

        const row: Record<string, unknown> = {
          source_job: source_job.trim(),
          title: title.trim(),
          brief_date,
          kind: kind.trim().toLowerCase(),
          body_markdown: normalizedBody,
          topics: normalizedTopics,
          project_refs: normalizedProjectRefs,
          entity_refs: normalizedEntityRefs,
          content_hash: contentHash,
          metadata: metadata || {},
        };

        const embedding = await getEmbedding(briefToText(row));
        row.embedding = embedding;

        const { data, error } = await supabase
          .from("briefs")
          .insert(row)
          .select("id")
          .single();

        if (error || !data) throw new Error("Brief capture failed");

        return `Captured brief: \"${title.trim()}\" (${kind.trim().toLowerCase()}) for ${brief_date} from ${source_job.trim()} [${data.id}]`;
      },
    ),
  );

  server.registerTool(
    "list_briefs",
    {
      title: "List Briefs",
      description:
        "List structured briefs with optional filters by date, source job, kind, topic, project ref, or entity ref.",
      inputSchema: {
        limit: z.number().optional().default(10),
        kind: z.string().optional().describe("Filter by brief kind"),
        source_job: z.string().optional().describe("Filter by source job/producer"),
        from: z.string().optional().describe("Start date YYYY-MM-DD"),
        to: z.string().optional().describe("End date YYYY-MM-DD"),
        topic: z.string().optional().describe("Filter by topic tag"),
        project_ref: z.string().optional().describe("Filter by project reference"),
        entity_ref: z.string().optional().describe("Filter by entity reference"),
      },
    },
    wrapHandler(async ({ limit, kind, source_job, from, to, topic, project_ref, entity_ref }) => {
      let q = supabase
        .from("briefs")
        .select(
          "id, source_job, title, brief_date, kind, topics, project_refs, entity_refs, created_at",
        )
        .order("brief_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);

      if (kind) q = q.eq("kind", kind.trim().toLowerCase());
      if (source_job) q = q.eq("source_job", source_job.trim());
      if (from) q = q.gte("brief_date", from);
      if (to) q = q.lte("brief_date", to);
      if (topic) q = q.contains("topics", [topic.trim().toLowerCase()]);
      if (project_ref) q = q.contains("project_refs", [project_ref.trim()]);
      if (entity_ref) q = q.contains("entity_refs", [entity_ref.trim()]);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) return "No briefs found.";

      const results = (data as BriefRow[]).map((brief, index) => {
        const meta: string[] = [
          `${index + 1}. [${brief.brief_date}] ${brief.title} (${brief.kind})`,
          `   Source: ${brief.source_job}`,
        ];
        if (brief.topics?.length) meta.push(`   Topics: ${brief.topics.join(", ")}`);
        if (brief.project_refs?.length) meta.push(`   Projects: ${brief.project_refs.join(", ")}`);
        if (brief.entity_refs?.length) meta.push(`   Entities: ${brief.entity_refs.join(", ")}`);
        return meta.join("\n");
      });

      return `${data.length} brief(s):\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "search_briefs",
    {
      title: "Search Briefs",
      description:
        "Semantic search across stored briefs. Use to recall what the system already proposed today, recent client intel, or past research angles.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.4),
        kind: z.string().optional().describe("Filter by brief kind"),
        source_job: z.string().optional().describe("Filter by source job/producer"),
        from: z.string().optional().describe("Start date YYYY-MM-DD"),
        to: z.string().optional().describe("End date YYYY-MM-DD"),
        topic: z.string().optional().describe("Filter by topic tag"),
        project_ref: z.string().optional().describe("Filter by project reference"),
        entity_ref: z.string().optional().describe("Filter by entity reference"),
      },
    },
    wrapHandler(async ({ query, limit, threshold, kind, source_job, from, to, topic, project_ref, entity_ref }) => {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_briefs", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_kind: kind ? kind.trim().toLowerCase() : null,
        filter_source_job: source_job ? source_job.trim() : null,
        filter_date_from: from || null,
        filter_date_to: to || null,
        filter_topics: topic ? [topic.trim().toLowerCase()] : null,
        filter_project_refs: project_ref ? [project_ref.trim()] : null,
        filter_entity_refs: entity_ref ? [entity_ref.trim()] : null,
      });

      if (error) throw new Error("Brief search failed");
      if (!data?.length) return `No briefs found matching \"${query}\".`;

      const results = data.map((brief: any, index: number) => {
        const parts = [
          `--- ${index + 1}. ${(brief.similarity * 100).toFixed(1)}% match ---`,
          `Title: ${brief.title}`,
          `Kind: ${brief.kind} | Source: ${brief.source_job} | Date: ${brief.brief_date}`,
        ];
        if (brief.topics?.length) parts.push(`Topics: ${brief.topics.join(", ")}`);
        if (brief.project_refs?.length) parts.push(`Projects: ${brief.project_refs.join(", ")}`);
        if (brief.entity_refs?.length) parts.push(`Entities: ${brief.entity_refs.join(", ")}`);
        parts.push(`\n${brief.body_markdown}`);
        return parts.join("\n");
      });

      return `Found ${data.length} brief(s):\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "build_room_manifest",
    {
      title: "Build Room Manifest",
      description:
        "Generates a structured manifest for a draft room based on topic queries and filters, and optionally persists it.",
      inputSchema: {
        topic: z.string().describe("Topic or query to prepare the room for"),
        kind: z.string().optional().describe("Filter by brief kind"),
        project_ref: z.string().optional().describe("Filter by project reference"),
        entity_ref: z.string().optional().describe("Filter by entity reference"),
        from: z.string().optional().describe("Start date YYYY-MM-DD"),
        to: z.string().optional().describe("End date YYYY-MM-DD"),
        max_items: z.number().optional().default(15).describe("Max briefs to consider"),
        persist: z.boolean().optional().default(false).describe("Save manifest as a draft_room brief"),
      },
    },
    wrapHandler(
      async ({
        topic,
        kind,
        project_ref,
        entity_ref,
        from,
        to,
        max_items,
        persist,
      }) => {
        const qEmb = await getEmbedding(topic);
        const { data: briefs, error } = await supabase.rpc("search_briefs", {
          query_embedding: qEmb,
          match_threshold: 0.4,
          match_count: max_items,
          filter_kind: kind ? kind.trim().toLowerCase() : null,
          filter_source_job: null,
          filter_date_from: from || null,
          filter_date_to: to || null,
          filter_topics: null,
          filter_project_refs: project_ref ? [project_ref.trim()] : null,
          filter_entity_refs: entity_ref ? [entity_ref.trim()] : null,
        });

        if (error) {
          throw new Error(`Brief search failed: ${error.message}`);
        }

        const today = new Date();
        const fresh_inputs: BriefMatch[] = [];
        const stale_inputs: BriefMatch[] = [];

        for (const b of (briefs as BriefMatch[]) || []) {
          if (isBriefFresh(b.brief_date, today)) {
            fresh_inputs.push(b);
          } else {
            stale_inputs.push(b);
          }
        }

        const conflicting_briefs = detectConflicts((briefs as BriefMatch[]) || []);
        const proof_gaps = detectProofGaps((briefs as BriefMatch[]) || [], fresh_inputs.length, stale_inputs.length);
        const readOrderBriefs = computeReadOrder(fresh_inputs, stale_inputs);
        const suggested_read_order = readOrderBriefs.map((b, index) => {
          return `${index + 1}. ${b.title} (${b.brief_date}, ${b.kind})`;
        });

        const next_actions = computeNextActions(
          ((briefs as BriefMatch[]) || []).length,
          fresh_inputs.length,
          conflicting_briefs.length > 0,
        );

        const manifest: RoomManifest = {
          topic,
          total_found: ((briefs as BriefMatch[]) || []).length,
          fresh_inputs,
          stale_inputs,
          conflicting_briefs,
          proof_gaps,
          suggested_read_order,
          next_actions,
        };

        const manifestText = formatRoomManifest(manifest);

        let persistMsg = "";
        if (persist) {
          const todayStr = today.toISOString().split("T")[0];
          const normalizedBody = normalizeBriefBody(manifestText);
          const contentHash = await computeBriefContentHash({
            source_job: "room-builder",
            title: `Draft Room: ${topic}`,
            brief_date: todayStr,
            kind: "draft_room",
            body_markdown: normalizedBody,
          });

          // Check if brief exists
          const { data: existing, error: existingError } = await supabase
            .from("briefs")
            .select("id")
            .eq("content_hash", contentHash)
            .maybeSingle();

          if (existingError) {
            throw new Error(`Brief lookup failed: ${existingError.message}`);
          }

          if (existing) {
            persistMsg = `\n\n[Duplicate brief blocked: manifest already persisted as brief ID ${existing.id}]`;
          } else {
            const row: Record<string, unknown> = {
              source_job: "room-builder",
              title: `Draft Room: ${topic}`,
              brief_date: todayStr,
              kind: "draft_room",
              body_markdown: normalizedBody,
              topics: [],
              project_refs: project_ref ? [project_ref.trim()] : [],
              entity_refs: entity_ref ? [entity_ref.trim()] : [],
              content_hash: contentHash,
              metadata: {},
            };

            const embedding = await getEmbedding(briefToText(row));
            row.embedding = embedding;

            const { data: inserted, error: insertError } = await supabase
              .from("briefs")
              .insert(row)
              .select("id")
              .single();

            if (insertError || !inserted) {
              throw new Error(`Failed to persist draft room brief: ${insertError?.message || "unknown error"}`);
            }
            persistMsg = `\n\n[Persisted draft room brief as ID ${inserted.id}]`;
          }
        }

        return manifestText + persistMsg;
      },
    ),
  );
}

// Interfaces for Room Manifest Tool
export interface BriefMatch {
  id: string;
  title: string;
  brief_date: string;
  kind: string;
  source_job: string;
  body_markdown: string;
  topics?: string[] | null;
  project_refs?: string[] | null;
  entity_refs?: string[] | null;
  similarity: number;
}

export interface ConflictPair {
  brief_a_id: string;
  brief_b_id: string;
  brief_a_title: string;
  brief_b_title: string;
  reason: string;
}

export interface ProofGap {
  gap_type: "thin_evidence" | "outdated" | "no_research_backing";
  description: string;
}

export interface RoomManifest {
  topic: string;
  total_found: number;
  fresh_inputs: BriefMatch[];
  stale_inputs: BriefMatch[];
  conflicting_briefs: ConflictPair[];
  proof_gaps: ProofGap[];
  suggested_read_order: string[];
  next_actions: string[];
}

// Helper functions for Room Manifest
export function isBriefFresh(briefDateStr: string, referenceDate: Date = new Date()): boolean {
  try {
    const [y, m, d] = briefDateStr.split("-").map(Number);
    const briefUtc = Date.UTC(y, m - 1, d);
    const refUtc = Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    );
    const diffDays = (refUtc - briefUtc) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 14;
  } catch {
    return false;
  }
}

const OPPOSING_PAIRS = [
  ["confirmed", "rumored"],
  ["launched", "pending"],
  ["approved", "denied"],
  ["bullish", "bearish"],
];

const IGNORED_KEYWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "been", "have", "has", "had",
  "is", "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "about", "above", "across", "after", "against", "along", "among", "around", "at", "before", "behind", "below", "beneath", "beside",
  "between", "beyond", "but", "by", "concerning", "considering", "despite", "down", "during", "except", "following",
  "in", "inside", "into", "like", "minus", "near", "next", "of", "off", "on", "onto", "opposite", "out", "outside", "over", "past",
  "plus", "regarding", "round", "save", "since", "than", "through", "to", "toward", "towards", "under", "underneath", "unlike",
  "until", "up", "upon", "versus", "via", "without",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "year", "years", "month", "months", "week", "weeks", "day", "days", "hour", "hours", "minute", "minutes", "second", "seconds"
]);

export function extractNumbers(text: string): { keyword: string; value: number }[] {
  const results: { keyword: string; value: number }[] = [];
  const regex = /\b([a-zA-Z]{3,20})\s*[:=]?\s*\$?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const keyword = match[1].toLowerCase();
    if (IGNORED_KEYWORDS.has(keyword)) {
      continue;
    }
    const numStr = match[2].replace(/,/g, "");
    const value = parseFloat(numStr);
    if (!isNaN(value)) {
      results.push({ keyword, value });
    }
  }
  return results;
}

export function hasOpposingWords(text1: string, text2: string): string | null {
  for (const [w1, w2] of OPPOSING_PAIRS) {
    const r1 = new RegExp(`\\b${w1}\\b`, "i");
    const r2 = new RegExp(`\\b${w2}\\b`, "i");
    if ((r1.test(text1) && r2.test(text2)) || (r2.test(text1) && r1.test(text2))) {
      return `Opposing status words: '${w1}' vs '${w2}'`;
    }
  }
  return null;
}

export function detectConflicts(briefs: BriefMatch[]): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  for (let i = 0; i < briefs.length; i++) {
    for (let j = i + 1; j < briefs.length; j++) {
      const b1 = briefs[i];
      const b2 = briefs[j];

      // Check opposing words
      const opposing = hasOpposingWords(b1.body_markdown, b2.body_markdown);
      if (opposing) {
        conflicts.push({
          brief_a_id: b1.id,
          brief_b_id: b2.id,
          brief_a_title: b1.title,
          brief_b_title: b2.title,
          reason: opposing,
        });
        continue;
      }

      // Check number variance
      const nums1 = extractNumbers(b1.body_markdown);
      const nums2 = extractNumbers(b2.body_markdown);

      for (const n1 of nums1) {
        const matching = nums2.find((n2) => n2.keyword === n1.keyword);
        if (matching) {
          const v1 = n1.value;
          const v2 = matching.value;
          const min = Math.min(v1, v2);
          const max = Math.max(v1, v2);
          if (min > 0 && (max - min) / min > 0.2) {
            conflicts.push({
              brief_a_id: b1.id,
              brief_b_id: b2.id,
              brief_a_title: b1.title,
              brief_b_title: b2.title,
              reason: `Number variance for '${n1.keyword}': ${v1} vs ${v2} (>20% variance)`,
            });
            break; // only one conflict per pair
          }
        }
      }
    }
  }
  return conflicts;
}

export function detectProofGaps(
  briefs: BriefMatch[],
  freshCount: number,
  staleCount: number,
): ProofGap[] {
  const gaps: ProofGap[] = [];
  const total = briefs.length;
  if (total === 1) {
    gaps.push({
      gap_type: "thin_evidence",
      description: "Thin evidence: only 1 source found for the topic",
    });
  }
  if (total > 0 && freshCount === 0) {
    gaps.push({
      gap_type: "outdated",
      description: "May be outdated: all inputs are stale (>14 days old)",
    });
  }
  const hasResearchOrCoach = briefs.some(
    (b) => b.kind === "night_research" || b.kind === "content_coach",
  );
  if (total > 0 && !hasResearchOrCoach) {
    gaps.push({
      gap_type: "no_research_backing",
      description: "No research backing: no night_research or content_coach briefs found",
    });
  }
  return gaps;
}

export function computeReadOrder(
  fresh: BriefMatch[],
  stale: BriefMatch[],
): BriefMatch[] {
  // Sort fresh by date descending, then similarity descending
  const sortedFresh = [...fresh].sort((a, b) => {
    const dateCompare = b.brief_date.localeCompare(a.brief_date);
    if (dateCompare !== 0) return dateCompare;
    return b.similarity - a.similarity;
  });

  // Sort stale by similarity descending, then date descending
  const sortedStale = [...stale].sort((a, b) => {
    const simCompare = b.similarity - a.similarity;
    if (simCompare !== 0) return simCompare;
    return b.brief_date.localeCompare(a.brief_date);
  });

  const order: BriefMatch[] = [];
  const processedIds = new Set<string>();

  // 1. Most recent fresh brief first
  if (sortedFresh.length > 0) {
    const firstFresh = sortedFresh[0];
    order.push(firstFresh);
    processedIds.add(firstFresh.id);
  }

  // 2. Then highest-similarity stale brief
  if (sortedStale.length > 0) {
    const firstStale = sortedStale[0];
    order.push(firstStale);
    processedIds.add(firstStale.id);
  }

  // 3. Then remaining by similarity descending
  const remaining = [
    ...sortedFresh.filter((b) => !processedIds.has(b.id)),
    ...sortedStale.filter((b) => !processedIds.has(b.id)),
  ];

  // Sort remaining by similarity descending
  remaining.sort((a, b) => b.similarity - a.similarity);

  order.push(...remaining);
  return order;
}

export function computeNextActions(
  total: number,
  freshCount: number,
  hasConflicts: boolean,
): string[] {
  const actions: string[] = [];
  if (hasConflicts) {
    actions.push("Review conflicting briefs before drafting");
  }
  if (total > 0 && freshCount === 0) {
    actions.push("Refresh research — all inputs are >14 days old");
  }
  if (total <= 1) {
    actions.push("Gather additional sources before drafting");
  }
  if (actions.length === 0) {
    actions.push("Room is ready — proceed to draft");
  }
  return actions;
}

export function formatRoomManifest(manifest: RoomManifest): string {
  const parts: string[] = [];
  parts.push(`Room Manifest for Topic: "${manifest.topic}"`);
  parts.push(`Total Briefs Found: ${manifest.total_found}`);
  parts.push("");

  parts.push(`Fresh Inputs (${manifest.fresh_inputs.length}):`);
  if (manifest.fresh_inputs.length === 0) {
    parts.push("- None");
  } else {
    for (const b of manifest.fresh_inputs) {
      parts.push(`- ${b.title} (${b.brief_date}, ${b.kind}) [${(b.similarity * 100).toFixed(1)}% match]`);
    }
  }
  parts.push("");

  parts.push(`Stale Inputs (${manifest.stale_inputs.length}):`);
  if (manifest.stale_inputs.length === 0) {
    parts.push("- None");
  } else {
    for (const b of manifest.stale_inputs) {
      parts.push(`- ${b.title} (${b.brief_date}, ${b.kind}) [${(b.similarity * 100).toFixed(1)}% match]`);
    }
  }
  parts.push("");

  parts.push(`Potential Conflicts (${manifest.conflicting_briefs.length}):`);
  if (manifest.conflicting_briefs.length === 0) {
    parts.push("- None");
  } else {
    for (const c of manifest.conflicting_briefs) {
      parts.push(`- "${c.brief_a_title}" vs "${c.brief_b_title}": ${c.reason}`);
    }
  }
  parts.push("");

  parts.push(`Proof Gaps (${manifest.proof_gaps.length}):`);
  if (manifest.proof_gaps.length === 0) {
    parts.push("- None");
  } else {
    for (const g of manifest.proof_gaps) {
      parts.push(`- ${g.description}`);
    }
  }
  parts.push("");

  parts.push("Suggested Read Order:");
  if (manifest.suggested_read_order.length === 0) {
    parts.push("- None");
  } else {
    for (const item of manifest.suggested_read_order) {
      parts.push(item);
    }
  }
  parts.push("");

  parts.push("Next Actions:");
  for (const action of manifest.next_actions) {
    parts.push(`- ${action}`);
  }

  return parts.join("\n");
}

