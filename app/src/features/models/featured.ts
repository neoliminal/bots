// Featured-model shortlist for the model picker (spec:
// openspec/specs/model-configuration, "Picker ergonomics — featured shortlist
// plus search").
//
// The shortlist is derived from the live catalog by pattern matching — never
// by a hardcoded id list alone — so catalog drift (new versions, renamed ids)
// keeps producing a sensible list instead of an empty one. It contains:
//   1. models already in use by the user's Bots (from the model-config store),
//   2. the current flagship agentic model per major provider family,
//   3. one recommended cheap utility model,
// deduped and capped at FEATURED_CAP. Capability gating (tools/vision) is
// applied by the picker when rendering, not here.

import type { ModelInfo } from "../../lib/openrouter";
import type { BotModelConfig } from "./store";

/** Maximum number of featured models shown. */
export const FEATURED_CAP = 8;

type Matcher = (model: ModelInfo) => boolean;

/**
 * Variant ids we never feature: routed variants ("model:free", "model:beta"),
 * previews and experimental snapshots.
 */
const VARIANT_EXCLUDE = /:|preview|-exp\b|experimental/i;

/** The model slug without the provider prefix ("anthropic/x" -> "x"). */
function slug(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/**
 * Highest numeric token in the model slug, used to pick the latest version
 * among a family's matches ("claude-sonnet-4.5" -> 4.5, "gpt-4o" -> 4).
 */
function versionScore(id: string): number {
  const nums = slug(id).match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return 0;
  return Math.max(...nums.map(Number));
}

/** Latest-version model among candidates (shorter slug breaks ties). */
function latest(candidates: ModelInfo[]): ModelInfo | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, m) => {
    const diff = versionScore(m.id) - versionScore(best.id);
    if (diff > 0) return m;
    if (diff === 0 && slug(m.id).length < slug(best.id).length) return m;
    return best;
  });
}

function family(provider: string, ...idParts: string[]): Matcher {
  return (m) =>
    m.provider.toLowerCase() === provider &&
    idParts.every((part) => slug(m.id).toLowerCase().includes(part));
}

function not(part: string, matcher: Matcher): Matcher {
  return (m) => matcher(m) && !slug(m.id).toLowerCase().includes(part);
}

/**
 * One flagship pick per family, matched by id pattern so new releases are
 * picked up automatically. Each matcher contributes its latest-version match.
 */
const FLAGSHIP_MATCHERS: Matcher[] = [
  // Anthropic: latest Claude Sonnet and Opus (matches both old
  // "claude-3.5-sonnet" and new "claude-sonnet-4.5" id shapes).
  family("anthropic", "claude", "sonnet"),
  family("anthropic", "claude", "opus"),
  // OpenAI: flagship gpt line — "gpt-5", "gpt-4o", "gpt-4.1"; excludes
  // mini/nano/turbo derivatives.
  (m) =>
    m.provider.toLowerCase() === "openai" &&
    /^gpt-\d+(?:\.\d+)?o?$/.test(slug(m.id).toLowerCase()),
  // Google: latest Gemini Pro and latest Gemini Flash (not the lite tier).
  family("google", "gemini", "pro"),
  not("lite", family("google", "gemini", "flash")),
];

/**
 * Recommended cheap utility model: first family with a match wins, so there
 * is exactly one utility pick.
 */
const UTILITY_MATCHERS: Matcher[] = [
  family("anthropic", "claude", "haiku"),
  (m) =>
    m.provider.toLowerCase() === "openai" &&
    /^gpt-.*-mini$/.test(slug(m.id).toLowerCase()),
  family("google", "gemini", "flash", "lite"),
];

/** Provider popularity order used by the catalog-drift fallback. */
const MAJOR_PROVIDERS = ["anthropic", "openai", "google"] as const;

/**
 * Catalog-drift fallback: if id naming has drifted past every flagship and
 * utility matcher, feature the latest tool-capable model per provider (major
 * providers first, then alphabetical) instead of showing an empty section.
 */
function fallbackFeatured(catalog: ModelInfo[]): ModelInfo[] {
  const pool = catalog.filter((m) => !VARIANT_EXCLUDE.test(m.id));
  const source = pool.length > 0 ? pool : catalog;
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of source) {
    const key = m.provider.toLowerCase();
    const list = byProvider.get(key);
    if (list) list.push(m);
    else byProvider.set(key, [m]);
  }
  const rank = (p: string) => {
    const i = (MAJOR_PROVIDERS as readonly string[]).indexOf(p);
    return i === -1 ? MAJOR_PROVIDERS.length : i;
  };
  const providers = [...byProvider.keys()].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  const picks: ModelInfo[] = [];
  for (const provider of providers) {
    if (picks.length >= FEATURED_CAP) break;
    const candidates = byProvider.get(provider)!;
    const toolCapable = candidates.filter((m) => m.supportsTools);
    const pick = latest(toolCapable.length > 0 ? toolCapable : candidates);
    if (pick) picks.push(pick);
  }
  return picks;
}

/**
 * Every model id referenced by any Bot's config (primary, utility,
 * fallbacks), deduped in first-seen order.
 */
export function inUseModelIds(
  byBot: Record<string, BotModelConfig>,
): string[] {
  const ids = new Set<string>();
  for (const config of Object.values(byBot)) {
    ids.add(config.primaryModelId);
    if (config.utilityModelId) ids.add(config.utilityModelId);
    for (const id of config.fallbackModelIds) ids.add(id);
  }
  return [...ids];
}

/**
 * Build the featured shortlist from the live catalog. In-use models come
 * first (they are the user's own likeliest picks and must not be crowded
 * out), then per-family flagships, then the utility pick; deduped and capped
 * at FEATURED_CAP.
 */
export function selectFeaturedModels(
  catalog: ModelInfo[],
  inUse: readonly string[] = [],
): ModelInfo[] {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const picks: ModelInfo[] = [];
  const seen = new Set<string>();
  const add = (model: ModelInfo | undefined) => {
    if (model && !seen.has(model.id)) {
      seen.add(model.id);
      picks.push(model);
    }
  };

  for (const id of inUse) add(byId.get(id));

  const eligible = catalog.filter((m) => !VARIANT_EXCLUDE.test(m.id));
  for (const matcher of FLAGSHIP_MATCHERS) add(latest(eligible.filter(matcher)));
  for (const matcher of UTILITY_MATCHERS) {
    const pick = latest(eligible.filter(matcher));
    if (pick) {
      add(pick);
      break;
    }
  }

  // Catalog drift guard: never present an empty featured section while the
  // catalog has models — fall back to the latest pick per provider.
  if (picks.length === 0) {
    for (const model of fallbackFeatured(catalog)) add(model);
  }

  return picks.slice(0, FEATURED_CAP);
}
