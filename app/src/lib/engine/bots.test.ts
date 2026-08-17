import { describe, expect, it, vi } from "vitest";
import { BOTS_STORAGE_KEY, createBotsStore, type BotsStore } from "./bots";
import type { Bot, StorageLike } from "./types";

function createMockStorage() {
  const data = new Map<string, unknown>();
  const set = vi.fn((key: string, value: unknown): Promise<void> => {
    data.set(key, value);
    return Promise.resolve();
  });
  const storage: StorageLike = {
    get: <T>(key: string): Promise<T | null> =>
      Promise.resolve((data.get(key) as T | undefined) ?? null),
    set: set as StorageLike["set"],
    remove: (key: string): Promise<void> => {
      data.delete(key);
      return Promise.resolve();
    },
  };
  return { data, set, storage };
}

function setup(): {
  storage: StorageLike;
  set: ReturnType<typeof createMockStorage>["set"];
  store: BotsStore;
} {
  const { storage, set } = createMockStorage();
  const store = createBotsStore(storage);
  return { storage, set, store };
}

describe("bots store", () => {
  it("creates a bot with name, color, and role description", () => {
    const { store } = setup();
    const before = Date.now();
    const bot = store.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research accounts overnight",
    });

    expect(bot.id).toBeTruthy();
    expect(bot.name).toBe("Scout");
    expect(bot.color).toBe("#14b8a6");
    expect(bot.roleDescription).toBe("Research accounts overnight");
    expect(bot.paused).toBe(false);
    expect(bot.deletedAt).toBeNull();
    expect(bot.createdAt).toBeGreaterThanOrEqual(before);
    expect(store.getState().listBots()).toEqual([bot]);
  });

  it("drops isCoordinator (migration): never written on create, ignored on update", () => {
    // Multi-bot-collaboration redesign: the coordinator mechanism is gone —
    // every bot delegates via contact_bot. Older callers may still pass the
    // field; the store tolerates and ignores it.
    const { store } = setup();
    const ea = store.getState().createBot({
      name: "EA",
      color: "#222",
      roleDescription: "coordinate the team",
      isCoordinator: true,
      workspacePath: "/workspaces/team",
    });
    expect(ea.isCoordinator).toBeUndefined();
    expect(ea.workspacePath).toBe("/workspaces/team");

    const updated = store.getState().updateBot(ea.id, {
      isCoordinator: true,
      workspacePath: "/workspaces/scout",
    });
    expect(updated?.isCoordinator).toBeUndefined();
    expect(updated?.workspacePath).toBe("/workspaces/scout");
  });

  it("tolerates isCoordinator on bots loaded from older stores", async () => {
    const { store, storage } = setup();
    const legacy = {
      id: "legacy-1",
      name: "EA",
      color: "#222",
      roleDescription: "coordinate",
      createdAt: 1,
      paused: false,
      deletedAt: null,
      isCoordinator: true,
    };
    await storage.set(BOTS_STORAGE_KEY, [legacy]);
    await store.getState().hydrate();
    // Loads fine; the flag rides along inertly and other updates keep it.
    expect(store.getState().getBot("legacy-1")?.isCoordinator).toBe(true);
    const renamed = store.getState().updateBot("legacy-1", { name: "Atlas" });
    expect(renamed?.name).toBe("Atlas");
  });

  it("passes canBeContacted and workspacePath through create and update", () => {
    const { store } = setup();
    const plain = store.getState().createBot({
      name: "Scout",
      color: "#111",
      roleDescription: "x",
    });
    expect(plain.canBeContacted).toBeUndefined();
    expect(plain.workspacePath).toBeUndefined();

    const restricted = store.getState().createBot({
      name: "Vault",
      color: "#333",
      roleDescription: "sensitive work",
      canBeContacted: false,
    });
    expect(restricted.canBeContacted).toBe(false);
    const reopened = store.getState().updateBot(restricted.id, { canBeContacted: true });
    expect(reopened?.canBeContacted).toBe(true);
  });

  it("assigns unique ids", () => {
    const { store } = setup();
    const a = store.getState().createBot({ name: "A", color: "#111", roleDescription: "a" });
    const b = store.getState().createBot({ name: "B", color: "#222", roleDescription: "b" });
    expect(a.id).not.toBe(b.id);
  });

  it("updates a bot's fields", () => {
    const { store } = setup();
    const bot = store.getState().createBot({ name: "Scout", color: "#111", roleDescription: "x" });
    const updated = store.getState().updateBot(bot.id, {
      name: "Pathfinder",
      color: "#f97316",
      paused: true,
    });

    expect(updated?.name).toBe("Pathfinder");
    expect(updated?.color).toBe("#f97316");
    expect(updated?.paused).toBe(true);
    expect(store.getState().getBot(bot.id)?.name).toBe("Pathfinder");
  });

  it("returns undefined when updating a nonexistent bot", () => {
    const { store } = setup();
    expect(store.getState().updateBot("nope", { name: "X" })).toBeUndefined();
  });

  it("soft-deletes a bot: excluded from listBots but still retrievable", () => {
    const { store } = setup();
    const bot = store.getState().createBot({ name: "Scout", color: "#111", roleDescription: "x" });
    store.getState().softDeleteBot(bot.id);

    expect(store.getState().listBots()).toEqual([]);
    const deleted = store.getState().getBot(bot.id);
    expect(deleted).toBeDefined();
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
  });

  it("restores a soft-deleted bot with its configuration intact", () => {
    const { store } = setup();
    const bot = store.getState().createBot({ name: "Scout", color: "#111", roleDescription: "x" });
    store.getState().softDeleteBot(bot.id);
    store.getState().restoreBot(bot.id);

    const restored = store.getState().getBot(bot.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.name).toBe("Scout");
    expect(restored?.roleDescription).toBe("x");
    expect(store.getState().listBots()).toHaveLength(1);
  });

  it("persists mutations to storage under the bots key", () => {
    const { set, store } = setup();
    const bot = store.getState().createBot({ name: "Scout", color: "#111", roleDescription: "x" });

    expect(set).toHaveBeenCalledWith(BOTS_STORAGE_KEY, [expect.objectContaining({ id: bot.id })]);

    store.getState().softDeleteBot(bot.id);
    const calls = set.mock.calls;
    const lastSaved = calls[calls.length - 1]?.[1] as Bot[];
    expect(lastSaved[0]?.deletedAt).toEqual(expect.any(Number));
  });

  it("hydrates from storage, including soft-deleted bots", async () => {
    const { storage, store } = setup();
    const kept = store.getState().createBot({ name: "Keep", color: "#111", roleDescription: "k" });
    const gone = store.getState().createBot({ name: "Gone", color: "#222", roleDescription: "g" });
    store.getState().softDeleteBot(gone.id);

    // A fresh store over the same storage sees the persisted roster.
    const rehydrated = createBotsStore(storage);
    expect(rehydrated.getState().hydrated).toBe(false);
    await rehydrated.getState().hydrate();

    expect(rehydrated.getState().hydrated).toBe(true);
    expect(rehydrated.getState().listBots().map((b) => b.id)).toEqual([kept.id]);
    expect(rehydrated.getState().getBot(gone.id)?.deletedAt).toEqual(expect.any(Number));
  });

  it("hydrates to an empty roster when storage has nothing", async () => {
    const { store } = setup();
    await store.getState().hydrate();
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().listBots()).toEqual([]);
  });

  it("hydrates bots saved without a toolPolicy to the allow-all default (migration)", async () => {
    const { storage } = createMockStorage();
    // A bot persisted before tool policies existed has no toolPolicy field.
    await storage.set(BOTS_STORAGE_KEY, [
      {
        id: "old-bot",
        name: "Elder",
        color: "#333",
        roleDescription: "predates policies",
        createdAt: 1,
        paused: false,
        deletedAt: null,
      },
    ]);
    const store = createBotsStore(storage);
    await store.getState().hydrate();
    const bot = store.getState().getBot("old-bot");
    expect(bot).toBeDefined();
    expect(bot?.toolPolicy).toBeUndefined();
  });

  it("persists a toolPolicy set at creation and via updateBot", async () => {
    const { storage, store } = setup();
    const created = store.getState().createBot({
      name: "Restricted",
      color: "#444",
      roleDescription: "no shell",
      toolPolicy: { categories: { "shell-local": "deny" } },
    });
    expect(created.toolPolicy).toEqual({ categories: { "shell-local": "deny" } });

    store.getState().updateBot(created.id, {
      toolPolicy: { tools: { web_fetch: "deny" } },
    });

    const rehydrated = createBotsStore(storage);
    await rehydrated.getState().hydrate();
    expect(rehydrated.getState().getBot(created.id)?.toolPolicy).toEqual({
      tools: { web_fetch: "deny" },
    });
  });
});
