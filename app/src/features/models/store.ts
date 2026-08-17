// Per-Bot model configuration store (spec: openspec/specs/model-configuration,
// "Model roles within a Bot" / "Failure handling and fallbacks").

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ModelRole = "primary" | "utility";

export interface BotModelConfig {
  /** Reasoning / planning / computer-use model. */
  primaryModelId: string;
  /** Classification / routing / summarization model; falls back to primary. */
  utilityModelId?: string;
  /** Ordered fallback models tried on provider failure. */
  fallbackModelIds: string[];
}

/** Sensible defaults: frontier agentic primary, small fast utility. */
export const DEFAULT_MODEL_CONFIG: BotModelConfig = {
  primaryModelId: "anthropic/claude-sonnet-4.5",
  utilityModelId: "anthropic/claude-haiku-4.5",
  fallbackModelIds: [],
};

export interface ModelConfigState {
  defaultConfig: BotModelConfig;
  /** Per-Bot overrides; Bots without an entry use defaultConfig. */
  byBot: Record<string, BotModelConfig>;
  setDefaultConfig: (config: BotModelConfig) => void;
  /** Merge a partial config over the Bot's current (or default) config. */
  setBotConfig: (botId: string, config: Partial<BotModelConfig>) => void;
  /** Remove a Bot's override so it reverts to the default config. */
  clearBotConfig: (botId: string) => void;
}

export const useModelConfigStore = create<ModelConfigState>()(
  persist(
    (set) => ({
      defaultConfig: DEFAULT_MODEL_CONFIG,
      byBot: {},
      setDefaultConfig: (config) => set({ defaultConfig: config }),
      setBotConfig: (botId, config) =>
        set((state) => ({
          byBot: {
            ...state.byBot,
            [botId]: {
              ...(state.byBot[botId] ?? state.defaultConfig),
              ...config,
            },
          },
        })),
      clearBotConfig: (botId) =>
        set((state) => {
          const { [botId]: _removed, ...rest } = state.byBot;
          return { byBot: rest };
        }),
    }),
    {
      name: "bots.model-config",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The effective config for a Bot (its override, or the default config). */
export function selectBotConfig(
  state: Pick<ModelConfigState, "byBot" | "defaultConfig">,
  botId: string,
): BotModelConfig {
  return state.byBot[botId] ?? state.defaultConfig;
}

/**
 * Resolve the model id for a role. Per spec, utility falls back to primary
 * when unset.
 */
export function selectModelForRole(
  state: Pick<ModelConfigState, "byBot" | "defaultConfig">,
  botId: string,
  role: ModelRole,
): string {
  const config = selectBotConfig(state, botId);
  if (role === "utility") return config.utilityModelId ?? config.primaryModelId;
  return config.primaryModelId;
}

/** Ordered fallback model ids for a Bot. */
export function selectFallbackModels(
  state: Pick<ModelConfigState, "byBot" | "defaultConfig">,
  botId: string,
): string[] {
  return selectBotConfig(state, botId).fallbackModelIds;
}
