import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  createInstanceRegistry,
  MAX_INSTANCES_PER_BOT,
  mergeHistoryStorageKey,
  type InstanceRegistry,
  type MergeRecord,
} from "./instances";
import { createMemoryStore, type MemoryStore } from "./memory";
import { createRuntime, type RuntimeStore } from "./runtime";
import type { StorageLike } from "./types";

interface Setup {
  storage: StorageLike;
  canonical: MemoryStore;
  runtime: RuntimeStore;
  registry: InstanceRegistry;
}

function setup(now?: () => number): Setup {
  const storage = createMemoryStorage();
  const canonical = createMemoryStore("bot-1", storage);
  const runtime = createRuntime();
  const registry = createInstanceRegistry({
    getCanonicalStore: () => canonical,
    runtime,
    storage: () => storage,
    ...(now !== undefined ? { now } : {}),
  });
  return { storage, canonical, runtime, registry };
}

const PARENT = { id: "bot-1", name: "Scout" };

describe("instance spawn", () => {
  it("spawns with a deep-copied memory snapshot — instance writes never touch canonical until merge", () => {
    const { canonical, registry } = setup();
    canonical.remember("dana owns northwest accounts");

    const spawned = registry.spawn(PARENT);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const { instanceId } = spawned.instance;
    const memory = registry.memoryOf(instanceId)!;

    // The instance starts from the snapshot...
    expect(memory.list().map((e) => e.text)).toEqual(["dana owns northwest accounts"]);
    // ...and its writes are isolated (snapshot isolation).
    memory.remember("acme prefers quarterly billing");
    expect(memory.list()).toHaveLength(2);
    expect(canonical.list()).toHaveLength(1);
    // Canonical writes after spawn do not leak into the instance either.
    canonical.remember("new canonical fact");
    expect(memory.list()).toHaveLength(2);
  });

  it("gets its own runtime entry keyed by instanceId with parentBotId for badging", () => {
    const { runtime, registry } = setup();
    const spawned = registry.spawn(PARENT, { delegationId: "delegation-9" });
    if (!spawned.ok) throw new Error("spawn refused");
    const { instanceId } = spawned.instance;

    // Runtime state flows under the instance's own key (handoff at spawn).
    expect(runtime.getState(instanceId)).toBe("handoff");
    runtime.setBusyState(instanceId, "working");
    expect(runtime.getState(instanceId)).toBe("working");
    expect(runtime.getState("bot-1")).toBe("idle"); // canonical bot undisturbed

    // UI badging: the registry links the instance to its canonical bot.
    expect(registry.get(instanceId)).toMatchObject({
      instanceId,
      parentBotId: "bot-1",
      parentBotName: "Scout",
      delegationId: "delegation-9",
      state: "running",
    });
    expect(registry.list("bot-1").map((i) => i.instanceId)).toEqual([instanceId]);
  });

  it("caps concurrent instances at 3 per bot", () => {
    const { registry } = setup();
    expect(MAX_INSTANCES_PER_BOT).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(registry.spawn(PARENT).ok).toBe(true);
    }
    expect(registry.spawn(PARENT)).toEqual({ ok: false, reason: "instance-cap" });
    // A different bot is unaffected.
    expect(registry.spawn({ id: "bot-2", name: "Mailer" }).ok).toBe(true);
    // Settling one frees capacity.
    const first = registry.list("bot-1")[0]!;
    registry.complete(first.instanceId);
    expect(registry.spawn(PARENT).ok).toBe(true);
  });
});

