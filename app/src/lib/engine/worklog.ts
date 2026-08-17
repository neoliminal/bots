// Per-bot append-only work record store (multi-bot-collaboration spec,
// "Capability cards"): the platform-derived ground truth that experience
// summaries are compiled from. Bots never author this record — the engine
// appends an entry when a piece of work completes.
//
// Ownership note: this module only depends on the narrow StorageLike shape
// and the engine storage accessor; it defines no behavior for other engine
// files and is safe to call from the loop/delegation layers as a pure API.
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import type { StorageLike } from "./types";

/** Input recorded when a bot completes a unit of work. */
export interface CompletedWorkInput {
  /** Short human title of the finished task ("Process March invoices"). */
  taskTitle: string;
  /** Thread the work happened in (delegations record their own thread). */
  threadId: string;
  /** Names of tools invoked while doing the work. */
  toolsUsed: string[];
  /** Artifacts/files/outputs produced. */
  deliverables: string[];
  /** A correction the bot learned during the work, if any. */
  learnedCorrection?: string;
  /** Epoch milliseconds when the work completed. */
  at: number;
}

/** A persisted work record (input plus a stable id). */
export interface WorkRecord extends CompletedWorkInput {
  id: string;
}

/** Bounded retention: only the latest entries per bot are kept. */
export const MAX_WORKLOG_ENTRIES = 200;

export const worklogStorageKey = (botId: string): string => `engine.worklog.${botId}`;

// ---------------------------------------------------------------------------
// Task-category taxonomy (keyword clusters, same style as the role library in
// src/app/roleSuggestions.ts). First matching cluster wins; unmatched work
// falls into the "general" bucket.
// ---------------------------------------------------------------------------

export interface WorkCategory {
  id: string;
  /** Past-tense phrase used when compiling experience summaries. */
  summary: string;
  /** Lowercase keywords matched (substring) against the task title. */
  keywords: readonly string[];
}

export const GENERAL_CATEGORY_ID = "general";

/** Keyword clusters for inferring what kind of work a task title describes. */
export const WORK_CATEGORIES: readonly WorkCategory[] = [
  {
    id: "invoice-processing",
    summary: "processed invoices",
    keywords: ["invoice", "expense", "receipt", "reimburs", "billing"],
  },
  {
    id: "research",
    summary: "researched topics",
    keywords: ["research", "investigate", "look into", "look up", "compare", "analyz", "analysis"],
  },
  {
    id: "outreach",
    summary: "ran outreach",
    keywords: ["outreach", "prospect", "cold email", "follow up", "follow-up", "lead", "pipeline"],
  },
  {
    id: "support-triage",
    summary: "triaged support",
    keywords: ["support", "ticket", "triage", "customer issue", "bug report", "complaint"],
  },
  {
    id: "scheduling",
    summary: "coordinated schedules",
    keywords: ["schedule", "calendar", "meeting", "agenda", "coordinate"],
  },
  {
    id: "writing",
    summary: "drafted content",
    keywords: ["draft", "write", "wrote", "blog", "newsletter", "announcement", "social post", "copy"],
  },
  {
    id: "reporting",
    summary: "built reports",
    keywords: ["report", "metrics", "dashboard", "spreadsheet", "csv", "chart", "data"],
  },
];

/** Infer the category id for a task title (GENERAL_CATEGORY_ID when no cluster matches). */
export function inferTaskCategory(taskTitle: string): string {
  const text = taskTitle.toLowerCase();
  for (const category of WORK_CATEGORIES) {
    if (category.keywords.some((kw) => text.includes(kw))) return category.id;
  }
  return GENERAL_CATEGORY_ID;
}

