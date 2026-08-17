import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStream, clearModelsCache, listModels } from "./client";
import { AuthError, ProviderError, RateLimitError } from "./errors";
import { resetKeyCache } from "./key";

const TEST_KEY = "test-openrouter-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const catalogBody = {
  data: [
    {
      id: "anthropic/claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools", "tool_choice", "max_tokens"],
    },
    {
      id: "some/text-only-model",
      name: "Text Only",
      context_length: 8192,
      pricing: { prompt: "0.0000001", completion: "0.0000002" },
      architecture: { input_modalities: ["text"] },
      supported_parameters: ["max_tokens"],
    },
  ],
};

beforeEach(() => {
  resetKeyCache();
  clearModelsCache();
  vi.stubEnv("VITE_OPENROUTER_API_KEY", TEST_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listModels", () => {
  it("maps the OpenRouter catalog to typed ModelInfo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(catalogBody));
    vi.stubGlobal("fetch", fetchMock);

    const models = await listModels();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
    );
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      contextLength: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
      supportsTools: true,
      supportsVision: true,
    });
    // Model without tool support / vision is flagged so the picker can mark
    // it incompatible.
    expect(models[1]).toMatchObject({
      id: "some/text-only-model",
      provider: "some",
      supportsTools: false,
      supportsVision: false,
    });
  });

  it("caches the catalog for 10 minutes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(catalogBody));
    vi.stubGlobal("fetch", fetchMock);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await listModels();
    await listModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 9 * 60 * 1000;
    await listModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 1000; // past the 10-minute TTL
    fetchMock.mockResolvedValue(jsonResponse(catalogBody));
    await listModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws AuthError on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(listModels()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws RateLimitError on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 429)));
    await expect(listModels()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws ProviderError on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 502)));
    const err = await listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// chatStream
// ---------------------------------------------------------------------------

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("chatStream", () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  it("assembles multi-chunk SSE deltas, reports usage, and stops at [DONE]", async () => {
    const first = sseChunk({ choices: [{ delta: { content: "Hel" } }] });
    // Split one SSE event across two network chunks to exercise buffering.
    const second = sseChunk({ choices: [{ delta: { content: "lo!" } }] });
    const chunks = [
      ": OPENROUTER PROCESSING\n\n" + first + second.slice(0, 12),
      second.slice(12),
      sseChunk({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.00012 },
      }),
      "data: [DONE]\n\n",
      sseChunk({ choices: [{ delta: { content: "IGNORED-AFTER-DONE" } }] }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const result = await chatStream({
      model: "anthropic/claude-sonnet-4.5",
      messages,
      onDelta: (d) => deltas.push(d),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "anthropic/claude-sonnet-4.5",
      stream: true,
      messages,
    });

    expect(deltas).toEqual(["Hel", "lo!"]);
    expect(result.message).toEqual({ role: "assistant", content: "Hello!" });
    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      cost: 0.00012,
    });
  });

  it("rejects with an AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          encoder.encode(sseChunk({ choices: [{ delta: { content: "partial" } }] })),
        );
        // Stream stays open; abort is what ends the call.
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const promise = chatStream({
      model: "m",
      messages,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("throws AuthError on 401 and RateLimitError on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    await expect(chatStream({ model: "m", messages })).rejects.toBeInstanceOf(AuthError);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })),
    );
    await expect(chatStream({ model: "m", messages })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("parses streamed tool_calls whose arguments are split across chunks", async () => {
    const chunks = [
      sseChunk({ choices: [{ delta: { content: "Checking." } }] }),
      // First fragment carries id + name, empty arguments.
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "remember_memory", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      // Argument JSON arrives in fragments that individually are not valid JSON.
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"text":"prefers ' } }],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'brevity"}' } }],
            },
          },
        ],
      }),
      // A second, interleaved tool call at index 1.
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_def",
                  type: "function",
                  function: { name: "forget_memory", arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, function: { arguments: '"old sheet"}' } }],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "remember_memory",
          description: "Save a memory",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      },
    ];
    const result = await chatStream({ model: "m", messages, tools });

    // tools passed through in the request body (OpenAI-style, unchanged).
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.tools).toEqual(tools);

    expect(result.message.content).toBe("Checking.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_abc",
        name: "remember_memory",
        argumentsJson: '{"text":"prefers brevity"}',
      },
      { id: "call_def", name: "forget_memory", argumentsJson: '{"query":"old sheet"}' },
    ]);
  });

  it("omits toolCalls and the tools body field when no tools are involved", async () => {
    const chunks = [
      sseChunk({ choices: [{ delta: { content: "Hi" } }] }),
      "data: [DONE]\n\n",
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatStream({ model: "m", messages });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect("tools" in body).toBe(false);
    expect(result.toolCalls).toBeUndefined();
  });

  it("throws ProviderError on 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    const err = await chatStream({ model: "m", messages }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(500);
  });
});
