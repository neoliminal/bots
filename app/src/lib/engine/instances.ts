// Ephemeral bot instances (multi-bot-collaboration spec — "Ephemeral
// instances instead of blocking"; bot-memory spec — "Instance memory merge").
//
// When a delegation targets a busy bot, the engine spawns an instance: same
// role/persona, a deep-copied SNAPSHOT of the bot's memory at spawn, its own
// runtime-state entry keyed by instanceId (parentBotId links it for UI
// badging), running concurrently with the canonical bot. On successful
// completion the instance's memory changes merge back atomically into the
// canonical store (new entries added and deduplicated, unchanged skipped,
// conflicting edits resolved newest-wins with a conflict record appended to
// the merge-history store the memory panel renders). A crashed or aborted
// instance merges NOTHING. Canonical pause/delete halts instances via
// haltInstances(botId).
//
// The registry owns lifecycle + state; integration (chatGlue) owns the
// actual run execution: it runs the delegated brief through runLoop with
// { instanceId, runtimeId: instanceId, memory: registry.memoryOf(instanceId) }
// and the loop settles the instance (complete on success, abort otherwise).
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import {
  createMemoryStore,
  getMemoryStore,
  type MemoryEntry,
  type MemoryStore,
} from "./memory";
import { botRuntime, type RuntimeStore } from "./runtime";
import type { StorageLike } from "./types";

/** Concurrent ephemeral instances allowed per canonical bot. */
export const MAX_INSTANCES_PER_BOT = 3;

export type InstanceState = "running" | "completed" | "aborted";

export interface BotInstance {
  instanceId: string;
  /** The canonical bot this is an instance of (UI badging). */
  parentBotId: string;
  parentBotName: string;
  /** The delegation that caused the spawn, when known. */
  delegationId?: string;
  spawnedAt: number;
  state: InstanceState;
  settledAt?: number;
}

/** One side of a merge conflict, as shown in the memory panel's history. */
export interface MemoryVersion {
  text: string;
  updatedAt: number;
}

/**
 * A conflicting edit resolved newest-wins during instance merge-back
 * (bot-memory spec — the flagged conflict the user can review/restore from).
 */
export interface MergeConflict {
  entryId: string;
  keptVersion: MemoryVersion;
  discardedVersion: MemoryVersion;
  at: number;
  instanceId: string;
}

/** One instance merge-back, appended to the bot's merge-history store. */
export interface MergeRecord {
  id: string;
  botId: string;
  instanceId: string;
  at: number;
  /** New entries the instance created that were added to the canonical store. */
  added: number;
  /** Canonical entries updated with the instance's edits. */
  updated: number;
  /** Entries the instance deleted that were removed from the canonical store. */
  removed: number;
  /** New instance entries skipped because the canonical store already had the text. */
  skippedDuplicates: number;
  conflicts: MergeConflict[];
}

export const mergeHistoryStorageKey = (botId: string): string =>
  `engine.memory.mergeHistory.${botId}`;

export type SpawnResult =
  | { ok: true; instance: BotInstance }
  | { ok: false; reason: "instance-cap" };

export type InstancesListener = (instances: BotInstance[]) => void;
export type MergeHistoryListener = (records: MergeRecord[]) => void;

export interface InstanceRegistryDeps {
  /** Canonical memory store per bot (snapshot source + merge target). */
  getCanonicalStore?: (botId: string) => MemoryStore;
  /** Runtime feed instances appear in; defaults to the shared botRuntime. */
  runtime?: RuntimeStore;
  /** Storage for the merge-history store; defaults to the engine storage. */
  storage?: () => StorageLike;
  now?: () => number;
}

