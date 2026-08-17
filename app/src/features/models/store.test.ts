import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  selectBotConfig,
  selectFallbackModels,
  selectModelForRole,
  useModelConfigStore,
} from "./store";

beforeEach(() => {
  localStorage.clear();
  useModelConfigStore.setState({
    defaultConfig: DEFAULT_MODEL_CONFIG,
    byBot: {},
  });
});

describe("model config store", () => {
  it("returns the default config for a bot with no override", () => {
    const state = useModelConfigStore.getState();
    expect(selectBotConfig(state, "bot-1")).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it("merges partial per-bot config over the default", () => {
    useModelConfigStore
      .getState()
      .setBotConfig("bot-1", { primaryModelId: "openai/gpt-5" });
    const state = useModelConfigStore.getState();
    expect(selectBotConfig(state, "bot-1")).toEqual({
      ...DEFAULT_MODEL_CONFIG,
      primaryModelId: "openai/gpt-5",
    });
    // Other bots are unaffected.
    expect(selectBotConfig(state, "bot-2")).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it("resolves utility to the utility model when set", () => {
    useModelConfigStore.getState().setBotConfig("bot-1", {
      primaryModelId: "big/model",
      utilityModelId: "small/model",
      fallbackModelIds: [],
    });
    const state = useModelConfigStore.getState();
    expect(selectModelForRole(state, "bot-1", "primary")).toBe("big/model");
    expect(selectModelForRole(state, "bot-1", "utility")).toBe("small/model");
  });

  it("falls back utility -> primary when utility is unset (per spec)", () => {
    useModelConfigStore.getState().setBotConfig("bot-1", {
      primaryModelId: "big/model",
      utilityModelId: undefined,
      fallbackModelIds: [],
    });
    const state = useModelConfigStore.getState();
    expect(selectModelForRole(state, "bot-1", "utility")).toBe("big/model");
  });

  it("exposes ordered fallbacks and clears overrides", () => {
    useModelConfigStore.getState().setBotConfig("bot-1", {
      fallbackModelIds: ["fb/one", "fb/two"],
    });
    expect(
      selectFallbackModels(useModelConfigStore.getState(), "bot-1"),
    ).toEqual(["fb/one", "fb/two"]);

    useModelConfigStore.getState().clearBotConfig("bot-1");
    expect(selectBotConfig(useModelConfigStore.getState(), "bot-1")).toEqual(
      DEFAULT_MODEL_CONFIG,
    );
  });

  it("persists config to localStorage", () => {
    useModelConfigStore
      .getState()
      .setBotConfig("bot-1", { primaryModelId: "persisted/model" });
    const raw = localStorage.getItem("bots.model-config");
    expect(raw).toBeTruthy();
    expect(raw).toContain("persisted/model");
  });
});
