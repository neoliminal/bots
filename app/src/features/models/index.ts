// Model configuration feature (spec: openspec/specs/model-configuration).
// Public API for this feature is exported from here.

export { ModelPicker, incompatibilityReason } from "./ModelPicker";
export type { ModelPickerProps } from "./ModelPicker";
export { FEATURED_CAP, inUseModelIds, selectFeaturedModels } from "./featured";
export {
  DEFAULT_MODEL_CONFIG,
  selectBotConfig,
  selectFallbackModels,
  selectModelForRole,
  useModelConfigStore,
} from "./store";
export type { BotModelConfig, ModelConfigState, ModelRole } from "./store";
export {
  selectUsageByBot,
  selectUsageByModel,
  useUsageStore,
} from "./usageStore";
export type { UsageAggregate, UsageRecord, UsageState } from "./usageStore";
