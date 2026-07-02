import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3.24.1";
import { supabase, AuthContext } from "../config.ts";
import { wrapHandler } from "../helpers.ts";

export interface BriefClaim {
  entity: string;
  metric: string;
  value_numeric: number | null;
  value_text: string;
  unit: string;
  time_scope: string;
  source_snippet: string;
}

export interface ClaimConflict {
  entity: string;
  metric: string;
  claims: {
    brief_id: string;
    brief_title: string;
    brief_date: string;
    source_job: string;
    value_numeric: number | null;
    value_text: string;
    unit: string;
    source_snippet: string;
  }[];
  max_delta_pct: number;
  severity: "high" | "medium" | "low";
  description: string;
}

export const IGNORED_KEYWORDS = new Set([
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
  "year", "years", "month", "months", "week", "weeks", "day", "days", "hour", "hours", "minute", "minutes", "second", "seconds",
  "price", "volume", "total", "market", "data"
]);

export function extractClaims(bodyMarkdown: string, entityRefs: string[] = []): BriefClaim[] {
  const claims: BriefClaim[] = [];
  const lines = bodyMarkdown.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Regex similar to briefs.ts but allows optional sign (+/-)
    const regex = /\b([a-zA-Z]{3,20})\s*[:=]?\s*([+-]?)\s*\$?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
    let match;

    while ((match = regex.exec(trimmedLine)) !== null) {
      const keyword = match[1];
      const metric = keyword.toLowerCase();

      if (IGNORED_KEYWORDS.has(metric)) {
        continue;
      }

      const sign = match[2] || "";
      const numStr = match[3];
      const parsedVal = parseFloat((sign + numStr).replace(/,/g, ""));
      if (isNaN(parsedVal)) {
        continue;
      }

      const matchEndIndex = match.index + match[0].length;
      const after = trimmedLine.slice(matchEndIndex);
      const before = trimmedLine.slice(0, match.index);

      // Determine unit from context
      let unit = "";
      const afterTrimmed = after.trim();

      if (afterTrimmed.startsWith("%")) {
        unit = "%";
      } else if (/^bps\b/i.test(afterTrimmed) || /^basis\s+points\b/i.test(afterTrimmed)) {
        unit = "bps";
      } else if (/^[TBMk]\b/.test(afterTrimmed)) { // Keep case check simple or uppercase
        unit = afterTrimmed[0].toUpperCase();
      } else if (/^(BTC|ETH|USD)\b/i.test(afterTrimmed)) {
        unit = afterTrimmed.match(/^(BTC|ETH|USD)/i)![0].toUpperCase();
      } else {
        const hasDollar = match[0].includes("$") || before.trim().endsWith("$");
        if (hasDollar) {
          unit = "$";
        } else if (trimmedLine.toLowerCase().includes("basis points") || /\bbps\b/i.test(trimmedLine)) {
          unit = "bps";
        } else if (/%/.test(after.slice(0, 5))) {
          unit = "%";
        } else if (/\b(btc|bitcoin)\b/i.test(trimmedLine)) {
          unit = "BTC";
        } else if (/\b(eth|ethereum)\b/i.test(trimmedLine)) {
          unit = "ETH";
        }
      }

      // Determine entity
      let entity = "";

      // 1. Match from entityRefs (case-insensitive in the current line)
      for (const ref of entityRefs) {
        const esc = ref.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
        const refRegex = new RegExp(`\\b${esc}\\b`, "i");
        if (refRegex.test(trimmedLine)) {
          entity = ref.toUpperCase();
          break;
        }
      }

      // 2. Uppercase tokens 2-5 chars near the number that match common ticker pattern
      if (!entity) {
        const uppercaseTokens = trimmedLine.match(/\b[A-Z]{2,5}\b/g) || [];
        let closestToken = "";
        let minDistance = Infinity;
        const numberIndex = match.index;

        let searchStart = 0;
        for (const token of uppercaseTokens) {
          const tokenIndex = trimmedLine.indexOf(token, searchStart);
          if (tokenIndex !== -1) {
            const lowerToken = token.toLowerCase();
            if (lowerToken !== metric && !IGNORED_KEYWORDS.has(lowerToken)) {
              const dist = Math.abs(tokenIndex - numberIndex);
              if (dist < minDistance) {
                minDistance = dist;
                closestToken = token;
              }
            }
            searchStart = tokenIndex + token.length;
          }
        }
        if (closestToken) {
          entity = closestToken;
        }
      }

      // 3. First uppercase token/word on the line
      if (!entity) {
        const firstCapMatches = trimmedLine.match(/\b[A-Z][a-zA-Z]*\b/g) || [];
        for (const capWord of firstCapMatches) {
          const lowerWord = capWord.toLowerCase();
          if (lowerWord !== metric && !IGNORED_KEYWORDS.has(lowerWord)) {
            entity = capWord.toUpperCase();
            break;
          }
        }
      }

      // Skip claim if no entity could be resolved
      if (!entity) {
        continue;
      }

      claims.push({
        entity,
        metric,
        value_numeric: parsedVal,
        value_text: sign + numStr,
        unit,
        time_scope: "",
        source_snippet: trimmedLine.slice(0, 200),
      });
    }
  }

  return claims;
}