export interface InstanceRegistry {
  /**
   * Spawn an ephemeral instance of `parent` from a deep copy of its current
   * canonical memory entries. Refuses (reason "instance-cap") when the bot
   * already has MAX_INSTANCES_PER_BOT running instances.
   */
  spawn(
    parent: { id: string; name: string },
    options?: { delegationId?: string },
  ): SpawnResult;
  get(instanceId: string): BotInstance | undefined;
  /** All instances (running and settled), optionally for one parent bot. */
  list(parentBotId?: string): BotInstance[];
  listRunning(parentBotId?: string): BotInstance[];
  /** The instance's isolated snapshot memory store (its run reads/writes it). */
  memoryOf(instanceId: string): MemoryStore | undefined;
  /** Aborted when the instance is halted (pause/delete/stop). */
  signalOf(instanceId: string): AbortSignal | undefined;
  /**
   * Successful completion: atomically merge the instance's memory changes
   * back into the canonical store and append a MergeRecord to the bot's
   * merge history. Idempotent — only a "running" instance merges; returns
   * undefined otherwise.
   */
  complete(instanceId: string): MergeRecord | undefined;
  /** Crashed/cancelled instance: merges NOTHING. Idempotent. */
  abort(instanceId: string): void;
  /** Halt every running instance of a bot (canonical pause/delete). */
  haltAll(parentBotId: string): number;
  /** Merge-history records for a bot, newest last (memory panel). */
  mergeHistoryOf(botId: string): MergeRecord[];
  /** Load persisted merge history for a bot. Safe to call more than once. */
  hydrateMergeHistory(botId: string): Promise<void>;
  subscribe(listener: InstancesListener): () => void;
  subscribeMergeHistory(botId: string, listener: MergeHistoryListener): () => void;
  /** Drop all instances and in-memory history (tests). */
  reset(): void;
}

const normalizeText = (text: string): string => text.trim().toLowerCase();

interface MergeResult {
  entries: MemoryEntry[];
  added: number;
  updated: number;
  removed: number;
  skippedDuplicates: number;
  conflicts: MergeConflict[];
}

/**
 * Three-way merge of an instance's memory over the canonical store's current
 * entries, using the spawn-time snapshot as the base:
 * - entries the instance created: added, unless the canonical store already
 *   has an entry with the same text (deduplicated -> skipped);
 * - entries unchanged by the instance: skipped;
 * - entries edited by the instance: applied when the canonical side is
 *   unchanged; when both sides edited, newest-wins (updatedAt) with a
 *   MergeConflict recording both versions;
 * - entries deleted by the instance: removed only when the canonical side is
 *   unchanged (a canonical edit survives an instance delete);
 * - entries the user deleted from the canonical store stay deleted.
 */
function mergeEntries(
  canonical: MemoryEntry[],
  snapshot: MemoryEntry[],
  instance: MemoryEntry[],
  instanceId: string,
  now: number,
): MergeResult {
  const snapById = new Map(snapshot.map((e) => [e.id, e]));
  const instanceById = new Map(instance.map((e) => [e.id, e]));
  const canonicalTexts = new Set(canonical.map((e) => normalizeText(e.text)));

  let next = [...canonical];
  let added = 0;
  let updated = 0;
  let removed = 0;
  let skippedDuplicates = 0;
  const conflicts: MergeConflict[] = [];

  const replaceInNext = (entry: MemoryEntry): void => {
    next = next.map((e) => (e.id === entry.id ? entry : e));
  };

  for (const entry of instance) {
    const base = snapById.get(entry.id);
    if (!base) {
      // New entry created by the instance — deduplicate against canonical.
      if (canonicalTexts.has(normalizeText(entry.text))) {
        skippedDuplicates += 1;
        continue;
      }
      next = [...next, { ...entry }];
      canonicalTexts.add(normalizeText(entry.text));
      added += 1;
      continue;
    }
    if (entry.text === base.text) continue; // unchanged — skip

    const current = next.find((e) => e.id === entry.id);
    if (!current) continue; // user deleted it canonically — deletion stands
    if (current.text === entry.text) continue; // both converged on the same text
    if (current.text === base.text) {
      // Canonical side untouched — apply the instance's edit cleanly.
      replaceInNext({ ...current, text: entry.text, updatedAt: entry.updatedAt });
      updated += 1;
      continue;
    }
    // Both sides edited the same entry: newest-wins, conflict flagged.
    const instanceWins = entry.updatedAt >= current.updatedAt;
    const kept: MemoryVersion = instanceWins
      ? { text: entry.text, updatedAt: entry.updatedAt }
      : { text: current.text, updatedAt: current.updatedAt };
    const discarded: MemoryVersion = instanceWins
      ? { text: current.text, updatedAt: current.updatedAt }
      : { text: entry.text, updatedAt: entry.updatedAt };
    conflicts.push({
      entryId: entry.id,
      keptVersion: kept,
      discardedVersion: discarded,
      at: now,
      instanceId,
    });
    if (instanceWins) {
      replaceInNext({ ...current, text: entry.text, updatedAt: entry.updatedAt });
      updated += 1;
    }
  }

  // Entries the instance deleted: remove only if canonically unchanged.
  for (const base of snapshot) {
    if (instanceById.has(base.id)) continue;
    const current = next.find((e) => e.id === base.id);
    if (current && current.text === base.text) {
      next = next.filter((e) => e.id !== base.id);
      removed += 1;
    }
  }

  return { entries: next, added, updated, removed, skippedDuplicates, conflicts };
}

