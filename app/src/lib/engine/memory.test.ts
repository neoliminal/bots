import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  composeSystemPrompt,
  createMemoryStore,
  memoryStorageKey,
  registerMemoryTools,
  type MemoryEntry,
  type MemoryStore,
} from "./memory";
import { ToolRegistry, type ToolContext } from "./tools";
import type { Bot } from "./types";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    color: "#14b8a6",
    roleDescription: "Research accounts overnight",
    createdAt: Date.now(),
    paused: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("MemoryStore", () => {
  it("remember adds entries with timestamps and persists them", async () => {
    const storage = createMemoryStorage();
    const store = createMemoryStore("bot-1", storage);
    const before = Date.now();

    const entry = store.remember("never contact accounts owned by Dana");

    expect(entry.text).toBe("never contact accounts owned by Dana");
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.updatedAt).toBe(entry.createdAt);
    expect(store.list()).toEqual([entry]);

    // Flush the async persist, then verify a fresh store hydrates the entry.
    await Promise.resolve();
    const rehydrated = createMemoryStore("bot-1", storage);
    await rehydrated.hydrate();
    expect(rehydrated.list()).toEqual([entry]);
  });

  it("stores per-bot under a namespaced key", async () => {
    const storage = createMemoryStorage();
    const store = createMemoryStore("bot-9", storage);
    store.remember("a fact");
    await Promise.resolve();
    expect(await storage.get<MemoryEntry[]>(memoryStorageKey("bot-9"))).toHaveLength(1);
    expect(await storage.get(memoryStorageKey("bot-1"))).toBeNull();
  });

  it("forget removes case-insensitive substring matches and returns them", () => {
    const store = createMemoryStore("bot-1", createMemoryStorage());
    store.remember("Use the old pricing sheet for legacy accounts");
    const kept = store.remember("Greet clients by first name");
    store.remember("The OLD PRICING sheet lives in Drive");

    const removed = store.forget("old pricing");

    expect(removed.map((e) => e.text)).toEqual([
      "Use the old pricing sheet for legacy accounts",
      "The OLD PRICING sheet lives in Drive",
    ]);
    expect(store.list()).toEqual([kept]);
    expect(store.forget("no such thing")).toEqual([]);
  });

  it("editEntry updates text and updatedAt; deleteEntry removes by id", () => {
    const store = createMemoryStore("bot-1", createMemoryStorage());
    const entry = store.remember("draft emails formally");

    const edited = store.editEntry(entry.id, "draft emails casually");
    expect(edited?.text).toBe("draft emails casually");
    expect(edited?.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
    expect(edited?.createdAt).toBe(entry.createdAt);
    expect(store.editEntry("nope", "x")).toBeUndefined();

    expect(store.deleteEntry(entry.id)).toBe(true);
    expect(store.deleteEntry(entry.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("notifies subscribers on every change, immediately on subscribe", () => {
    const store = createMemoryStore("bot-1", createMemoryStorage());
    const snapshots: MemoryEntry[][] = [];
    const unsubscribe = store.subscribe((entries) => snapshots.push(entries));

    const entry = store.remember("a");
    store.deleteEntry(entry.id);
    unsubscribe();
    store.remember("b");

    expect(snapshots.map((s) => s.map((e) => e.text))).toEqual([[], ["a"], []]);
  });
});

describe("composeSystemPrompt", () => {
  it("includes role, style guidance, and a MEMORY section listing entries", () => {
    const bot = makeBot();
    const store = createMemoryStore(bot.id, createMemoryStorage());
    store.remember("never contact accounts owned by Dana");
    store.remember("weekly report goes out Friday");

    const prompt = composeSystemPrompt(bot, store.list());

    expect(prompt).toContain("Scout");
    expect(prompt).toContain(bot.roleDescription);
    expect(prompt).toContain("concise");
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("- never contact accounts owned by Dana");
    expect(prompt).toContain("- weekly report goes out Friday");
  });

  it("omits the MEMORY section when there are no entries", () => {
    const prompt = composeSystemPrompt(makeBot(), []);
    expect(prompt).not.toContain("MEMORY");
  });
});

describe("memory tools", () => {
  function setup(): { registry: ToolRegistry; store: MemoryStore; ctx: ToolContext } {
    const registry = new ToolRegistry();
    const store = createMemoryStore("bot-1", createMemoryStorage());
    registerMemoryTools(registry, () => store);
    return { registry, store, ctx: { bot: makeBot(), threadId: "t1" } };
  }

  it("registers remember_memory and forget_memory as self-modify tools", () => {
    // Memory text is spliced into every later system prompt, so a note is an
    // instruction to the bot's future self — not an ordinary file write.
    // self-modify runs freely in a clean run and escalates to approval once
    // untrusted content has entered it (see policy.ESCALATE_WHEN_TAINTED).
    const { registry } = setup();
    const remember = registry.get("remember_memory");
    const forget = registry.get("forget_memory");
    expect(remember?.category).toBe("self-modify");
    expect(forget?.category).toBe("self-modify");
    expect(remember?.parameters).toMatchObject({ required: ["text"] });
    expect(forget?.parameters).toMatchObject({ required: ["query"] });
  });

  it("remember_memory writes to the bot's store; forget_memory reports removals", async () => {
    const { registry, store, ctx } = setup();

    const rememberResult = await registry
      .get("remember_memory")!
      .run({ text: "user prefers brevity" }, ctx);
    expect(rememberResult).toContain("user prefers brevity");
    expect(store.list().map((e) => e.text)).toEqual(["user prefers brevity"]);

    const forgetResult = await registry
      .get("forget_memory")!
      .run({ query: "brevity" }, ctx);
    expect(forgetResult).toContain("Forgot 1 entry");
    expect(forgetResult).toContain("user prefers brevity");
    expect(store.list()).toEqual([]);

    const missResult = await registry.get("forget_memory")!.run({ query: "zzz" }, ctx);
    expect(missResult).toContain("No memory entries matched");
  });

  it("rejects empty arguments with an error result instead of writing", async () => {
    const { registry, store, ctx } = setup();
    const result = await registry.get("remember_memory")!.run({}, ctx);
    expect(result).toContain("Error");
    expect(store.list()).toEqual([]);
  });
});
