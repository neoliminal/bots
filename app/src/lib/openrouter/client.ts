// OpenRouter HTTP client (spec: openspec/specs/model-configuration).
//
// The API key resolved via getKey() is used only for the Authorization header
// of outgoing requests — never logged, never persisted.

import { errorForStatus, ProviderError } from "./errors";
import { getKey } from "./key";
import { SseParser } from "./sse";
import type {
  ChatResult,
  ChatStreamParams,
  ChatUsage,
  ModelInfo,
  ToolCall,
} from "./types";

const BASE_URL = "https://openrouter.ai/api/v1";
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

interface RawModel {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: { prompt?: string | number; completion?: string | number } | null;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[] | null;
  } | null;
  supported_parameters?: string[] | null;
}

let modelsCache: { models: ModelInfo[]; fetchedAt: number } | null = null;

/** Test/dev helper: drop the in-memory model catalog cache. */
export function clearModelsCache(): void {
  modelsCache = null;
}

function mapModel(raw: RawModel): ModelInfo {
  const slashIndex = raw.id.indexOf("/");
  const provider = slashIndex > 0 ? raw.id.slice(0, slashIndex) : "openrouter";
  const inputModalities =
    raw.architecture?.input_modalities ??
    (raw.architecture?.modality ?? "").split(/[+>-]/);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    provider,
    contextLength: raw.context_length ?? 0,
    pricing: {
      prompt: Number(raw.pricing?.prompt ?? 0),
      completion: Number(raw.pricing?.completion ?? 0),
    },
    supportsTools: (raw.supported_parameters ?? []).includes("tools"),
    supportsVision: inputModalities.includes("image"),
  };
}

async function safeBodyText(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 0 ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the OpenRouter model catalog; results are cached for 10 minutes. */
export async function listModels(): Promise<ModelInfo[]> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  const key = await getKey();
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw errorForStatus(res.status, await safeBodyText(res));
  const body = (await res.json()) as { data?: RawModel[] };
  const models = (body.data ?? []).map(mapModel);
  modelsCache = { models, fetchedAt: Date.now() };
  return models;
}

// ---------------------------------------------------------------------------
// chatStream
// ---------------------------------------------------------------------------

interface StreamToolCallDelta {
  index?: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: StreamToolCallDelta[] | null;
    } | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  } | null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function mapUsage(usage: NonNullable<StreamChunk["usage"]>): ChatUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  };
}

/**
 * Stream a chat completion. Invokes onDelta per streamed content delta and
 * resolves with the assembled assistant message plus usage (when reported).
 *
 * Throws AuthError (401/403), RateLimitError (429), ProviderError (other
 * non-2xx), or a DOMException named "AbortError" when the signal aborts.
 */
export async function chatStream(params: ChatStreamParams): Promise<ChatResult> {
  const { model, messages, signal, onDelta, tools } = params;
  throwIfAborted(signal);
  const key = await getKey();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      usage: { include: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
    signal,
  });
  if (!res.ok) throw errorForStatus(res.status, await safeBodyText(res));
  if (!res.body) {
    throw new ProviderError("OpenRouter returned an empty response body", res.status);
  }

  const reader = res.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const decoder = new TextDecoder();
  const parser = new SseParser();
  let content = "";
  let usage: ChatUsage | undefined;
  // Streamed tool calls arrive as indexed deltas: the first fragment for an
  // index carries id/name, later fragments append to `arguments`.
  const toolCallAcc = new Map<number, ToolCall>();

  const pushToolCallDeltas = (deltas: StreamToolCallDelta[]): void => {
    for (const tc of deltas) {
      const index = tc.index ?? 0;
      let acc = toolCallAcc.get(index);
      if (!acc) {
        acc = { id: "", name: "", argumentsJson: "" };
        toolCallAcc.set(index, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
    }
  };

  try {
    stream: for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (payload === "[DONE]") break stream;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue; // tolerate malformed keep-alive/partial payloads
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          onDelta?.(delta);
        }
        const toolCallDeltas = chunk.choices?.[0]?.delta?.tool_calls;
        if (toolCallDeltas && toolCallDeltas.length > 0) {
          pushToolCallDeltas(toolCallDeltas);
        }
        if (chunk.usage) usage = mapUsage(chunk.usage);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }

  const toolCalls = [...toolCallAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);

  return {
    message: { role: "assistant", content },
    ...(usage ? { usage } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