interface InstanceRecord {
  record: BotInstance;
  snapshot: MemoryEntry[];
  memory: MemoryStore;
  controller: AbortController;
}

/** Null storage backing instance snapshot stores (never persisted). */
function createNullStorage(): StorageLike {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}

export function createInstanceRegistry(
  deps: InstanceRegistryDeps = {},
): InstanceRegistry {
  const getCanonicalStore =
    deps.getCanonicalStore ?? ((botId: string) => getMemoryStore(botId));
  const runtime = (): RuntimeStore => deps.runtime ?? botRuntime;
  const storage = deps.storage ?? getEngineStorage;
  const now = deps.now ?? Date.now;

  const instances = new Map<string, InstanceRecord>();
  const listeners = new Set<InstancesListener>();
  const histories = new Map<string, MergeRecord[]>();
  const historyListeners = new Map<string, Set<MergeHistoryListener>>();

  const listAll = (parentBotId?: string): BotInstance[] =>
    [...instances.values()]
      .map((i) => ({ ...i.record }))
      .filter((r) => parentBotId === undefined || r.parentBotId === parentBotId);

  const notify = (): void => {
    const all = listAll();
    for (const cb of [...listeners]) cb(all);
  };

  const historyOf = (botId: string): MergeRecord[] => histories.get(botId) ?? [];

  const notifyHistory = (botId: string): void => {
    const subs = historyListeners.get(botId);
    if (!subs) return;
    const records = [...historyOf(botId)];
    for (const cb of [...subs]) cb(records);
  };

  const appendHistory = (botId: string, record: MergeRecord): void => {
    const records = [...historyOf(botId), record];
    histories.set(botId, records);
    void storage()
      .set(mergeHistoryStorageKey(botId), records)
      .catch((err: unknown) => {
        console.error(`[engine] failed to persist merge history for ${botId}:`, err);
      });
    notifyHistory(botId);
  };

  return {
    spawn: (parent, options = {}) => {
      const running = [...instances.values()].filter(
        (i) => i.record.parentBotId === parent.id && i.record.state === "running",
      );
      if (running.length >= MAX_INSTANCES_PER_BOT) {
        return { ok: false, reason: "instance-cap" };
      }
      const instanceId = makeId("instance");
      // Deep-copy the canonical entries at spawn: the SNAPSHOT the instance
      // runs from, and the merge base. Instance writes never touch canonical
      // memory until merge-back.
      const canonicalEntries = getCanonicalStore(parent.id).list();
      const snapshot = canonicalEntries.map((e) => ({ ...e }));
      const memory = createMemoryStore(instanceId, createNullStorage(), {
        initialEntries: canonicalEntries,
      });
      const record: BotInstance = {
        instanceId,
        parentBotId: parent.id,
        parentBotName: parent.name,
        ...(options.delegationId !== undefined
          ? { delegationId: options.delegationId }
          : {}),
        spawnedAt: now(),
        state: "running",
      };
      instances.set(instanceId, {
        record,
        snapshot,
        memory,
        controller: new AbortController(),
      });
      // The instance gets its own runtime-state entry: it appears (handoff),
      // then its run drives states like a normal bot (bot-avatars flow).
      runtime().handoff(instanceId);
      notify();
      return { ok: true, instance: { ...record } };
    },

    get: (instanceId) => {
      const found = instances.get(instanceId);
      return found ? { ...found.record } : undefined;
    },

    list: (parentBotId) => listAll(parentBotId),

    listRunning: (parentBotId) =>
      listAll(parentBotId).filter((r) => r.state === "running"),

    memoryOf: (instanceId) => instances.get(instanceId)?.memory,

    signalOf: (instanceId) => instances.get(instanceId)?.controller.signal,

    complete: (instanceId) => {
      const found = instances.get(instanceId);
      if (!found || found.record.state !== "running") return undefined;
      const botId = found.record.parentBotId;
      const store = getCanonicalStore(botId);
      const at = now();
      const merge = mergeEntries(
        store.list(),
        found.snapshot,
        found.memory.list(),
        instanceId,
        at,
      );
      // Atomic apply: one replaceAll (single persist + notify) — a merge is
      // all-or-nothing (bot-memory spec).
      store.replaceAll(merge.entries);
      const record: MergeRecord = {
        id: makeId("merge"),
        botId,
        instanceId,
        at,
        added: merge.added,
        updated: merge.updated,
        removed: merge.removed,
        skippedDuplicates: merge.skippedDuplicates,
        conflicts: merge.conflicts,
      };
      appendHistory(botId, record);
      found.record.state = "completed";
      found.record.settledAt = at;
      runtime().clear(instanceId);
      notify();
      return record;
    },

    abort: (instanceId) => {
      const found = instances.get(instanceId);
      if (!found || found.record.state !== "running") return;
      found.record.state = "aborted";
      found.record.settledAt = now();
      found.controller.abort();
      runtime().clear(instanceId);
      notify();
    },

    haltAll: (parentBotId) => {
      const running = [...instances.values()].filter(
        (i) => i.record.parentBotId === parentBotId && i.record.state === "running",
      );
      for (const found of running) {
        found.record.state = "aborted";
        found.record.settledAt = now();
        found.controller.abort();
        runtime().clear(found.record.instanceId);
      }
      if (running.length > 0) notify();
      return running.length;
    },

    mergeHistoryOf: (botId) => [...historyOf(botId)],

    hydrateMergeHistory: async (botId) => {
      const stored = await storage().get<MergeRecord[]>(mergeHistoryStorageKey(botId));
      if (stored) {
        histories.set(botId, stored);
        notifyHistory(botId);
      }
    },

    subscribe: (listener) => {
      listeners.add(listener);
      listener(listAll());
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeMergeHistory: (botId, listener) => {
      let subs = historyListeners.get(botId);
      if (!subs) {
        subs = new Set();
        historyListeners.set(botId, subs);
      }
      subs.add(listener);
      listener([...historyOf(botId)]);
      return () => {
        subs.delete(listener);
        if (subs.size === 0) historyListeners.delete(botId);
      };
    },

    reset: () => {
      for (const found of instances.values()) {
        if (found.record.state === "running") found.controller.abort();
        runtime().clear(found.record.instanceId);
      }
      instances.clear();
      histories.clear();
      historyListeners.clear();
    },
  };
}

/** App-wide instance registry shared by delegation, the loop, and the UI. */
export const botInstances: InstanceRegistry = createInstanceRegistry();

/**
 * Halt every running instance of a bot — no merge for interrupted work.
 * Integration calls this from canonical pause and delete (bot-management).
 */
export function haltInstances(botId: string): number {
  return botInstances.haltAll(botId);
}
