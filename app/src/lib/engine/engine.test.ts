import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPausedError, buildMessages, sendMessage } from "./engine";
import { createRuntime } from "./runtime";
import type { Bot, BotRuntimeState, ChatStreamFn, ChatStreamRequest } from "./types";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    color: "#14b8a6",
    roleDescription: "Research accounts overnight, score buying intent",
    createdAt: Date.now(),
    paused: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("buildMessages", () => {
  it("puts a system prompt first, composed from name and role description", () => {
    const bot = makeBot();
    const messages = buildMessages(bot, []);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Scout");
    expect(messages[0]?.content).toContain(bot.roleDescription);
    expect(messages[0]?.content).toContain("concise");
  });

  it("maps thread history to user/assistant messages after the system prompt", () => {
    const messages = buildMessages(makeBot(), [
      { role: "user", content: "Find leads" },
      { role: "assistant", content: "On it" },
      { role: "user", content: "Status?" },
    ]);

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]?.content).toBe("Find leads");
    expect(messages[3]?.content).toBe("Status?");
  });
});

describe("sendMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives idle -> thinking -> talkingToUser -> celebrating -> idle on success", async () => {
    const runtime = createRuntime();
    const bot = makeBot();
    const seen: BotRuntimeState[] = [];
    runtime.subscribe(bot.id, (s) => seen.push(s));

    const deltas: string[] = [];
    const chatStream: ChatStreamFn = async ({ onDelta }) => {
      onDelta("Hel");
      onDelta("lo!");
      return "Hello!";
    };
    const onDelta = vi.fn((d: string) => deltas.push(d));
    const onDone = vi.fn();
    const onError = vi.fn();

    const result = await sendMessage(bot, [{ role: "user", content: "hi" }], {
      chatStream,
      runtime,
      onDelta,
      onDone,
      onError,
    });

    expect(result).toBe("Hello!");
    expect(deltas).toEqual(["Hel", "lo!"]);
    expect(onDone).toHaveBeenCalledWith("Hello!");
    expect(onError).not.toHaveBeenCalled();
    expect(seen).toEqual(["idle", "thinking", "talkingToUser", "celebrating"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["idle", "thinking", "talkingToUser", "celebrating", "idle"]);
    expect(runtime.getState(bot.id)).toBe("idle");
  });

  it("passes the composed message array to chatStream", async () => {
    const runtime = createRuntime();
    const bot = makeBot();
    let received: ChatStreamRequest | undefined;
    const chatStream: ChatStreamFn = async (req) => {
      received = req;
      return "";
    };

    await sendMessage(bot, [{ role: "user", content: "hi" }], { chatStream, runtime });

    expect(received?.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(received?.messages[0]?.content).toContain(bot.roleDescription);
  });

  it("enters error state and reports via onError on failure", async () => {
    const runtime = createRuntime();
    const bot = makeBot();
    const seen: BotRuntimeState[] = [];
    runtime.subscribe(bot.id, (s) => seen.push(s));
    const failure = new Error("network down");
    const chatStream: ChatStreamFn = async () => {
      throw failure;
    };
    const onError = vi.fn();
    const onDone = vi.fn();

    const result = await sendMessage(bot, [], { chatStream, runtime, onError, onDone });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onDone).not.toHaveBeenCalled();
    expect(seen).toEqual(["idle", "thinking", "error"]);
    expect(runtime.getState(bot.id)).toBe("error");
  });

  it("refuses to send for a paused bot and leaves it sleeping", async () => {
    const runtime = createRuntime();
    const bot = makeBot({ paused: true });
    const chatStream = vi.fn<ChatStreamFn>();

    await expect(
      sendMessage(bot, [{ role: "user", content: "hi" }], { chatStream, runtime }),
    ).rejects.toThrow(BotPausedError);

    expect(chatStream).not.toHaveBeenCalled();
    expect(runtime.getState(bot.id)).toBe("sleeping");
  });

  it("settles to idle (not error) when aborted", async () => {
    const runtime = createRuntime();
    const bot = makeBot();
    const controller = new AbortController();
    const chatStream: ChatStreamFn = ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const onError = vi.fn();

    const pending = sendMessage(bot, [], {
      chatStream,
      runtime,
      onError,
      signal: controller.signal,
    });
    expect(runtime.getState(bot.id)).toBe("thinking");

    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(runtime.getState(bot.id)).toBe("idle");
  });
});

describe("pillar guidance in the system prompt", () => {
  it("teaches the choices marker and minimal-question behavior to every bot", () => {
    const bot = { id: "b1", name: "Scout", roleDescription: "Helper" } as never;
    const [system] = buildMessages(bot, []);
    expect(system.role).toBe("system");
    // Without this, the question-card pipeline never fires (audit F1).
    expect(system.content).toContain("<<choices>>");
    expect(system.content).toContain("offer concrete options");
    expect(system.content).toContain("Minimize what the user must type");
  });
});
