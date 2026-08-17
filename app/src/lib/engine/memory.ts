// Per-bot long-term memory (bot-memory spec, lite subset: durable entries,
// remember/forget tools, transparency via list/edit/delete for the panel).
import { getEngineStorage } from "./bots";
import { buildSystemPrompt } from "./engine";
import { makeId } from "./id";
import { enabledSkills, renderSkillsSection, type SkillPack } from "./skills";
import type { EngineTool, ToolContext } from "./tools";
import type { ToolRegistry } from "./tools";
import type { Bot, StorageLike } from "./types";

export interface MemoryEntry {
  id: string;
  text: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; equals createdAt until edited. */
  updatedAt: number;
}

export const memoryStorageKey = (botId: string): string => `engine.memory.${botId}`;

export type MemoryListener = (entries: MemoryEntry[]) => void;

export interface MemoryStore {
  readonly botId: string;
  /** Load persisted entries. Safe to call more than once. */
  hydrate(): Promise<void>;
  /** All entries, oldest first. */
  list(): MemoryEntry[];
  /** Append a new entry and persist. */
  remember(text: string): MemoryEntry;
  /** Edit an entry's text (panel API); bumps updatedAt. */
  editEntry(id: string, text: string): MemoryEntry | undefined;
  /** Delete a single entry by id (panel API). Effective immediately. */
  deleteEntry(id: string): boolean;
  /**
   * Remove every entry whose text contains `query` (case-insensitive
   * substring). Returns the removed entries so the bot can confirm what
   * changed ("forget that" — bot-memory spec).
   */
  forget(query: string): MemoryEntry[];
  /**
   * Atomically replace the whole entry list (single persist + notify).
   * Used by the ephemeral-instance merge-back (bot-memory spec, "Instance
   * memory merge" — merges are atomic).
   */
  replaceAll(entries: MemoryEntry[]): void;
  /** Subscribe to the entry list. Fires immediately, then on every change. */
  subscribe(listener: MemoryListener): () => void;
}

export interface CreateMemoryStoreOptions {
  /**
   * Seed entries present before hydrate() (deep-copied). Used for ephemeral
   * instance stores spawned from a canonical bot's memory snapshot.
   */
  initialEntries?: MemoryEntry[];
}

