import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod@3.24.1";
import { supabase } from "../config.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";
import { BriefMatch } from "./briefs.ts";
import { computeProofChainScore } from "./proof_chain.ts";


export interface RoomRecipe {
  id: string;
  name: string;
  description: string;
  profile_hint: string;
  topic_seed: string;
  allowed_kinds: string[];
  allowed_source_jobs: string[];
  excluded_kinds: string[];
  excluded_source_jobs: string[];
  required_project_refs: string[];
  required_entity_refs: string[];
  freshness_window_days: number;
  priority_weights: Record<string, Record<string, number>>;
  max_items_default: number;
  token_budget_hint: number | null;
}

export interface RankedBrief {
  brief: BriefMatch;
  original_similarity: number;
  adjusted_score: number;
  inclusion_reason: string;
}

export function applyRecipeExclusions(
  briefs: BriefMatch[],
  recipe: RoomRecipe,
): { included: BriefMatch[]; excluded: { brief: BriefMatch; reason: string }[] } {
  const included: BriefMatch[] = [];
  const excluded: { brief: BriefMatch; reason: string }[] = [];

  const allowedKinds = new Set(recipe.allowed_kinds || []);
  const allowedSourceJobs = new Set(recipe.allowed_source_jobs || []);
  const excludedKinds = new Set(recipe.excluded_kinds || []);
  const excludedSourceJobs = new Set(recipe.excluded_source_jobs || []);

  for (const brief of briefs) {
    if (excludedKinds.has(brief.kind)) {
      excluded.push({
        brief,
        reason: `Excluded kind: ${brief.kind}`,
      });
      continue;
    }
    if (excludedSourceJobs.has(brief.source_job)) {
      excluded.push({
        brief,
        reason: `Excluded source job: ${brief.source_job}`,
      });
      continue;
    }
    if (allowedKinds.size > 0 && !allowedKinds.has(brief.kind)) {
      excluded.push({
        brief,
        reason: `Kind "${brief.kind}" is not allowed by recipe`,
      });
      continue;
    }
    if (allowedSourceJobs.size > 0 && !allowedSourceJobs.has(brief.source_job)) {
      excluded.push({
        brief,
        reason: `Source job "${brief.source_job}" is not allowed by recipe`,
      });
      continue;
    }
    included.push(brief);
  }

  return { included, excluded };
}

export function applyRecipeWeights(
  briefs: BriefMatch[],
  recipe: RoomRecipe,
): RankedBrief[] {
  const ranked: RankedBrief[] = [];
  const priorityWeights = recipe.priority_weights || {};
  const sourceJobWeights = priorityWeights.source_job || {};
  const kindWeights = priorityWeights.kind || {};

  for (const brief of briefs) {
    const originalSimilarity = brief.similarity;
    let adjustedScore = originalSimilarity;
    const boosts: string[] = [];

    const sjWeight = sourceJobWeights[brief.source_job];
    if (sjWeight !== undefined) {
      adjustedScore += sjWeight;
      const sign = sjWeight >= 0 ? "+" : "";
      boosts.push(`source_job boost (${brief.source_job}: ${sign}${sjWeight})`);
    }

    const kWeight = kindWeights[brief.kind];
    if (kWeight !== undefined) {
      adjustedScore += kWeight;
      const sign = kWeight >= 0 ? "+" : "";
      boosts.push(`kind boost (${brief.kind}: ${sign}${kWeight})`);
    }

    const pcWeights = priorityWeights.proof_chain ?? priorityWeights.proof_chain_score;
    if (pcWeights !== undefined) {
      const pcWeight = pcWeights.weight ?? pcWeights.multiplier;
      if (pcWeight !== undefined) {
        const pcScore = computeProofChainScore(brief).score;
        const boost = pcScore * pcWeight;
        adjustedScore += boost;
        const sign = boost >= 0 ? "+" : "";
        boosts.push(`proof_chain boost (score: ${pcScore}, weight: ${pcWeight}: ${sign}${Number(boost.toFixed(4))})`);
      }
    }


    let inclusionReason = `semantic match (${originalSimilarity})`;
    if (boosts.length > 0) {
      inclusionReason += ` + ${boosts.join(" + ")} = ${Number(adjustedScore.toFixed(4))}`;
    } else {
      inclusionReason += ` = ${originalSimilarity}`;
    }

    ranked.push({
      brief,
      original_similarity: originalSimilarity,
      adjusted_score: adjustedScore,
      inclusion_reason: inclusionReason,
    });
  }

  ranked.sort((a, b) => b.adjusted_score - a.adjusted_score);
  return ranked;
}

