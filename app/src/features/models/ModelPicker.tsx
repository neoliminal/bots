// Model picker fed by the OpenRouter catalog (spec:
// openspec/specs/model-configuration, "OpenRouter as the initial model
// catalog" + "Picker ergonomics — featured shortlist plus search").
//
// Opens with a curated Featured shortlist and the full catalog collapsed
// behind a "Browse all N models" expander. Typing in the (autofocused) search
// box filters the ENTIRE catalog locally and instantly — matching name, id,
// and provider — with featured matches ranked first, then the rest
// alphabetically. Capability gating renders incompatible models disabled with
// the reason everywhere (featured, browse, and search results).

import { useEffect, useMemo, useState } from "react";
import { listModels } from "../../lib/openrouter";
import type { ModelInfo } from "../../lib/openrouter";
import { inUseModelIds, selectFeaturedModels } from "./featured";
import { useModelConfigStore } from "./store";

export interface ModelPickerProps {
  /** Currently selected model id, if any. */
  selectedModelId?: string;
  onSelect: (model: ModelInfo) => void;
  /** Require tool/function calling (platform minimum for Bot reasoning). */
  requireTools?: boolean;
  /** Require vision (needed for computer-use work). */
  requireVision?: boolean;
  /**
   * Model ids already in use by the user's other Bots; featured alongside the
   * flagship picks. Defaults to every id referenced in the model-config store.
   */
  inUseModelIds?: string[];
  /**
   * Autofocus the search box on mount (default true). Disable when the
   * picker is embedded in a form where another field owns initial focus.
   */
  autoFocusSearch?: boolean;
}

/** Why a model cannot be selected, or null when it is compatible. */
export function incompatibilityReason(
  model: ModelInfo,
  opts: { requireTools?: boolean; requireVision?: boolean },
): string | null {
  if (opts.requireTools && !model.supportsTools) {
    return "No tool calling — Bots require tool support";
  }
  if (opts.requireVision && !model.supportsVision) {
    return "No vision — screen-based work requires a vision-capable model";
  }
  return null;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

function formatPerMillion(perToken: number): string {
  return `$${(perToken * 1_000_000).toFixed(2)}`;
}

function byName(a: ModelInfo, b: ModelInfo): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; models: ModelInfo[] };

interface ModelRowProps {
  model: ModelInfo;
  selected: boolean;
  reason: string | null;
  onSelect: (model: ModelInfo) => void;
}

function ModelRow({ model, selected, reason, onSelect }: ModelRowProps) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={reason !== null}
        onClick={() => onSelect(model)}
        className={`flex w-full flex-col gap-1 px-3 py-2 text-left ${
          reason !== null
            ? "cursor-not-allowed opacity-50"
            : selected
              ? "bg-[#007aff]/10 dark:bg-sky-950/40"
              : "hover:bg-[#f2f2f7] dark:hover:bg-neutral-800"
        }`}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{model.name}</span>
          <span className="text-xs text-neutral-500">{model.provider}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-neutral-500">
          <span>{formatContext(model.contextLength)}</span>
          <span>
            {formatPerMillion(model.pricing.prompt)} in /{" "}
            {formatPerMillion(model.pricing.completion)} out per 1M
          </span>
          {model.supportsTools && (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">
              tools
            </span>
          )}
          {model.supportsVision && (
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-800">
              vision
            </span>
          )}
        </span>
        {reason !== null && <span className="text-xs text-amber-700">{reason}</span>}
      </button>
    </li>
  );
}

export function ModelPicker({
  selectedModelId,
  onSelect,
  requireTools = false,
  requireVision = false,
  inUseModelIds: inUseProp,
  autoFocusSearch = true,
}: ModelPickerProps) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [browsingAll, setBrowsingAll] = useState(false);

  const byBot = useModelConfigStore((s) => s.byBot);
  const inUse = useMemo(
    () => inUseProp ?? inUseModelIds(byBot),
    [inUseProp, byBot],
  );

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    listModels()
      .then((models) => {
        if (!cancelled) setLoad({ status: "ready", models });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load models",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const models = load.status === "ready" ? load.models : [];

  const featured = useMemo(
    () => selectFeaturedModels(models, inUse),
    [models, inUse],
  );

  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";

  // Search filters the ENTIRE catalog: featured matches first (in featured
  // order), then the remaining matches alphabetically.
  const results = useMemo(() => {
    if (!searching) return [];
    const matches = (m: ModelInfo) =>
      m.name.toLowerCase().includes(trimmedQuery) ||
      m.id.toLowerCase().includes(trimmedQuery) ||
      m.provider.toLowerCase().includes(trimmedQuery);
    const featuredIds = new Set(featured.map((m) => m.id));
    const featuredMatches = featured.filter(matches);
    const rest = models.filter((m) => !featuredIds.has(m.id) && matches(m)).sort(byName);
    return [...featuredMatches, ...rest];
  }, [searching, trimmedQuery, models, featured]);

  const allSorted = useMemo(() => [...models].sort(byName), [models]);

  const renderRows = (list: ModelInfo[], label: string) => (
    <ul role="listbox" aria-label={label} className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
      {list.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          selected={model.id === selectedModelId}
          reason={incompatibilityReason(model, { requireTools, requireVision })}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        role="searchbox"
        aria-label="Search models"
        placeholder="Search models by name, id, or provider..."
        autoFocus={autoFocusSearch}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded-full bg-[#eeeef0] px-3.5 py-2 text-sm outline-none placeholder:text-neutral-400 focus:bg-[#e9e9eb] dark:bg-neutral-800 dark:text-neutral-100 dark:focus:bg-neutral-700"
      />

      {load.status === "loading" && (
        <p role="status" className="py-4 text-sm text-neutral-500">
          Loading models…
        </p>
      )}

      {load.status === "error" && (
        <p role="alert" className="py-4 text-sm text-red-600">
          Failed to load models: {load.message}
        </p>
      )}

      {load.status === "ready" && searching && (
        <div className="flex flex-col">
          {results.length === 0 ? (
            <p className="py-4 text-sm text-neutral-500">No models match “{query}”.</p>
          ) : (
            renderRows(results, "Search results")
          )}
        </div>
      )}

      {load.status === "ready" && !searching && (
        <div className="flex flex-col gap-2">
          {featured.length > 0 && (
            <section aria-label="Featured models">
              <h3 className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Featured
              </h3>
              {renderRows(featured, "Featured models")}
            </section>
          )}

          <button
            type="button"
            aria-expanded={browsingAll}
            onClick={() => setBrowsingAll((v) => !v)}
            className="rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm font-medium text-neutral-600 hover:bg-[#f2f2f7] dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {browsingAll
              ? "Hide full catalog"
              : `Browse all ${models.length} models`}
          </button>

          {browsingAll && (
            <section aria-label="All models">
              <h3 className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                All models
              </h3>
              {renderRows(allSorted, "All models")}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
