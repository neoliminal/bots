import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_MS, SessionManager } from "./store";
import type {
  SessionProvider,
  SessionStatusEvent,
} from "./types";

/** Minimal controllable fake provider. */
function fakeProvider(overrides: Partial<SessionProvider> = {}): {
  provider: SessionProvider;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    provision: [],
    exec: [],
    stop: [],
  };
  let count = 0;
  const provider: SessionProvider = {
    kind: "fly",
    async provision(botId) {
      calls.provision.push([botId]);
      count += 1;
      return { sessionId: `m-${botId}-${count}`, status: "running" };
    },
    async exec(sessionId, cmd) {
      calls.exec.push([sessionId, cmd]);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    async listFiles() {
      return [];
    },
    async stop(sessionId, opts) {
      calls.stop.push([sessionId, opts]);
    },
    async status() {
      return "running";
    },
    ...overrides,
  };
  return { provider, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionManager.acquire", () => {
  it("provisions on first use and reuses the running session", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    const first = await manager.acquire("bot-1");
    const second = await manager.acquire("bot-1");
    expect(first).toBe(second);
    expect(calls.provision).toHaveLength(1);
    expect(manager.get("bot-1")).toEqual({
      sessionId: first,
      status: "running",
    });
  });

  it("coalesces concurrent acquires into one provision", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    const [a, b] = await Promise.all([
      manager.acquire("bot-1"),
      manager.acquire("bot-1"),
    ]);
    expect(a).toBe(b);
    expect(calls.provision).toHaveLength(1);
  });

  it("tracks sessions per bot independently", async () => {
    const { provider } = fakeProvider();
    const manager = new SessionManager(provider);
    const a = await manager.acquire("bot-a");
    const b = await manager.acquire("bot-b");
    expect(a).not.toBe(b);
  });

  it("emits provisioning then running status events", async () => {
    const { provider } = fakeProvider();
    const manager = new SessionManager(provider);
    const events: SessionStatusEvent[] = [];
    manager.onStatus((event) => events.push(event));
    const sessionId = await manager.acquire("bot-1");
    expect(events).toEqual([
      { botId: "bot-1", sessionId: null, status: "provisioning", kind: "fly" },
      { botId: "bot-1", sessionId, status: "running", kind: "fly" },
    ]);
  });

  it("emits error and clears state when provisioning fails, then retries", async () => {
    let fail = true;
    const { provider, calls } = fakeProvider({
      async provision(botId) {
        calls.provision.push([botId]);
        if (fail) throw new Error("no capacity");
        return { sessionId: "m-ok", status: "running" };
      },
    });
    const manager = new SessionManager(provider);
    const events: SessionStatusEvent[] = [];
    manager.onStatus((event) => events.push(event));
    await expect(manager.acquire("bot-1")).rejects.toThrow("no capacity");
    expect(events[events.length - 1]?.status).toBe("error");
    expect(manager.get("bot-1")).toBeUndefined();
    fail = false;
    await expect(manager.acquire("bot-1")).resolves.toBe("m-ok");
  });
});

describe("idle auto-stop", () => {
  it("stops the session after the default 10 minute idle timeout", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    const sessionId = await manager.acquire("bot-1");
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS);
    expect(calls.stop).toEqual([[sessionId, { destroy: undefined }]]);
    expect(manager.get("bot-1")).toBeUndefined();
  });

  it("touch resets the idle timer", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider, { idleMs: 1000 });
    await manager.acquire("bot-1");
    await vi.advanceTimersByTimeAsync(800);
    manager.touch("bot-1");
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.stop).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.stop).toHaveLength(1);
  });

  it("acquire on a running session also resets the idle timer", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider, { idleMs: 1000 });
    await manager.acquire("bot-1");
    await vi.advanceTimersByTimeAsync(900);
    await manager.acquire("bot-1");
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.stop).toHaveLength(0);
  });

  it("emits a stopped event on idle teardown", async () => {
    const { provider } = fakeProvider();
    const manager = new SessionManager(provider, { idleMs: 1000 });
    const events: SessionStatusEvent[] = [];
    manager.onStatus((event) => events.push(event));
    const sessionId = await manager.acquire("bot-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(events[events.length - 1]).toEqual({
      botId: "bot-1",
      sessionId,
      status: "stopped",
      kind: "fly",
    });
  });
});

describe("explicit stop", () => {
  it("passes destroy through to the provider", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    const sessionId = await manager.acquire("bot-1");
    await manager.stop("bot-1", { destroy: true });
    expect(calls.stop).toEqual([[sessionId, { destroy: true }]]);
  });

  it("is a no-op without an active session", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    await manager.stop("bot-1");
    expect(calls.stop).toHaveLength(0);
  });

  it("stopAll stops every bot's session", async () => {
    const { provider, calls } = fakeProvider();
    const manager = new SessionManager(provider);
    await manager.acquire("bot-a");
    await manager.acquire("bot-b");
    await manager.stopAll();
    expect(calls.stop).toHaveLength(2);
    expect(manager.get("bot-a")).toBeUndefined();
    expect(manager.get("bot-b")).toBeUndefined();
  });

  it("unsubscribing stops event delivery", async () => {
    const { provider } = fakeProvider();
    const manager = new SessionManager(provider);
    const events: SessionStatusEvent[] = [];
    const unsubscribe = manager.onStatus((event) => events.push(event));
    unsubscribe();
    await manager.acquire("bot-1");
    expect(events).toHaveLength(0);
  });
});
