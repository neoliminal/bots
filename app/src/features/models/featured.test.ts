import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../lib/openrouter";
import { FEATURED_CAP, inUseModelIds, selectFeaturedModels } from "./featured";

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  const provider = id.split("/")[0]!;
  return {
    id,
    name: id.split("/")[1] ?? id,
    provider,
    contextLength: 128000,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    supportsTools: true,
    supportsVision: true,
    ...overrides,
  };
}

const catalog: ModelInfo[] = [
  model("anthropic/claude-sonnet-4.5"),
  model("anthropic/claude-3.5-sonnet"),
  model("anthropic/claude-opus-4.1"),
  model("anthropic/claude-haiku-4.5"),
  model("openai/gpt-5"),
  model("openai/gpt-4o"),
  model("openai/gpt-5-mini"),
  model("google/gemini-2.5-pro"),
  model("google/gemini-2.5-flash"),
  model("google/gemini-2.0-flash"),
  model("google/gemini-2.5-flash-lite"),
  model("mistralai/mistral-large-2411"),
  model("some/text-only-model", { supportsTools: false, supportsVision: false }),
  model("anthropic/claude-sonnet-4.5:free"),
];

describe("selectFeaturedModels", () => {
  it("features the latest flagship per family, matched by pattern not exact id", () => {
    const ids = selectFeaturedModels(catalog).map((m) => m.id);

    // Latest of each family wins; older versions are left out.
    expect(ids).toContain("anthropic/claude-sonnet-4.5");
    expect(ids).not.toContain("anthropic/claude-3.5-sonnet");
    expect(ids).toContain("anthropic/claude-opus-4.1");
    expect(ids).toContain("openai/gpt-5");
    expect(ids).not.toContain("openai/gpt-4o");
    expect(ids).toContain("google/gemini-2.5-pro");
    expect(ids).toContain("google/gemini-2.5-flash");
    expect(ids).not.toContain("google/gemini-2.0-flash");
  });

  it("still finds flagships when the catalog drifts to new version ids", () => {
    const drifted = [
      model("anthropic/claude-sonnet-9.1"),
      model("openai/gpt-7"),
      model("google/gemini-4.0-pro"),
    ];
    const ids = selectFeaturedModels(drifted).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "anthropic/claude-sonnet-9.1",
        "openai/gpt-7",
        "google/gemini-4.0-pro",
      ]),
    );
  });

  it("includes exactly one cheap utility pick, preferring haiku", () => {
    const ids = selectFeaturedModels(catalog).map((m) => m.id);
    expect(ids).toContain("anthropic/claude-haiku-4.5");
    // The mini derivative is not featured as flagship nor as a second utility.
    expect(ids).not.toContain("openai/gpt-5-mini");
  });

  it("falls back to another utility family when haiku is absent", () => {
    const noHaiku = catalog.filter((m) => !m.id.includes("haiku"));
    const ids = selectFeaturedModels(noHaiku).map((m) => m.id);
    expect(ids).toContain("openai/gpt-5-mini");
  });

  it("does not feature :free/preview variant ids", () => {
    const ids = selectFeaturedModels(catalog).map((m) => m.id);
    expect(ids).not.toContain("anthropic/claude-sonnet-4.5:free");
  });

  it("includes models in use by other Bots, ignoring ids missing from the catalog", () => {
    const ids = selectFeaturedModels(catalog, [
      "mistralai/mistral-large-2411",
      "gone/removed-model",
    ]).map((m) => m.id);
    expect(ids).toContain("mistralai/mistral-large-2411");
    expect(ids).not.toContain("gone/removed-model");
  });

  it("dedupes when an in-use model is also a flagship", () => {
    const ids = selectFeaturedModels(catalog, ["anthropic/claude-sonnet-4.5"]).map(
      (m) => m.id,
    );
    expect(ids.filter((id) => id === "anthropic/claude-sonnet-4.5")).toHaveLength(1);
  });

  it("caps the shortlist and keeps in-use models over overflow flagships", () => {
    const manyInUse = Array.from({ length: 12 }, (_, i) => model(`custom/model-${i}`));
    const ids = selectFeaturedModels(
      [...catalog, ...manyInUse],
      manyInUse.map((m) => m.id),
    ).map((m) => m.id);
    expect(ids).toHaveLength(FEATURED_CAP);
    expect(ids[0]).toBe("custom/model-0");
  });

  it("stays within the cap on the plain catalog", () => {
    expect(selectFeaturedModels(catalog).length).toBeLessThanOrEqual(FEATURED_CAP);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(selectFeaturedModels([], ["anthropic/claude-sonnet-4.5"])).toEqual([]);
  });

  it("never returns an empty featured list when catalog naming drifts past every matcher", () => {
    // No id matches any flagship/utility pattern: renamed families, unknown
    // providers. The fallback picks the latest tool-capable model per
    // provider, major providers first.
    const drifted = [
      model("mistralai/mistral-large-2411"),
      model("mistralai/mistral-medium-3"),
      model("anthropic/nova-2"),
      model("anthropic/nova-1"),
      model("cohere/command-r7"),
      model("acme/untooled-only", { supportsTools: false }),
    ];
    const picks = selectFeaturedModels(drifted);
    expect(picks.length).toBeGreaterThan(0);
    const ids = picks.map((m) => m.id);
    // Latest per provider, anthropic (major) ranked before the others.
    expect(ids[0]).toBe("anthropic/nova-2");
    expect(ids).toContain("mistralai/mistral-large-2411");
    expect(ids).not.toContain("anthropic/nova-1");
    expect(ids).toContain("cohere/command-r7");
    // Tool-less providers still get their best available model.
    expect(ids).toContain("acme/untooled-only");
    expect(picks.length).toBeLessThanOrEqual(FEATURED_CAP);
  });

  it("prefers tool-capable models within a provider in the drift fallback", () => {
    const drifted = [
      model("acme/frontier-9", { supportsTools: false }),
      model("acme/frontier-8"),
    ];
    const ids = selectFeaturedModels(drifted).map((m) => m.id);
    expect(ids).toEqual(["acme/frontier-8"]);
  });

  it("skips the drift fallback when in-use models already fill the featured list", () => {
    const drifted = [model("acme/frontier-9"), model("acme/frontier-8")];
    const ids = selectFeaturedModels(drifted, ["acme/frontier-8"]).map((m) => m.id);
    // In-use pick keeps featured non-empty; no extra fallback entries added.
    expect(ids).toEqual(["acme/frontier-8"]);
  });
});

describe("inUseModelIds", () => {
  it("collects primary, utility, and fallback ids across bots, deduped", () => {
    const ids = inUseModelIds({
      bot1: {
        primaryModelId: "anthropic/claude-sonnet-4.5",
        utilityModelId: "anthropic/claude-haiku-4.5",
        fallbackModelIds: ["openai/gpt-5"],
      },
      bot2: {
        primaryModelId: "openai/gpt-5",
        fallbackModelIds: [],
      },
    });
    expect(ids).toEqual([
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5",
    ]);
  });

  it("returns an empty list when no bots have configs", () => {
    expect(inUseModelIds({})).toEqual([]);
  });
});