export function detectClaimConflicts(
  claims: {
    brief_id: string;
    brief_title: string;
    brief_date: string;
    source_job: string;
    claim: BriefClaim;
  }[]
): ClaimConflict[] {
  const groups: Record<string, typeof claims> = {};
  for (const c of claims) {
    const key = `${c.claim.entity.toLowerCase()}::${c.claim.metric.toLowerCase()}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(c);
  }

  const conflicts: ClaimConflict[] = [];

  for (const [_, groupClaims] of Object.entries(groups)) {
    if (groupClaims.length < 2) continue;

    const numericClaims = groupClaims.filter((c) => c.claim.value_numeric !== null);
    if (numericClaims.length < 2) continue;

    let hasConflict = false;
    for (let i = 0; i < numericClaims.length; i++) {
      for (let j = i + 1; j < numericClaims.length; j++) {
        if (Math.abs(numericClaims[i].claim.value_numeric! - numericClaims[j].claim.value_numeric!) > 0.01) {
          hasConflict = true;
          break;
        }
      }
      if (hasConflict) break;
    }

    if (!hasConflict) continue;

    const values = numericClaims.map((c) => c.claim.value_numeric!);
    const min = Math.min(...values);
    const max = Math.max(...values);

    let max_delta_pct = 0;
    if (min > 0) {
      max_delta_pct = ((max - min) / min) * 100;
    } else if (min < 0) {
      max_delta_pct = ((max - min) / Math.abs(min)) * 100;
    } else {
      max_delta_pct = max !== 0 ? max * 100 : 0;
    }

    if (max_delta_pct < 20) continue;

    let severity: "high" | "medium" | "low" = "low";
    if (max_delta_pct >= 50) {
      severity = "high";
    } else if (max_delta_pct >= 30) {
      severity = "medium";
    }

    const entity = numericClaims[0].claim.entity;
    const metric = numericClaims[0].claim.metric;

    const valStrings = numericClaims.map((c) => {
      const val = c.claim.value_numeric;
      const unit = c.claim.unit || "";
      return `${val}${unit}`;
    });
    const valsJoined = valStrings.join(" vs ");
    const roundedDelta = Math.round(max_delta_pct);
    const description = `${entity} ${metric}: ${numericClaims.length} conflicting values (${valsJoined}, ${roundedDelta}% delta)`;

    conflicts.push({
      entity,
      metric,
      claims: numericClaims.map((c) => ({
        brief_id: c.brief_id,
        brief_title: c.brief_title,
        brief_date: c.brief_date,
        source_job: c.source_job,
        value_numeric: c.claim.value_numeric,
        value_text: c.claim.value_text,
        unit: c.claim.unit,
        source_snippet: c.claim.source_snippet,
      })),
      max_delta_pct,
      severity,
      description,
    });
  }

  conflicts.sort((a, b) => b.max_delta_pct - a.max_delta_pct);
  return conflicts;
}

export function formatConflicts(conflicts: ClaimConflict[]): string {
  if (conflicts.length === 0) {
    return "No conflicting claims detected.";
  }

  return conflicts
    .map((c) => {
      const header = `${c.entity.toUpperCase()} - ${c.metric} [Severity: ${c.severity.toUpperCase()}]`;
      const desc = `Description: ${c.description}`;
      const claimsStr = c.claims
        .map((claim) => {
          const valStr = claim.value_numeric !== null ? `${claim.value_numeric}${claim.unit}` : claim.value_text;
          return `- ${claim.brief_title} (${claim.brief_date}): ${valStr} | Snippet: "${claim.source_snippet}"`;
        })
        .join("\n");
      return `${header}\n${desc}\n${claimsStr}`;
    })
    .join("\n\n");
}

export function registerConflictRadarTools(server: McpServer, _getAuth: () => AuthContext | undefined) {
  // Tool 1: extract_brief_claims
  server.registerTool(
    "extract_brief_claims",
    {
      title: "Extract Brief Claims",
      description: "Extract structured claims from brief markdown",
      inputSchema: {
        body_markdown: z.string().describe("The markdown body of the brief to extract claims from"),
        entity_refs: z.array(z.string()).optional().default([]).describe("Optional array of known entities to resolve"),
      },
    },
    wrapHandler(async ({ body_markdown, entity_refs }) => {
      const claims = extractClaims(body_markdown, entity_refs || []);
      return JSON.stringify(claims, null, 2);
    })
  );

  // Tool 2: scan_brief_conflicts
  server.registerTool(
    "scan_brief_conflicts",
    {
      title: "Scan Brief Conflicts",
      description: "Scan recent briefs or specific briefs for contradictory numeric claims",
      inputSchema: {
        brief_ids: z.array(z.string()).optional().describe("Optional array of specific brief IDs to scan"),
        recent_days: z.number().optional().default(14).describe("Number of recent days of briefs to scan if brief_ids is not provided"),
      },
    },
    wrapHandler(async ({ brief_ids, recent_days }) => {
      let briefs: any[] = [];

      if (brief_ids && brief_ids.length > 0) {
        const { data, error } = await supabase
          .from("briefs")
          .select("id, title, brief_date, kind, source_job, body_markdown, entity_refs")
          .in("id", brief_ids);
        if (error) throw new Error(`Failed to fetch briefs: ${error.message}`);
        briefs = data || [];
      } else {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - (recent_days ?? 14));
        const cutoffStr = cutoffDate.toISOString().split("T")[0];

        const { data, error } = await supabase
          .from("briefs")
          .select("id, title, brief_date, kind, source_job, body_markdown, entity_refs")
          .gte("brief_date", cutoffStr)
          .order("brief_date", { ascending: false })
          .limit(50);
        if (error) throw new Error(`Failed to fetch recent briefs: ${error.message}`);
        briefs = data || [];
      }

      const claims: {
        brief_id: string;
        brief_title: string;
        brief_date: string;
        source_job: string;
        claim: BriefClaim;
      }[] = [];

      for (const brief of briefs) {
        const extracted = extractClaims(brief.body_markdown, brief.entity_refs || []);
        for (const claim of extracted) {
          claims.push({
            brief_id: brief.id,
            brief_title: brief.title,
            brief_date: brief.brief_date,
            source_job: brief.source_job,
            claim,
          });
        }
      }

      const conflicts = detectClaimConflicts(claims);
      return formatConflicts(conflicts);
    })
  );
}
