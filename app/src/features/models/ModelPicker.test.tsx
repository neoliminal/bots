import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../lib/openrouter";
import { ModelPicker, incompatibilityReason } from "./ModelPicker";
import { DEFAULT_MODEL_CONFIG, useModelConfigStore } from "./store";

vi.mock("../../lib/openrouter", () => ({
  listModels: vi.fn(),
}));

import { listModels } from "../../lib/openrouter";
const listModelsMock = vi.mocked(listModels);

function model(id: string, name: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    provider: id.split("/")[0]!,
    contextLength: 200000,
    pricing: { prompt: 0.000003, completion: 0.000015 },
    supportsTools: true,
    supportsVision: true,
    ...overrides,
  };
}

// Small stand-in catalog: two featured flagships, one featured utility, and
// two long-tail models that only surface via browse-all or search.
const models: ModelInfo[] = [
  model("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"),
  model("openai/gpt-5", "GPT-5", {
    pricing: { prompt: 0.00000125, completion: 0.00001 },
  }),
  model("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", {
    contextLength: 200000,
    pricing: { prompt: 0.000001, completion: 0.000005 },
  }),
  model("mistralai/mistral-large-2411", "Mistral Large"),
  model("some/text-only-model", "Text Only", {
    contextLength: 8192,
    pricing: { prompt: 0.0000001, completion: 0.0000002 },
    supportsTools: false,
    supportsVision: false,
  }),
];

beforeEach(() => {
  listModelsMock.mockReset();
  useModelConfigStore.setState({ byBot: {}, defaultConfig: DEFAULT_MODEL_CONFIG });
});