describe("instance memory merge-back", () => {
  it("adds new entries, dedupes against canonical, and skips unchanged entries", () => {
    const { canonical, registry } = setup();
    canonical.remember("existing fact");
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    const memory = registry.memoryOf(spawned.instance.instanceId)!;

    memory.remember("new learning from the delegation");
    memory.remember("Existing Fact  "); // duplicate of canonical (normalized)

    const record = registry.complete(spawned.instance.instanceId)!;
    expect(canonical.list().map((e) => e.text)).toEqual([
      "existing fact",
      "new learning from the delegation",
    ]);
    expect(record).toMatchObject({
      botId: "bot-1",
      instanceId: spawned.instance.instanceId,
      added: 1,
      updated: 0,
      removed: 0,
      skippedDuplicates: 1,
      conflicts: [],
    });
  });

  it("applies instance edits cleanly when canonical is unchanged", () => {
    const { canonical, registry } = setup();
    const entry = canonical.remember("pricing sheet: January");
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    const memory = registry.memoryOf(spawned.instance.instanceId)!;
    memory.editEntry(entry.id, "pricing sheet: March");

    const record = registry.complete(spawned.instance.instanceId)!;
    expect(canonical.list().map((e) => e.text)).toEqual(["pricing sheet: March"]);
    expect(record.updated).toBe(1);
    expect(record.conflicts).toEqual([]);
  });

  it("resolves conflicting edits newest-wins and appends a conflict record with both versions", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { canonical, registry } = setup();
      const entry = canonical.remember("contact window: mornings");
      const spawned = registry.spawn(PARENT);
      if (!spawned.ok) throw new Error("spawn refused");
      const memory = registry.memoryOf(spawned.instance.instanceId)!;

      // Canonical bot edits at t=2000, the instance edits later at t=3000.
      vi.setSystemTime(2_000);
      canonical.editEntry(entry.id, "contact window: afternoons");
      vi.setSystemTime(3_000);
      memory.editEntry(entry.id, "contact window: evenings only");

      vi.setSystemTime(4_000);
      const record = registry.complete(spawned.instance.instanceId)!;

      // Newest (instance, t=3000) wins.
      expect(canonical.list().map((e) => e.text)).toEqual(["contact window: evenings only"]);
      expect(record.conflicts).toEqual([
        {
          entryId: entry.id,
          keptVersion: { text: "contact window: evenings only", updatedAt: 3_000 },
          discardedVersion: { text: "contact window: afternoons", updatedAt: 2_000 },
          at: 4_000,
          instanceId: spawned.instance.instanceId,
        },
      ]);

      // ...and the merge-history store the memory panel reads has the record.
      expect(registry.mergeHistoryOf("bot-1")).toEqual([record]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the canonical edit when it is newer than the instance's (newest-wins both ways)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { canonical, registry } = setup();
      const entry = canonical.remember("v1");
      const spawned = registry.spawn(PARENT);
      if (!spawned.ok) throw new Error("spawn refused");
      const memory = registry.memoryOf(spawned.instance.instanceId)!;

      vi.setSystemTime(2_000);
      memory.editEntry(entry.id, "instance version");
      vi.setSystemTime(3_000);
      canonical.editEntry(entry.id, "canonical newer version");

      const record = registry.complete(spawned.instance.instanceId)!;
      expect(canonical.list().map((e) => e.text)).toEqual(["canonical newer version"]);
      expect(record.updated).toBe(0);
      expect(record.conflicts[0]).toMatchObject({
        entryId: entry.id,
        keptVersion: { text: "canonical newer version", updatedAt: 3_000 },
        discardedVersion: { text: "instance version", updatedAt: 2_000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("merge is atomic: one replaceAll application, persisted once", async () => {
    const { storage, canonical, registry } = setup();
    canonical.remember("base");
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    const memory = registry.memoryOf(spawned.instance.instanceId)!;
    memory.remember("added A");
    memory.remember("added B");

    const notifications: number[] = [];
    const unsubscribe = canonical.subscribe((entries) => notifications.push(entries.length));
    notifications.length = 0; // drop the immediate snapshot call
    registry.complete(spawned.instance.instanceId);
    unsubscribe();

    expect(notifications).toEqual([3]); // a single atomic list replacement
    await Promise.resolve(); // flush async persist
    const record = registry.mergeHistoryOf("bot-1")[0]!;
    const persisted = await storage.get<MergeRecord[]>(mergeHistoryStorageKey("bot-1"));
    expect(persisted).toEqual([record]);
  });

  it("a crashed/aborted instance merges NOTHING", () => {
    const { canonical, registry } = setup();
    canonical.remember("only fact");
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    const memory = registry.memoryOf(spawned.instance.instanceId)!;
    memory.remember("dies with the instance");

    registry.abort(spawned.instance.instanceId);

    expect(canonical.list().map((e) => e.text)).toEqual(["only fact"]);
    expect(registry.mergeHistoryOf("bot-1")).toEqual([]);
    expect(registry.get(spawned.instance.instanceId)?.state).toBe("aborted");
    // Settlement is final: completing afterwards still merges nothing.
    expect(registry.complete(spawned.instance.instanceId)).toBeUndefined();
    expect(canonical.list()).toHaveLength(1);
  });

  it("complete is idempotent — a second call does not merge twice", () => {
    const { canonical, registry } = setup();
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    registry.memoryOf(spawned.instance.instanceId)!.remember("once");

    expect(registry.complete(spawned.instance.instanceId)).toBeDefined();
    expect(registry.complete(spawned.instance.instanceId)).toBeUndefined();
    expect(canonical.list()).toHaveLength(1);
    expect(registry.mergeHistoryOf("bot-1")).toHaveLength(1);
  });
});

describe("haltInstances (canonical pause/delete)", () => {
  it("halts every running instance of the bot without merging, and aborts their signals", () => {
    const { canonical, runtime, registry } = setup();
    const a = registry.spawn(PARENT);
    const b = registry.spawn(PARENT);
    if (!a.ok || !b.ok) throw new Error("spawn refused");
    registry.memoryOf(a.instance.instanceId)!.remember("in-flight learning");
    const signalA = registry.signalOf(a.instance.instanceId)!;

    const halted = registry.haltAll("bot-1");

    expect(halted).toBe(2);
    expect(signalA.aborted).toBe(true);
    expect(registry.listRunning("bot-1")).toEqual([]);
    expect(registry.get(a.instance.instanceId)?.state).toBe("aborted");
    expect(registry.get(b.instance.instanceId)?.state).toBe("aborted");
    expect(canonical.list()).toEqual([]); // interrupted work merges nothing
    expect(runtime.getState(a.instance.instanceId)).toBe("idle"); // entry cleared
  });

  it("completed work merged BEFORE the halt stays applied", () => {
    const { canonical, registry } = setup();
    const done = registry.spawn(PARENT);
    const live = registry.spawn(PARENT);
    if (!done.ok || !live.ok) throw new Error("spawn refused");
    registry.memoryOf(done.instance.instanceId)!.remember("finished learning");
    registry.complete(done.instance.instanceId);
    registry.memoryOf(live.instance.instanceId)!.remember("unfinished learning");

    expect(registry.haltAll("bot-1")).toBe(1); // only the live one halts
    expect(canonical.list().map((e) => e.text)).toEqual(["finished learning"]);
  });
});

describe("merge history hydration and subscription", () => {
  it("hydrates persisted history and notifies subscribers on append", async () => {
    const { storage, registry } = setup();
    const prior: MergeRecord = {
      id: "merge-old",
      botId: "bot-1",
      instanceId: "instance-old",
      at: 1,
      added: 1,
      updated: 0,
      removed: 0,
      skippedDuplicates: 0,
      conflicts: [],
    };
    await storage.set(mergeHistoryStorageKey("bot-1"), [prior]);
    await registry.hydrateMergeHistory("bot-1");
    expect(registry.mergeHistoryOf("bot-1")).toEqual([prior]);

    const seen: MergeRecord[][] = [];
    registry.subscribeMergeHistory("bot-1", (records) => seen.push(records));
    const spawned = registry.spawn(PARENT);
    if (!spawned.ok) throw new Error("spawn refused");
    registry.memoryOf(spawned.instance.instanceId)!.remember("newer");
    registry.complete(spawned.instance.instanceId);

    expect(seen[0]).toEqual([prior]); // immediate snapshot
    expect(seen[1]).toHaveLength(2); // append notification
  });
});
