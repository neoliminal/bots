import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../features/chat";
import { ToolRegistry, type Bot, type ToolContext } from "../lib/engine";
import { DEFAULT_IDLE_MS } from "../lib/sessions";
import { createMemoryStorage } from "../lib/storage";
import {
  SESSION_PROVIDER_KEY,
  SESSION_TOOL_NAMES,
  getSessionManager,
  getSessionProviderKind,
  initSessions,
  resetSessionsForTest,
  setSessionProvider,
  stopAllSessions,
} from "./sessionGlue";

const bot: Bot = {
  id: "bot-1",
  name: "Scout",
  color: "#14b8a6",
  roleDescription: "Research",
  createdAt: 0,
  paused: false,
};

const ctx: ToolContext = { bot, threadId: "thread-1" };

function sessionEvents(threadId: string) {
  return (chatStore.getState().threads[threadId] ?? []).filter(
    (m) => m.meta?.kind === "session",
  );
}

describe("sessionGlue", () => {
  let registry: ToolRegistry;
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(async () => {
    resetSessionsForTest();
    chatStore.setState({
      threads: {},
      threadsById: {},
      unread: {},
      activeThreadId: null,
      activeBotId: null,
      hydrated: true,
    });
    registry = new ToolRegistry();
    storage = createMemoryStorage();
    await initSessions({ registry, storage });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSessionsForTest();
  });

  it("defaults to the local provider and registers all session tools", () => {
    expect(getSessionProviderKind()).toBe("local");
    for (const name of SESSION_TOOL_NAMES) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it("categorizes session_exec shell-local on local, shell-session on fly; file tools stay ungated categories", async () => {
    expect(registry.get("session_exec")?.category).toBe("shell-local");
    expect(registry.get("session_read_file")?.category).toBe("read");
    expect(registry.get("session_write_file")?.category).toBe("workspace-mutate");

    await setSessionProvider("fly");
    expect(registry.get("session_exec")?.category).toBe("shell-session");
    expect(registry.get("session_read_file")?.category).toBe("read");
    expect(registry.get("session_write_file")?.category).toBe("workspace-mutate");
  });

  it("persists the provider choice and re-reads it on init", async () => {
    await setSessionProvider("fly");
    expect(await storage.get(SESSION_PROVIDER_KEY)).toBe("fly");

    resetSessionsForTest();
    const registry2 = new ToolRegistry();
    await initSessions({ registry: registry2, storage });
    expect(getSessionProviderKind()).toBe("fly");
    expect(registry2.get("session_exec")?.category).toBe("shell-session");
  });

  it("first session_exec provisions transparently, with the lifecycle indicator as the only trace", async () => {
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "echo hi" }, ctx);

    const events = sessionEvents("thread-1");
    const kinds = events.map((m) => m.meta?.sessionEvent);
    expect(kinds).toContain("provisioned");

    // Timeline events never bump unread (subtle indicators, not messages).
    expect(chatStore.getState().unread["thread-1"] ?? 0).toBe(0);
  });

  it("commands never reach the thread, however many of them run", async () => {
    // agent-computer spec, "Isolation and hygiene": the conversation is the
    // bot's account of its work, not a console. The record lives in the
    // audit log, written by the run loop for every call.
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "ls -la" }, ctx);
    await exec.run({ cmd: "cat notes.md" }, ctx);

    const events = sessionEvents("thread-1");
    expect(events.map((m) => m.meta?.sessionEvent)).not.toContain("exec");
    expect(events.some((m) => m.text.includes("ls -la"))).toBe(false);
    expect(events.some((m) => m.text.includes("cat notes.md"))).toBe(false);
    // One session, one lifecycle line — not one per command.
    expect(
      events.filter((m) => m.meta?.sessionEvent === "provisioned"),
    ).toHaveLength(1);
  });

  it("idle auto-stop fires after the default timeout and the next use warm-resumes", async () => {
    vi.useFakeTimers();
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "echo one" }, ctx);
    expect(getSessionManager()?.get(bot.id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS + 1);
    expect(getSessionManager()?.get(bot.id)).toBeUndefined();
    expect(
      sessionEvents("thread-1").map((m) => m.meta?.sessionEvent),
    ).toContain("stopped");

    await exec.run({ cmd: "echo two" }, ctx);
    expect(
      sessionEvents("thread-1").map((m) => m.meta?.sessionEvent),
    ).toContain("warm-resumed");
  });

  it("session tool activity resets the idle timer (touch on use)", async () => {
    vi.useFakeTimers();
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "echo one" }, ctx);

    // Halfway to the timeout, more activity arrives.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS / 2);
    await exec.run({ cmd: "echo two" }, ctx);

    // The original deadline passes without a stop (timer was reset)…
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS / 2 + 1);
    expect(getSessionManager()?.get(bot.id)?.status).toBe("running");

    // …and the full idle window after the last use does stop it.
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS);
    expect(getSessionManager()?.get(bot.id)).toBeUndefined();
  });

  it("stopAllSessions stops every bot's session (app quit, best-effort)", async () => {
    const exec = registry.get("session_exec")!;
    const other: ToolContext = {
      bot: { ...bot, id: "bot-2", name: "Nova" },
      threadId: "thread-2",
    };
    await exec.run({ cmd: "echo a" }, ctx);
    await exec.run({ cmd: "echo b" }, other);
    expect(getSessionManager()?.get("bot-1")?.status).toBe("running");
    expect(getSessionManager()?.get("bot-2")?.status).toBe("running");

    await stopAllSessions();
    expect(getSessionManager()?.get("bot-1")).toBeUndefined();
    expect(getSessionManager()?.get("bot-2")).toBeUndefined();
  });

  it("lifecycle indicators follow the thread the bot last used sessions in", async () => {
    vi.useFakeTimers();
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "echo hi" }, { bot, threadId: "group-9" });

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS + 1);
    const kinds = sessionEvents("group-9").map((m) => m.meta?.sessionEvent);
    expect(kinds).toContain("provisioned");
    expect(kinds).toContain("stopped");
    expect(sessionEvents(bot.id)).toHaveLength(0);
  });

  it("switching providers keeps timeline routing and marks events with the provider kind", async () => {
    const exec = registry.get("session_exec")!;
    await exec.run({ cmd: "echo local" }, ctx);
    expect(
      sessionEvents("thread-1").every((m) => m.meta?.sessionKind === "local"),
    ).toBe(true);
    expect(getSessionProviderKind()).toBe("local");

    await setSessionProvider("fly");
    expect(getSessionProviderKind()).toBe("fly");
    // Outside Tauri fly provisioning rejects; the tool degrades to an error
    // string for the model rather than throwing into the loop.
    const result = await registry.get("session_exec")!.run({ cmd: "echo x" }, ctx);
    expect(String(result)).toMatch(/^Error:/);
  });
});
