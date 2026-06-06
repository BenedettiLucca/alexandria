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
}