export function formatRankedManifest(
  topic: string,
  recipe: RoomRecipe,
  ranked: RankedBrief[],
  excluded: { brief: BriefMatch; reason: string }[],
): string {
  const parts: string[] = [];
  parts.push(`Room Manifest for Recipe: "${recipe.name}"`);
  parts.push(`Topic: "${topic}"`);
  parts.push(`Total Briefs Considered: ${ranked.length + excluded.length}`);
  parts.push("");

  parts.push(`Included Briefs (${ranked.length}):`);
  if (ranked.length === 0) {
    parts.push("- None");
  } else {
    for (const rb of ranked) {
      parts.push(`- ${rb.brief.title} (${rb.brief.brief_date}, ${rb.brief.kind})`);
      parts.push(`  Source: ${rb.brief.source_job} | Adjusted Score: ${rb.adjusted_score.toFixed(2)} | Reason: ${rb.inclusion_reason}`);
    }
  }
  parts.push("");

  parts.push(`Excluded by recipe (${excluded.length}):`);
  if (excluded.length === 0) {
    parts.push("- None");
  } else {
    for (const ex of excluded) {
      parts.push(`- ${ex.brief.title} (${ex.brief.brief_date}, ${ex.brief.kind})`);
      parts.push(`  Source: ${ex.brief.source_job} | Reason: ${ex.reason}`);
    }
  }
  parts.push("");

  parts.push(`Top items:`);
  if (ranked.length === 0) {
    parts.push("- None");
  } else {
    const top5 = ranked.slice(0, 5);
    top5.forEach((rb, index) => {
      parts.push(`${index + 1}. ${rb.brief.title} (Score: ${rb.adjusted_score.toFixed(2)})`);
    });
  }

  return parts.join("\n");
}