describe("ModelPicker", () => {
  it("shows a loading state, then the featured shortlist with details and badges", async () => {
    listModelsMock.mockResolvedValue(models);
    render(<ModelPicker onSelect={() => {}} />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    expect(await screen.findByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.getByText("Featured")).toBeInTheDocument();
    expect(screen.getAllByText("anthropic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("200K ctx").length).toBeGreaterThan(0);
    expect(screen.getByText(/\$3\.00 in \/ \$15\.00 out per 1M/)).toBeInTheDocument();
    expect(screen.getAllByText("tools").length).toBeGreaterThan(0);
    expect(screen.getAllByText("vision").length).toBeGreaterThan(0);

    // Featured only: flagships and the utility pick — not the long tail.
    expect(screen.getByText("GPT-5")).toBeInTheDocument();
    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.queryByText("Mistral Large")).not.toBeInTheDocument();
    expect(screen.queryByText("Text Only")).not.toBeInTheDocument();
  });

  it("autofocuses the search box", async () => {
    listModelsMock.mockResolvedValue(models);
    render(<ModelPicker onSelect={() => {}} />);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    await screen.findByText("Claude Sonnet 4.5");
  });

  it("leaves focus alone with autoFocusSearch={false}", async () => {
    listModelsMock.mockResolvedValue(models);
    render(<ModelPicker onSelect={() => {}} autoFocusSearch={false} />);
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
    await screen.findByText("Claude Sonnet 4.5");
  });

  it("expands and collapses the full catalog via the browse control", async () => {
    listModelsMock.mockResolvedValue(models);
    const user = userEvent.setup();
    render(<ModelPicker onSelect={() => {}} />);
    await screen.findByText("Claude Sonnet 4.5");

    const browse = screen.getByRole("button", { name: /browse all 5 models/i });
    expect(browse).toHaveAttribute("aria-expanded", "false");

    await user.click(browse);
    expect(browse).toHaveAttribute("aria-expanded", "true");
    const all = within(screen.getByRole("listbox", { name: "All models" }));
    expect(all.getByText("Mistral Large")).toBeInTheDocument();
    expect(all.getByText("Text Only")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /hide full catalog/i }));
    expect(screen.queryByRole("listbox", { name: "All models" })).not.toBeInTheDocument();
  });

  it("features models in use by other Bots (from the config store)", async () => {
    listModelsMock.mockResolvedValue(models);
    useModelConfigStore.setState({
      byBot: {
        bot1: {
          primaryModelId: "mistralai/mistral-large-2411",
          fallbackModelIds: [],
        },
      },
    });
    render(<ModelPicker onSelect={() => {}} />);

    const featured = within(
      await screen.findByRole("listbox", { name: "Featured models" }),
    );
    expect(featured.getByText("Mistral Large")).toBeInTheDocument();
  });

  it("accepts in-use model ids as a prop override", async () => {
    listModelsMock.mockResolvedValue(models);
    render(
      <ModelPicker onSelect={() => {}} inUseModelIds={["some/text-only-model"]} />,
    );
    const featured = within(
      await screen.findByRole("listbox", { name: "Featured models" }),
    );
    expect(featured.getByText("Text Only")).toBeInTheDocument();
  });

  it("search filters the entire catalog by provider, replacing the featured layout", async () => {
    listModelsMock.mockResolvedValue(models);
    const user = userEvent.setup();
    render(<ModelPicker onSelect={() => {}} />);
    await screen.findByText("Claude Sonnet 4.5");

    await user.type(screen.getByRole("searchbox"), "mistralai");
    // Non-featured model found across the whole catalog.
    expect(screen.getByText("Mistral Large")).toBeInTheDocument();
    expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
    // Featured layout is replaced by results.
    expect(screen.queryByText("Featured")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /browse all/i })).not.toBeInTheDocument();
  });

  it("search matches fragments of the model name and id", async () => {
    listModelsMock.mockResolvedValue(models);
    const user = userEvent.setup();
    render(<ModelPicker onSelect={() => {}} />);
    await screen.findByText("Claude Sonnet 4.5");

    const box = screen.getByRole("searchbox");
    await user.type(box, "haiku");
    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.queryByText("GPT-5")).not.toBeInTheDocument();

    await user.clear(box);
    await user.type(box, "text-only");
    expect(screen.getByText("Text Only")).toBeInTheDocument();
    expect(screen.queryByText("Claude Haiku 4.5")).not.toBeInTheDocument();
  });

  it("ranks featured matches before the rest of the catalog", async () => {
    listModelsMock.mockResolvedValue(models);
    const user = userEvent.setup();
    render(<ModelPicker onSelect={() => {}} />);
    await screen.findByText("Claude Sonnet 4.5");

    // "l" matches featured (Claude Sonnet/Haiku) and non-featured (Mistral
    // Large "mistralai", Text Only "text-only-model").
    await user.type(screen.getByRole("searchbox"), "l");
    const texts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    const sonnetIdx = texts.findIndex((t) => t.includes("Claude Sonnet 4.5"));
    const mistralIdx = texts.findIndex((t) => t.includes("Mistral Large"));
    expect(sonnetIdx).toBeGreaterThanOrEqual(0);
    expect(mistralIdx).toBeGreaterThanOrEqual(0);
    expect(sonnetIdx).toBeLessThan(mistralIdx);
  });

  it("shows a no-match message for queries with no results", async () => {
    listModelsMock.mockResolvedValue(models);
    const user = userEvent.setup();
    render(<ModelPicker onSelect={() => {}} />);
    await screen.findByText("Claude Sonnet 4.5");

    await user.type(screen.getByRole("searchbox"), "zzzzz");
    expect(screen.getByText(/no models match/i)).toBeInTheDocument();
  });

  it("keeps incompatible models disabled with the reason in featured and search results", async () => {
    listModelsMock.mockResolvedValue(models);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        onSelect={onSelect}
        requireTools
        inUseModelIds={["some/text-only-model"]}
      />,
    );

    // Featured: the in-use text-only model is listed but unselectable.
    const featuredOption = (await screen.findByText("Text Only")).closest("button")!;
    expect(featuredOption).toBeDisabled();
    expect(
      screen.getByText(/no tool calling — bots require tool support/i),
    ).toBeInTheDocument();
    await user.click(featuredOption);
    expect(onSelect).not.toHaveBeenCalled();

    // Search results: still disabled with the reason.
    await user.type(screen.getByRole("searchbox"), "text only");
    const resultOption = screen.getByText("Text Only").closest("button")!;
    expect(resultOption).toBeDisabled();
    expect(
      screen.getByText(/no tool calling — bots require tool support/i),
    ).toBeInTheDocument();

    // A compatible model is selectable and fires the callback with the model.
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "sonnet");
    await user.click(screen.getByText("Claude Sonnet 4.5").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith(models[0]);
  });

  it("flags vision-incompatible models when requireVision", async () => {
    listModelsMock.mockResolvedValue(models);
    render(
      <ModelPicker
        onSelect={() => {}}
        requireVision
        inUseModelIds={["some/text-only-model"]}
      />,
    );

    const incompatible = (await screen.findByText("Text Only")).closest("button")!;
    expect(incompatible).toBeDisabled();
    expect(
      screen.getByText(/screen-based work requires a vision-capable model/i),
    ).toBeInTheDocument();
  });

  it("shows an error state when loading fails", async () => {
    listModelsMock.mockRejectedValue(new Error("network down"));
    render(<ModelPicker onSelect={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/network down/),
    );
  });
});

describe("incompatibilityReason", () => {
  it("returns null for compatible models and a reason otherwise", () => {
    const capable = models[0]!;
    const textOnly = models[4]!;
    expect(incompatibilityReason(capable, { requireTools: true, requireVision: true })).toBeNull();
    expect(incompatibilityReason(textOnly, { requireTools: true })).toMatch(/tool/i);
    expect(incompatibilityReason(textOnly, { requireVision: true })).toMatch(/vision/i);
    expect(incompatibilityReason(textOnly, {})).toBeNull();
  });
});