/** Human phrase for a category id ("processed invoices"). */
export function categorySummary(categoryId: string): string {
  const category = WORK_CATEGORIES.find((c) => c.id === categoryId);
  return category ? category.summary : "completed tasks";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type WorklogListener = (records: WorkRecord[]) => void;

export interface WorklogStore {
  readonly botId: string;
  /** Load persisted records. Idempotent; records made pre-hydrate are kept. */
  hydrate(): Promise<void>;
  /** All records, oldest first. */
  list(): WorkRecord[];
  /** Append a completed-work record (trims to MAX_WORKLOG_ENTRIES) and persist. */
  record(input: CompletedWorkInput): WorkRecord;
  /** The latest records, newest first. */
  recent(limit?: number): WorkRecord[];
  /** Tool name -> number of records that used it. */
  countsByTool(): Record<string, number>;
  /** Inferred category id -> number of records in it. */
  countsByCategory(): Record<string, number>;
  /** Subscribe to the record list. Fires immediately, then on every change. */
  subscribe(listener: WorklogListener): () => void;
}

export function createWorklogStore(botId: string, storage: StorageLike): WorklogStore {
  let records: WorkRecord[] = [];
  let hydrated = false;
  const listeners = new Set<WorklogListener>();

  const notify = (): void => {
    for (const cb of [...listeners]) cb([...records]);
  };

  const persist = (): void => {
    void storage.set(worklogStorageKey(botId), records).catch((err: unknown) => {
      console.error(`[engine] failed to persist worklog for bot ${botId}:`, err);
    });
  };

  return {
    botId,

    hydrate: async () => {
      if (hydrated) return;
      const stored = await storage.get<WorkRecord[]>(worklogStorageKey(botId));
      hydrated = true;
      if (stored && stored.length > 0) {
        // Records appended before hydrate finished stay (after the stored ones).
        records = [...stored, ...records].slice(-MAX_WORKLOG_ENTRIES);
      }
      notify();
    },

    list: () => [...records],

    record: (input) => {
      const entry: WorkRecord = { id: makeId("work"), ...input };
      records = [...records, entry].slice(-MAX_WORKLOG_ENTRIES);
      persist();
      notify();
      return entry;
    },

    recent: (limit = 10) =>
      [...records].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit)),

    countsByTool: () => {
      const counts: Record<string, number> = {};
      for (const rec of records) {
        for (const tool of new Set(rec.toolsUsed)) {
          counts[tool] = (counts[tool] ?? 0) + 1;
        }
      }
      return counts;
    },

    countsByCategory: () => {
      const counts: Record<string, number> = {};
      for (const rec of records) {
        const category = inferTaskCategory(rec.taskTitle);
        counts[category] = (counts[category] ?? 0) + 1;
      }
      return counts;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      listener([...records]);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared per-bot store cache (engine + UI share the same instance per bot).
// ---------------------------------------------------------------------------

interface CachedWorklog {
  store: WorklogStore;
  ready: Promise<void>;
}

const worklogStores = new Map<string, CachedWorklog>();

function getCached(botId: string, storage?: StorageLike): CachedWorklog {
  let cached = worklogStores.get(botId);
  if (!cached) {
    const store = createWorklogStore(botId, storage ?? getEngineStorage());
    cached = { store, ready: store.hydrate() };
    worklogStores.set(botId, cached);
  }
  return cached;
}

/** Get (or lazily create + hydrate) the shared worklog store for a bot. */
export function getWorklogStore(botId: string, storage?: StorageLike): WorklogStore {
  return getCached(botId, storage).store;
}

/** Await hydration of (and return) a bot's shared worklog store. */
export async function hydrateWorklog(botId: string, storage?: StorageLike): Promise<WorklogStore> {
  const cached = getCached(botId, storage);
  await cached.ready;
  return cached.store;
}

/**
 * Append a completed-work record for a bot (the engine calls this when a task
 * or delegation finishes). Waits for hydration so persisted history is never
 * clobbered.
 */
export async function recordCompletedWork(
  botId: string,
  input: CompletedWorkInput,
  storage?: StorageLike,
): Promise<WorkRecord> {
  const store = await hydrateWorklog(botId, storage);
  return store.record(input);
}

/** Drop cached per-bot stores (tests, or after switching storage adapters). */
export function resetWorklogStores(): void {
  worklogStores.clear();
}
