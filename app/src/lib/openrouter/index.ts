// OpenRouter client (provider-agnostic routing layer entry point;
// spec: openspec/specs/model-configuration).

export { chatStream, clearModelsCache, listModels } from "./client";
export {
  AuthError,
  OpenRouterError,
  ProviderError,
  RateLimitError,
  errorForStatus,
} from "./errors";
export { getKey, resetKeyCache } from "./key";
export { SseParser } from "./sse";
export type {
  ChatMessage,
  ChatMessageToolCall,
  ChatResult,
  ChatRole,
  ChatStreamParams,
  ChatUsage,
  ModelInfo,
  ModelPricing,
  ToolCall,
  ToolDef,
} from "./types";
