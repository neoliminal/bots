// Core types for the local bot engine.
// Specs: openspec/specs/bot-management/spec.md (creation/config subset)
//        openspec/specs/bot-avatars/spec.md (runtime state feed contract)
import type { ToolPolicy } from "./policy";

/** A durable, named bot entity (bot-management spec). */
export interface Bot {
  id: string;
  name: string;
  /** Avatar ball color (hex or CSS color string). */
  color: string;
  /** Free-text role/job description used as standing context. */
  roleDescription: string;
  /** Epoch milliseconds. */
  createdAt: number;
  paused: boolean;
  /** Epoch ms when soft-deleted; null/undefined when active. 30-day restore window. */
  deletedAt?: number | null;
  /**
   * @deprecated Dropped by the multi-bot-collaboration redesign ("Executive
   * Assistant as a role, not a mechanism"): every bot can delegate via
   * contact_bot, so there is no coordinator gate. The field is tolerated on
   * load from older stores and ignored by the engine; the bots store no
   * longer writes it.
   */
  isCoordinator?: boolean;
  /**
   * Per-bot delegation restriction (multi-bot-collaboration spec, "Paused or
   * restricted teammates"): when false, teammates' contact_bot calls
   * targeting this bot are refused. Absent means true (open within the team).
   */
  canBeContacted?: boolean;
  /** Workspace path passthrough for integrations (shared filesystem root). */
  workspacePath?: string;
  /**
   * Per-bot tool policy (bot-management "Bot configuration"; enforced per
   * tool-extensibility): visibility + gating rules by tool name/category.
   * Absent means platform defaults (allow-all-visible, category gating).
   */
  toolPolicy?: ToolPolicy;
  /**
   * Authored-skill enablement (tool-extensibility "Authored skills"), in
   * priority order. Absent means every skill discovered in the workspace's
   * skills/ directory is enabled; an explicit list enables only those
   * names, in that order.
   */
  enabledSkills?: string[];
}

/**
 * The avatar state feed union (bot-avatars spec, "State-driven animations").
 * This is the single source of truth the avatar renderer subscribes to.
 */
export type BotRuntimeState =
  | "idle"
  | "thinking"
  | "working"
  | "talkingToUser"
  | "talkingToBot"
  | "waitingOnUser"
  | "handoff"
  | "error"
  | "sleeping"
  | "celebrating"
  | "disconnected";

/** All runtime states, useful for exhaustive UI mapping and validation. */
export const BOT_RUNTIME_STATES: readonly BotRuntimeState[] = [
  "idle",
  "thinking",
  "working",
  "talkingToUser",
  "talkingToBot",
  "waitingOnUser",
  "handoff",
  "error",
  "sleeping",
  "celebrating",
  "disconnected",
] as const;

/** Chat message roles accepted by the OpenRouter-style completion API. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * OpenAI-style tool call attached to an assistant message. Wire-format
 * field names are kept so engine messages can be passed to the OpenRouter
 * client unchanged.
 */
export interface ChatMessageToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: ChatMessageToolCall[];
  /** Present on role:"tool" result messages: the id of the call being answered. */
  tool_call_id?: string;
}

/** OpenAI-style function tool definition (passed through to OpenRouter). */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema describing the arguments object. */
    parameters: Record<string, unknown>;
  };
}

/** A completed tool call the model requested (normalized from streamed deltas). */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string of the arguments. */
  argumentsJson: string;
}

/** A message in a bot's thread history (no system entries — the engine composes those). */
export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
}

/** Request shape passed to the injected streaming completion function. */
export interface ChatStreamRequest {
  messages: ChatMessage[];
  /** Called for each streamed text delta. */
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * Injected streaming completion function (integration wires the real
 * OpenRouter client; tests inject a fake). Resolves with the full text.
 */
export type ChatStreamFn = (request: ChatStreamRequest) => Promise<string>;

/** Request shape for the tool-aware loop completion function. */
export interface LoopChatRequest {
  messages: ChatMessage[];
  /** Offered tools; absent on the final wrap-up round. */
  tools?: ToolDef[];
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

/** Result of one tool-aware model round. */
export interface LoopChatResult {
  text: string;
  toolCalls?: ToolCallRequest[];
}

/**
 * Injected tool-aware streaming completion (integration adapts the real
 * OpenRouter chatStream: text = result.message.content, toolCalls passes
 * through unchanged).
 */
export type LoopChatFn = (request: LoopChatRequest) => Promise<LoopChatResult>;

/** Callbacks the engine emits while processing a sendMessage call. */
export interface EngineEvents {
  onDelta?: (delta: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * Key-value persistence interface. This mirrors the interface that
 * `src/lib/storage` will expose; once that module lands, integration should
 * re-export/adapt it via `configureEngineStorage` (see bots.ts) — the engine
 * only ever talks to this shape.
 */
export interface StorageLike {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}