export function registerRecipeTools(
  server: McpServer,
  getAuth: () => Promise<{ ownerId: string }> | any,
) {
  server.registerTool(
    "save_room_recipe",
    {
      title: "Save Room Recipe",
      description: "Upsert a saved room recipe by name.",
      inputSchema: {
        name: z.string().describe("Unique name for the recipe"),
        description: z.string().optional().default("").describe("Description of the recipe"),
        profile_hint: z.string().optional().default("").describe("Associated profile key/hint"),
        topic_seed: z.string().optional().default("").describe("Default topic query seed"),
        allowed_kinds: z.array(z.string()).optional().default([]).describe("Allowed brief kinds"),
        allowed_source_jobs: z.array(z.string()).optional().default([]).describe("Allowed source jobs"),
        excluded_kinds: z.array(z.string()).optional().default([]).describe("Excluded brief kinds"),
        excluded_source_jobs: z.array(z.string()).optional().default([]).describe("Excluded source jobs"),
        required_project_refs: z.array(z.string()).optional().default([]).describe("Required project references"),
        required_entity_refs: z.array(z.string()).optional().default([]).describe("Required entity references"),
        freshness_window_days: z.number().optional().default(14).describe("Freshness window in days"),
        priority_weights: z.record(z.record(z.number())).optional().default({}).describe(
          "Priority weights mapping source_job and kind to numbers",
        ),
        max_items_default: z.number().optional().default(15).describe("Default maximum items to return"),
        token_budget_hint: z.number().optional().nullable().default(null).describe("Optional token budget hint"),
      },
    },
    wrapHandler(async (args) => {
      const { data, error } = await supabase
        .from("room_recipes")
        .upsert({
          name: args.name.trim(),
          description: args.description,
          profile_hint: args.profile_hint,
          topic_seed: args.topic_seed,
          allowed_kinds: args.allowed_kinds,
          allowed_source_jobs: args.allowed_source_jobs,
          excluded_kinds: args.excluded_kinds,
          excluded_source_jobs: args.excluded_source_jobs,
          required_project_refs: args.required_project_refs,
          required_entity_refs: args.required_entity_refs,
          freshness_window_days: args.freshness_window_days,
          priority_weights: args.priority_weights,
          max_items_default: args.max_items_default,
          token_budget_hint: args.token_budget_hint,
          updated_at: new Date().toISOString(),
        }, { onConflict: "name" })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to save room recipe: ${error.message}`);
      }

      return `Saved room recipe: "${data.name}" [${data.id}]`;
    }),
  );

  server.registerTool(
    "list_room_recipes",
    {
      title: "List Room Recipes",
      description: "List all room recipes, optionally filtered by profile_hint.",
      inputSchema: {
        profile_hint: z.string().optional().describe("Filter by profile hint"),
      },
    },
    wrapHandler(async ({ profile_hint }) => {
      let query = supabase.from("room_recipes").select("id, name, description, profile_hint").order("name");
      if (profile_hint) {
        query = query.eq("profile_hint", profile_hint.trim());
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list room recipes: ${error.message}`);
      if (!data || data.length === 0) return "No room recipes found.";

      const list = data.map((r: any, idx: number) => {
        return `${idx + 1}. ${r.name}: ${r.description || "(no description)"}${
          r.profile_hint ? ` (profile hint: ${r.profile_hint})` : ""
        }`;
      }).join("\n");

      return `Found ${data.length} recipe(s):\n\n${list}`;
    }),
  );

  server.registerTool(
    "get_room_recipe",
    {
      title: "Get Room Recipe",
      description: "Retrieve a specific room recipe by name.",
      inputSchema: {
        name: z.string().describe("Name of the recipe to get"),
      },
    },
    wrapHandler(async ({ name }) => {
      const { data, error } = await supabase
        .from("room_recipes")
        .select("*")
        .eq("name", name.trim())
        .maybeSingle();

      if (error) throw new Error(`Failed to get room recipe: ${error.message}`);
      if (!data) return `Room recipe "${name}" not found.`;

      return JSON.stringify(data, null, 2);
    }),
  );

  server.registerTool(
    "build_room_manifest_from_recipe",
    {
      title: "Build Room Manifest from Recipe",
      description: "Generates a room manifest using exclusions and weights from a saved recipe.",
      inputSchema: {
        recipe_name: z.string().describe("Unique name of the recipe to load"),
        topic: z.string().optional().describe("Override the default topic query seed"),
      },
    },
    wrapHandler(async ({ recipe_name, topic }) => {
      const { data: recipe, error: recipeError } = await supabase
        .from("room_recipes")
        .select("*")
        .eq("name", recipe_name.trim())
        .maybeSingle();

      if (recipeError) throw new Error(`Recipe lookup failed: ${recipeError.message}`);
      if (!recipe) throw new Error(`Recipe "${recipe_name}" not found.`);

      const finalTopic = topic || recipe.topic_seed;
      if (!finalTopic) {
        throw new Error("Topic must be provided or recipe must have a topic_seed.");
      }

      const qEmb = await getEmbedding(finalTopic);
      const { data: briefs, error: searchError } = await supabase.rpc("search_briefs", {
        query_embedding: qEmb,
        match_threshold: 0.4,
        match_count: recipe.max_items_default ?? 15,
        filter_kind: null,
        filter_source_job: null,
        filter_date_from: null,
        filter_date_to: null,
        filter_topics: null,
        filter_project_refs: recipe.required_project_refs && recipe.required_project_refs.length > 0
          ? recipe.required_project_refs
          : null,
        filter_entity_refs: recipe.required_entity_refs && recipe.required_entity_refs.length > 0
          ? recipe.required_entity_refs
          : null,
      });

      if (searchError) throw new Error(`Brief search failed: ${searchError.message}`);

      const { included, excluded } = applyRecipeExclusions((briefs || []) as BriefMatch[], recipe);
      const ranked = applyRecipeWeights(included, recipe);
      const manifest = formatRankedManifest(finalTopic, recipe, ranked, excluded);

      return manifest;
    }),
  );
}
