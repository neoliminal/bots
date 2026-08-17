// Test doubles for everything outside the web app:
//
// 1. Tauri IPC bridge — an init script installs a fake
//    `window.__TAURI_INTERNALS__` whose `invoke` answers `get_dev_api_key`
//    with a fake key and any other command with a benign default, so the
//    app takes its "running in Tauri" code path with no Rust host present.
//
// 2. OpenRouter catalog — `page.route` interception of
//    https://openrouter.ai/api/v1/models returns a fixed ~10-model fixture
//    (anthropic / openai / google flagships plus a no-tools model so
//    capability gating is exercised).
//
// 3. OpenRouter chat completions — an init script patches `window.fetch`
//    for https://openrouter.ai/api/v1/chat/completions to return a real
//    `ReadableStream` SSE body whose deltas are spaced `delayMs` apart, so
//    streaming UI (indicator, Stop button) is observable and abortable
//    deterministically. A `page.route` for the same URL is registered as a
//    safety net so no real network request can ever escape. Tests can
//    reshape the reply via `setChatReply(page, …)` and inspect captured
//    request bodies via `chatRequests(page)`.

import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Model catalog fixture (raw OpenRouter /models wire shape)
// ---------------------------------------------------------------------------

interface RawModelFixture {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  architecture: { input_modalities: string[] };
  supported_parameters: string[];
}

const TOOLS = ["temperature", "tools", "tool_choice"];
const NO_TOOLS = ["temperature", "top_p"];

