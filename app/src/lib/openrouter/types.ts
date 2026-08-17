// Shared types for the OpenRouter client (spec: openspec/specs/model-configuration).

/** Per-token USD pricing as reported by OpenRouter. */
export interface ModelPricing {
  /** USD per prompt token. */
  prompt: number;
  /** USD per completion token. */
  completion: number;
}

/** A model from the OpenRouter catalog, normalized for the model picker. */
export interface ModelInfo {
  id: string;
  name: string;
  /** Provider slug derived from the model id (e.g. "anthropic" from "anthropic/..."). */
  provider: string;
  contextLength: number;
  pricing: ModelPricing;
  supportsTools: boolean;
  supportsVision: boolean;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI-style tool call attached to an assistant message (wire format). */
export interface ChatMessageToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on assistant messages that requested tool calls (echo back on follow-up rounds). */
  tool_calls?: ChatMessageToolCall[];
  /** Set on role:"tool" result messages: the id of the call being answered. */
  tool_call_id?: string;
}

/**
 * OpenAI-style function tool definition. OpenRouter passes this through to
 * the underlying provider unchanged.
 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema describing the arguments object. */
    parameters: Record<string, unknown>;
  };
}

/** A completed tool call assembled from streamed tool_calls deltas. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments (concatenated streamed fragments). */
  argumentsJson: string;
}

/** Token/cost usage for a single chat call. */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported USD cost, when available. */
  cost?: number;
}

export interface ChatResult {
  message: { role: "assistant"; content: string };
  usage?: ChatUsage;
  /** Tool calls the model requested this turn (absent when none). */
  toolCalls?: ToolCall[];
}

export interface ChatStreamParams {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Called once per streamed content delta (token or token group). */
  onDelta?: (delta: string) => void;
  /** OpenAI-style function tools to offer the model. */
  tools?: ToolDef[];
}