export function createMemoryStore(
  botId: string,
  storage: StorageLike,
  options: CreateMemoryStoreOptions = {},
): MemoryStore {
  let entries: MemoryEntry[] = (options.initialEntries ?? []).map((e) => ({ ...e }));
  const listeners = new Set<MemoryListener>();

  const notify = (): void => {
    for (const cb of [...listeners]) cb([...entries]);
  };

  const persist = (): void => {
    void storage.set(memoryStorageKey(botId), entries).catch((err: unknown) => {
      console.error(`[engine] failed to persist memory for bot ${botId}:`, err);
    });
  };

  return {
    botId,

    hydrate: async () => {
      const stored = await storage.get<MemoryEntry[]>(memoryStorageKey(botId));
      // Nothing persisted keeps the current (possibly seeded) entries.
      entries = stored ?? entries;
      notify();
    },

    list: () => [...entries],

    remember: (text) => {
      const now = Date.now();
      const entry: MemoryEntry = { id: makeId("mem"), text, createdAt: now, updatedAt: now };
      entries = [...entries, entry];
      persist();
      notify();
      return entry;
    },

    editEntry: (id, text) => {
      let updated: MemoryEntry | undefined;
      entries = entries.map((e) => {
        if (e.id !== id) return e;
        updated = { ...e, text, updatedAt: Date.now() };
        return updated;
      });
      if (!updated) return undefined;
      persist();
      notify();
      return updated;
    },

    deleteEntry: (id) => {
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return false;
      entries = next;
      persist();
      notify();
      return true;
    },

    forget: (query) => {
      const q = query.toLowerCase();
      const removed = entries.filter((e) => e.text.toLowerCase().includes(q));
      if (removed.length === 0) return [];
      entries = entries.filter((e) => !e.text.toLowerCase().includes(q));
      persist();
      notify();
      return removed;
    },

    replaceAll: (next) => {
      entries = next.map((e) => ({ ...e }));
      persist();
      notify();
    },

    subscribe: (listener) => {
      listeners.add(listener);
      listener([...entries]);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-bot store cache (panel + tools share the same instance per bot).
// ---------------------------------------------------------------------------

const memoryStores = new Map<string, MemoryStore>();

/**
 * Get (or lazily create) the shared memory store for a bot, backed by the
 * engine storage adapter. Callers should await hydrateMemory(botId) (or
 * store.hydrate()) before first read after startup.
 */
export function getMemoryStore(botId: string, storage?: StorageLike): MemoryStore {
  let store = memoryStores.get(botId);
  if (!store) {
    store = createMemoryStore(botId, storage ?? getEngineStorage());
    memoryStores.set(botId, store);
  }
  return store;
}

/** Hydrate (and return) a bot's shared memory store. */
export async function hydrateMemory(botId: string): Promise<MemoryStore> {
  const store = getMemoryStore(botId);
  await store.hydrate();
  return store;
}

/** Drop cached per-bot stores (tests, or after switching storage adapters). */
export function resetMemoryStores(): void {
  memoryStores.clear();
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the full system prompt: role description + style guidance
 * (buildSystemPrompt), a MEMORY section listing the bot's entries, and —
 * when the run carries authored skills — a SKILLS section (bounded by the
 * skills character budget; see skills.ts).
 */
export function composeSystemPrompt(
  bot: Bot,
  memory: MemoryEntry[],
  skills?: SkillPack[],
): string {
  let prompt = buildSystemPrompt(bot);
  if (memory.length > 0) {
    const lines = memory.map((e) => `- ${e.text}`).join("\n");
    prompt =
      `${prompt}\n\nMEMORY — durable notes you have saved across sessions. ` +
      `Apply them without being reminded:\n${lines}`;
  }
  if (skills !== undefined && skills.length > 0) {
    const section = renderSkillsSection(enabledSkills(bot, skills));
    if (section !== "") prompt = `${prompt}\n\n${section}`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Auto-registered memory tools (non-gated: memory writes are reversible and
// fully user-visible in the memory panel).
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * Register remember_memory / forget_memory on a registry. `getStore` defaults
 * to the shared per-bot store cache. A run that carries its own memory store
 * in the tool context (ctx.memory — set by runLoop for ephemeral-instance
 * runs) writes there instead, so instance memory stays isolated from the
 * canonical store until merge-back (bot-memory spec, "Instance memory merge").
 */
export function registerMemoryTools(
  registry: ToolRegistry,
  getStore: (botId: string) => MemoryStore = (botId) => getMemoryStore(botId),
): void {
  const storeFor = (ctx: ToolContext): MemoryStore =>
    ctx.memory ?? getStore(ctx.bot.id);

  const remember: EngineTool = {
    name: "remember_memory",
    description:
      "Save a durable note to your long-term memory (a user preference, " +
      "correction, decision, or project fact you should apply in future sessions).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to remember, one concise sentence." },
      },
      required: ["text"],
    },
    // Not "workspace-mutate": memory text is spliced into EVERY later
    // system prompt, so a note is an instruction to the bot's future self.
    // self-modify escalates to approval once untrusted content has entered
    // the run, which is what stops a hostile page from persisting standing
    // orders (security spec, prompt-injection defenses).
    category: "self-modify",
    run: (args, ctx: ToolContext) => {
      const text = stringArg(args, "text").trim();
      if (text.length === 0) return "Error: remember_memory requires non-empty text.";
      storeFor(ctx).remember(text);
      return `Remembered: "${text}"`;
    },
  };

  const forget: EngineTool = {
    name: "forget_memory",
    description:
      "Remove memory entries whose text contains the given substring " +
      "(case-insensitive). Returns what was removed so you can confirm to the user.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring identifying the entries to forget." },
      },
      required: ["query"],
    },
    category: "self-modify",
    run: (args, ctx: ToolContext) => {
      const query = stringArg(args, "query").trim();
      if (query.length === 0) return "Error: forget_memory requires a non-empty query.";
      const removed = storeFor(ctx).forget(query);
      if (removed.length === 0) return `No memory entries matched "${query}".`;
      const lines = removed.map((e) => `- ${e.text}`).join("\n");
      return `Forgot ${removed.length} ${removed.length === 1 ? "entry" : "entries"}:\n${lines}`;
    },
  };

  registry.register(remember);
  registry.register(forget);
}
