import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3.24.1";
import { wrapHandler } from "../helpers.ts";

export interface ProofChainScore {
  score: number;           // 0-100
  source_count: number;
  primary_source_count: number;
  derivative_source_count: number;
  provenance_depth: "primary" | "summary" | "summary_of_summary";
  has_evidence_blocks: boolean;
  has_citations: boolean;
  stale_penalty: boolean;
  single_source_penalty: boolean;
  breakdown: string[];     // human-readable list of scoring decisions
}

export interface BriefLike {
  body_markdown: string;
  kind: string;
  source_job: string;
  brief_date: string;
  metadata?: Record<string, unknown> | null;
}

export function countSources(bodyMarkdown: string): number {
  if (!bodyMarkdown) return 0;

  const urlRegex = /(?:Source:|\[src\]|>\s*|ref:|via\b)?\s*(https?:\/\/[^\s)\]\r\n"'>]+)/gi;
  const uniqueUrls = new Set<string>();

  let tempText = bodyMarkdown;
  tempText = tempText.replace(urlRegex, (_fullMatch, url) => {
    uniqueUrls.add(url.toLowerCase().trim());
    return "";
  });

  let remainingCount = 0;
  const sourcePattern = /Source:/gi;
  const srcPattern = /\[src\]/gi;
  const blockquotePattern = /(?:^|\n)\s*>/g;
  const refPattern = /ref:/gi;
  const viaPattern = /\bvia\b/gi;

  remainingCount += (tempText.match(sourcePattern) || []).length;
  remainingCount += (tempText.match(srcPattern) || []).length;
  remainingCount += (tempText.match(blockquotePattern) || []).length;
  remainingCount += (tempText.match(refPattern) || []).length;
  remainingCount += (tempText.match(viaPattern) || []).length;

  return uniqueUrls.size + remainingCount;
}

export function hasEvidenceBlocks(bodyMarkdown: string): boolean {
  if (!bodyMarkdown) return false;
  const hasBlockquote = /(?:^|\n)\s*>/g.test(bodyMarkdown);
  const hasCodeBlock = /```/.test(bodyMarkdown);
  const hasEvidenceSection = /evidence:/i.test(bodyMarkdown);
  return hasBlockquote || hasCodeBlock || hasEvidenceSection;
}

export function hasCitations(bodyMarkdown: string): boolean {
  if (!bodyMarkdown) return false;
  const pattern1 = /\[\d+\]/.test(bodyMarkdown);
  const pattern2 = /\(\s*source\s*\)/i.test(bodyMarkdown);
  const pattern3 = /\(\s*ref\s*\)/i.test(bodyMarkdown);
  const pattern4 = /\[\^\w+\]/.test(bodyMarkdown);
  return pattern1 || pattern2 || pattern3 || pattern4;
}

export function classifyProvenanceDepth(
  kind: string,
  sourceJob: string,
): "primary" | "summary" | "summary_of_summary" {
  const k = (kind || "").trim().toLowerCase();
  const sj = (sourceJob || "").trim().toLowerCase();

  if (k === "night_research" || sj === "crawler") {
    return "primary";
  }
  if (k === "report" || k === "content_coach") {
    return "summary";
  }
  if (k === "draft_room" || sj === "room-builder" || k === "synapse_diff") {
    return "summary_of_summary";
  }
  return "summary";
}

export function isStale(briefDate: string, referenceDate: Date = new Date()): boolean {
  try {
    const [y, m, d] = briefDate.split("-").map(Number);
    const briefUtc = Date.UTC(y, m - 1, d);
    const refUtc = Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    );
    const diffDays = (refUtc - briefUtc) / (1000 * 60 * 60 * 24);
    return diffDays > 14;
  } catch {
    return true;
  }
}

export function computeProofChainScore(brief: BriefLike): ProofChainScore {
  let score = 50;
  const breakdown: string[] = [];

  const provenance_depth = classifyProvenanceDepth(brief.kind, brief.source_job);
  const source_count = countSources(brief.body_markdown);
  const has_evidence_blocks = hasEvidenceBlocks(brief.body_markdown);
  const has_citations = hasCitations(brief.body_markdown);
  const stale_penalty = isStale(brief.brief_date);

  // Positive boosts:
  if (provenance_depth === "primary") {
    score += 15;
    breakdown.push("primary provenance: +15");
  } else if (provenance_depth === "summary") {
    score += 10;
    breakdown.push("summary provenance: +10");
  } else if (provenance_depth === "summary_of_summary") {
    score -= 15;
    breakdown.push("summary_of_summary provenance: -15");
  }

  const sourceBoostCount = Math.min(source_count, 3);
  if (sourceBoostCount > 0) {
    const boost = sourceBoostCount * 5;
    score += boost;
    breakdown.push(`${source_count} sources found: +${boost}`);
  }

  if (has_evidence_blocks) {
    score += 10;
    breakdown.push("evidence blocks present: +10");
  }

  if (has_citations) {
    score += 5;
    breakdown.push("citations present: +5");
  }

  // Negative penalties:
  if (stale_penalty) {
    score -= 10;
    breakdown.push("stale (>14 days): -10");
  }

  if (source_count === 0) {
    score -= 10;
    breakdown.push("no sources: -10");
  } else if (source_count === 1) {
    score -= 5;
    breakdown.push("single source penalty: -5");
  }

  // Clamp final score to [0, 100]
  score = Math.max(0, Math.min(100, score));
  // Round to integer
  score = Math.round(score);

  let primary_source_count = 0;
  let derivative_source_count = 0;
  if (provenance_depth === "primary") {
    primary_source_count = source_count;
  } else {
    derivative_source_count = source_count;
  }

  return {
    score,
    source_count,
    primary_source_count,
    derivative_source_count,
    provenance_depth,
    has_evidence_blocks,
    has_citations,
    stale_penalty,
    single_source_penalty: source_count === 1,
    breakdown,
  };
}

export function formatScoreBreakdown(score: ProofChainScore): string {
  const parts = [
    `Provenance Score: ${score.score}/100`,
    `Provenance Depth: ${score.provenance_depth}`,
    `Total Sources: ${score.source_count} (Primary: ${score.primary_source_count}, Derivative: ${score.derivative_source_count})`,
    `Evidence Blocks: ${score.has_evidence_blocks ? "Yes" : "No"}`,
    `Citations: ${score.has_citations ? "Yes" : "No"}`,
    "",
    "Breakdown:",
    ...score.breakdown.map((item) => `- ${item}`),
  ];
  return parts.join("\n");
}

export function registerProofChainTools(
  server: McpServer,
  _getAuth: () => Promise<{ ownerId: string }> | any,
) {
  server.registerTool(
    "score_brief_provenance",
    {
      title: "Score Brief Provenance",
      description: "Evaluate the heuristic proof-chain score of a brief to quantify how well it unwinds back to primary evidence.",
      inputSchema: {
        body_markdown: z.string().describe("Full markdown body of the brief"),
        kind: z.string().describe("Brief kind/type (e.g. night_research, report)"),
        source_job: z.string().describe("Source job/producer name"),
        brief_date: z.string().describe("Brief date (YYYY-MM-DD)"),
      },
    },
    wrapHandler(async ({ body_markdown, kind, source_job, brief_date }) => {
      const score = computeProofChainScore({
        body_markdown,
        kind,
        source_job,
        brief_date,
      });
      return formatScoreBreakdown(score);
    }),
  );
}