export const MODEL_FIXTURES: RawModelFixture[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    context_length: 1_000_000,
    pricing: { prompt: "0.000003", completion: "0.000015" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    context_length: 200_000,
    pricing: { prompt: "0.000015", completion: "0.000075" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    context_length: 200_000,
    pricing: { prompt: "0.000001", completion: "0.000005" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "openai/gpt-5",
    name: "GPT-5",
    context_length: 400_000,
    pricing: { prompt: "0.00000125", completion: "0.00001" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    context_length: 400_000,
    pricing: { prompt: "0.00000025", completion: "0.000002" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    context_length: 1_048_576,
    pricing: { prompt: "0.00000125", completion: "0.00001" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    context_length: 1_048_576,
    pricing: { prompt: "0.0000003", completion: "0.0000025" },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: TOOLS,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    context_length: 1_048_576,
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    architecture: { input_modalities: ["text"] },
    supported_parameters: TOOLS,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    context_length: 131_072,
    pricing: { prompt: "0.0000001", completion: "0.0000003" },
    architecture: { input_modalities: ["text"] },
    supported_parameters: TOOLS,
  },
  // No tool calling: exercises the picker's capability gating (rendered
  // disabled with the reason when `requireTools` is set).
  {
    id: "mistralai/mistral-small-3.2",
    name: "Mistral Small 3.2",
    context_length: 128_000,
    pricing: { prompt: "0.0000001", completion: "0.0000003" },
    architecture: { input_modalities: ["text"] },
    supported_parameters: NO_TOOLS,
  },
];

/** Count of anthropic models in the fixture (used by search-filter tests). */
export const ANTHROPIC_FIXTURE_COUNT = MODEL_FIXTURES.filter((m) =>
  m.id.startsWith("anthropic/"),
).length;

export const FAKE_API_KEY = "sk-test-fake";

/** Default streamed reply (joined: "Hello there! I am your mocked bot reply.") */
export const DEFAULT_REPLY_DELTAS = [
  "Hello",
  " there!",
  " I am",
  " your",
  " mocked",
  " bot",
  " reply.",
];
export const DEFAULT_REPLY_TEXT = DEFAULT_REPLY_DELTAS.join("");
const DEFAULT_DELAY_MS = 120;

/** A tool call the mocked model "makes" (streamed as a tool_calls delta). */
export interface MockToolCall {
  name: string;
  /** JSON-encoded arguments string, exactly as a model would emit. */
  arguments: string;
}

/**
 * One scripted model reply: either streamed text deltas or tool calls.
 * Queued replies are consumed request-by-request (oldest first); when the
 * queue is empty the default `deltas` reply streams instead.
 */
export interface MockReply {
  deltas?: string[];
  toolCalls?: MockToolCall[];
}

// Shape of the in-page mock state (window.__E2E_CHAT__).
export interface ChatMockConfig {
  deltas: string[];
  delayMs: number;
  queue?: MockReply[];
}
interface ChatMockState extends ChatMockConfig {
  queue: MockReply[];
  requests: Array<{ model: string; messages: unknown[]; stream: boolean }>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

/**
 * Install every mock. Call BEFORE page.goto().
 */
export async function installMocks(page: Page): Promise<void> {
  // --- 1. Fake Tauri IPC bridge -------------------------------------------
  await page.addInitScript(
    ({ fakeKey }) => {
      let callbackId = 0;
      // MCP fixture: any mcp_connect succeeds with a single echo tool;
      // mcp_call echoes back its text argument. Connected server names are
      // tracked so mcp_servers reflects settings-UI state.
      const mcpEchoTool = {
        name: "echo",
        description: "Echo text back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "Text to echo." } },
          required: ["text"],
        },
      };
      const mcpConnected = new Set<string>();
      // Personal-host fixture for the first-run compute flow: discovery
      // results and reachability are reshaped per test via setHostState().
      const hostState = { hosts: [] as string[], reachable: true, user: "e2e" };
      (window as unknown as { __E2E_HOST__: typeof hostState }).__E2E_HOST__ =
        hostState;
      const exec = (stdout: string, ok = true) =>
        Promise.resolve({
          exitCode: ok ? 0 : 255,
          stdout,
          stderr: ok ? "" : "ssh: connect to host: Connection refused",
          truncated: false,
          timedOut: false,
          durationMs: 1,
        });
      const internals = {
        invoke: (cmd: string, args?: unknown, _options?: unknown): Promise<unknown> => {
          if (cmd === "get_dev_api_key") return Promise.resolve(fakeKey);
          const a = (args ?? {}) as Record<string, unknown>;
          if (cmd === "host_discover") return Promise.resolve([...hostState.hosts]);
          if (cmd === "host_exec") {
            return exec(hostState.reachable ? "ok" : "", hostState.reachable);
          }
          if (cmd === "session_local_exec") {
            // A command that never returns, for testing interruption
            // mid-step. One-shot: the flag clears as it takes effect.
            const hang = (window as unknown as { __E2E_HANG_EXEC__?: boolean })
              .__E2E_HANG_EXEC__;
            if (hang === true && String(a.cmd) !== "whoami") {
              (window as unknown as { __E2E_HANG_EXEC__?: boolean }).__E2E_HANG_EXEC__ =
                false;
              return new Promise(() => {});
            }
            return exec(String(a.cmd) === "whoami" ? hostState.user : "");
          }
          if (cmd === "mcp_connect") {
            mcpConnected.add(String(a.name));
            return Promise.resolve([mcpEchoTool]);
          }
          if (cmd === "mcp_call") {
            const callArgs = (a.args ?? {}) as Record<string, unknown>;
            return Promise.resolve(`echo: ${String(callArgs.text ?? "")}`);
          }
          if (cmd === "mcp_disconnect") {
            mcpConnected.delete(String(a.name));
            return Promise.resolve(null);
          }
          if (cmd === "mcp_servers") {
            return Promise.resolve(
              [...mcpConnected].map((name) => ({ name, tools: [mcpEchoTool] })),
            );
          }
          // Benign default for any other command (plugins, future commands).
          return Promise.resolve(null);
        },
        transformCallback: (cb?: (payload: unknown) => void): number => {
          callbackId += 1;
          const id = callbackId;
          Object.defineProperty(window, `_${id}`, {
            value: (payload: unknown) => cb?.(payload),
            writable: false,
            configurable: true,
          });
          return id;
        },
        unregisterCallback: (id: number): void => {
          delete (window as unknown as Record<string, unknown>)[`_${id}`];
        },
        convertFileSrc: (filePath: string): string => filePath,
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        plugins: {},
      };
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: internals,
        configurable: true,
      });
    },
    { fakeKey: FAKE_API_KEY },
  );

  // --- 2. Streaming chat-completions fetch shim ---------------------------
  await page.addInitScript(
    ({ deltas, delayMs }) => {
      const state: ChatMockState = { deltas, delayMs, queue: [], requests: [] };
      (window as unknown as { __E2E_CHAT__: ChatMockState }).__E2E_CHAT__ = state;

      const realFetch = window.fetch.bind(window);
      const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        if (!url.startsWith(CHAT_URL)) return realFetch(input, init);

        const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        if (signal?.aborted) {
          return Promise.reject(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        }

        try {
          const rawBody = init?.body;
          if (typeof rawBody === "string") state.requests.push(JSON.parse(rawBody));
        } catch {
          // Non-JSON body: ignore; tests only assert on well-formed sends.
        }

        // Snapshot config at request time so a test can reconfigure safely.
        // Scripted replies (queue) are consumed one per request — a reply of
        // tool calls streams a tool_calls delta; otherwise text deltas
        // stream one chunk each. The default deltas answer everything else.
        const reply = state.queue.shift() ?? { deltas: state.deltas.slice() };
        const stepMs = state.delayMs;
        const encoder = new TextEncoder();
        let index = 0;

        const payloads: string[] = [];
        if (reply.toolCalls && reply.toolCalls.length > 0) {
          payloads.push(
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: reply.toolCalls.map((tc, i) => ({
                      index: i,
                      id: `call_${i + 1}`,
                      type: "function",
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                  },
                },
              ],
            }),
          );
        } else {
          for (const delta of reply.deltas ?? []) {
            payloads.push(
              JSON.stringify({ choices: [{ delta: { content: delta } }] }),
            );
          }
        }
        payloads.push(
          JSON.stringify({
            choices: [{ delta: {} }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: payloads.length,
              total_tokens: 12 + payloads.length,
              cost: 0.0001,
            },
          }),
        );
        payloads.push("[DONE]");

        const sse = (payload: string) => encoder.encode(`data: ${payload}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            if (signal?.aborted) {
              controller.close();
              return;
            }
            if (index < payloads.length) {
              controller.enqueue(sse(payloads[index]));
              index += 1;
            } else {
              controller.close();
            }
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      };
    },
    { deltas: DEFAULT_REPLY_DELTAS, delayMs: DEFAULT_DELAY_MS },
  );

  // --- 3. Network interception (catalog + chat safety net) ----------------
  await page.route("https://openrouter.ai/api/v1/models*", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ data: MODEL_FIXTURES }),
    });
  });

  // Safety net only: the fetch shim above answers chat completions in-page,
  // so this route should never fire — but if it does (e.g. a future code
  // path bypasses window.fetch), it still returns the full fixture reply
  // rather than hitting the real OpenRouter API.
  await page.route("https://openrouter.ai/api/v1/chat/completions*", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const body =
      DEFAULT_REPLY_DELTAS.map(
        (delta) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
      ).join("") + "data: [DONE]\n\n";
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" },
      body,
    });
  });
}

/** Personal-host fixture state (discovery results + reachability). */
export interface HostMockState {
  hosts: string[];
  reachable: boolean;
  user: string;
}

/**
 * Reshape the personal-host fixture: which SSH hosts discovery reports and
 * whether they answer the reachability probe. Call before the flow reaches
 * the host branch.
 */
export async function setHostState(
  page: Page,
  config: Partial<HostMockState>,
): Promise<void> {
  await page.evaluate((cfg) => {
    const state = (window as unknown as { __E2E_HOST__: HostMockState }).__E2E_HOST__;
    if (cfg.hosts) state.hosts = cfg.hosts;
    if (cfg.reachable !== undefined) state.reachable = cfg.reachable;
    if (cfg.user) state.user = cfg.user;
  }, config);
}

/**
 * Make the next session command hang forever, standing in for an app that
 * dies mid-step. One-shot: it clears itself when it fires.
 */
export async function hangNextExec(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __E2E_HANG_EXEC__: boolean }).__E2E_HANG_EXEC__ = true;
  });
}

/** Reconfigure the streamed reply for subsequent sends on this page. */
export async function setChatReply(
  page: Page,
  config: Partial<ChatMockConfig>,
): Promise<void> {
  await page.evaluate((cfg) => {
    const state = (window as unknown as { __E2E_CHAT__: ChatMockConfig }).__E2E_CHAT__;
    if (cfg.deltas) state.deltas = cfg.deltas;
    if (cfg.delayMs !== undefined) state.delayMs = cfg.delayMs;
    if (cfg.queue) state.queue = cfg.queue;
  }, config);
}

/**
 * Script the next model replies in order (oldest first). Each queued reply
 * answers exactly one chat-completions request; once the queue drains, the
 * default deltas answer subsequent requests.
 */
export async function queueChatReplies(
  page: Page,
  replies: MockReply[],
): Promise<void> {
  await page.evaluate((queued) => {
    const state = (
      window as unknown as { __E2E_CHAT__: { queue: MockReply[] } }
    ).__E2E_CHAT__;
    state.queue.push(...queued);
  }, replies);
}

/** Captured chat-completion request bodies (oldest first). */
export function chatRequests(
  page: Page,
): Promise<Array<{ model: string; messages: unknown[]; stream: boolean }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __E2E_CHAT__: ChatMockState }).__E2E_CHAT__.requests,
  );
}
