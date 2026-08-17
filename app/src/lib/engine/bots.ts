// Bot CRUD store (zustand) with soft delete/restore, persisted via the
// storage interface (see StorageLike in types.ts).
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Bot, StorageLike } from "./types";

export const BOTS_STORAGE_KEY = "engine.bots";

export interface CreateBotInput {
  name: string;
  color: string;
  roleDescription: string;
  /**
   * @deprecated Ignored — the coordinator mechanism was dropped (multi-bot-
   * collaboration redesign: every bot delegates via contact_bot). Accepted
   * so older callers still compile; never written to new bots.
   */
  isCoordinator?: boolean;
  /** Per-bot delegation restriction; absent means contactable. */
  canBeContacted?: boolean;
  /** Workspace path passthrough for integrations. */
  workspacePath?: string;
  /**
   * Per-bot tool policy (tool-extensibility spec). Absent means platform
   * defaults: every registered tool visible, category gating applies.
   */
  toolPolicy?: Bot["toolPolicy"];
}

/**
 * Note: `isCoordinator` remains accepted in patches for older callers but is
 * IGNORED (stripped before applying) — the field is tolerated on load from
 * older stores and never updated. See the multi-bot-collaboration redesign.
 */
export type UpdateBotPatch = Partial<
  Pick<
    Bot,
    | "name"
    | "color"
    | "roleDescription"
    | "paused"
    | "isCoordinator"
    | "canBeContacted"
    | "workspacePath"
    | "toolPolicy"
    | "enabledSkills"
  >
>;

export interface BotsState {
  /** All bots, including soft-deleted ones (needed for restore). */
  bots: Bot[];
  /** True once hydrate() has loaded persisted bots. */
  hydrated: boolean;
  /** Load bots from storage. Safe to call more than once. */
  hydrate: () => Promise<void>;
  createBot: (input: CreateBotInput) => Bot;
  updateBot: (id: string, patch: UpdateBotPatch) => Bot | undefined;
  /** Marks the bot deleted (deletedAt = now). It disappears from listBots. */
  softDeleteBot: (id: string) => void;
  /** Clears deletedAt, returning the bot to the active roster. */
  restoreBot: (id: string) => void;
  /** Active bots only — soft-deleted bots are excluded. */
  listBots: () => Bot[];
  /** Looks up any bot by id, including soft-deleted ones. */
  getBot: (id: string) => Bot | undefined;
}

export type BotsStore = UseBoundStore<StoreApi<BotsState>>;

/** In-memory storage adapter; default until integration wires src/lib/storage. */
export function createMemoryStorage(): StorageLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve((data.get(key) as T | undefined) ?? null),
    set: <T>(key: string, value: T) => {
      data.set(key, value);
      return Promise.resolve();
    },
    remove: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

let activeStorage: StorageLike = createMemoryStorage();

/**
 * Swap the storage adapter used by the default `useBotsStore`.
 * Integration calls this with the real src/lib/storage implementation,
 * then awaits `useBotsStore.getState().hydrate()`.
 */
export function configureEngineStorage(storage: StorageLike): void {
  activeStorage = storage;
}

/** The storage adapter currently backing the engine (bots, memory). */
export function getEngineStorage(): StorageLike {
  return activeStorage;
}

function makeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createBotsStoreWith(getStorage: () => StorageLike): BotsStore {
  const persist = (bots: Bot[]): void => {
    void getStorage()
      .set(BOTS_STORAGE_KEY, bots)
      .catch((err: unknown) => {
        console.error("[engine] failed to persist bots:", err);
      });
  };

  return create<BotsState>()((set, get) => ({
    bots: [],
    hydrated: false,

    hydrate: async () => {
      const stored = await getStorage().get<Bot[]>(BOTS_STORAGE_KEY);
      set({ bots: stored ?? [], hydrated: true });
    },

    createBot: (input) => {
      // Migration note: isCoordinator is no longer written — the coordinator
      // mechanism was dropped (every bot can delegate). The field is still
      // tolerated on bots loaded from older stores, where it is ignored.
      const bot: Bot = {
        id: makeId(),
        name: input.name,
        color: input.color,
        roleDescription: input.roleDescription,
        createdAt: Date.now(),
        paused: false,
        deletedAt: null,
        ...(input.canBeContacted !== undefined
          ? { canBeContacted: input.canBeContacted }
          : {}),
        ...(input.workspacePath !== undefined
          ? { workspacePath: input.workspacePath }
          : {}),
        ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
      };
      const bots = [...get().bots, bot];
      set({ bots });
      persist(bots);
      return bot;
    },

    updateBot: (id, patch) => {
      // isCoordinator is tolerated in patches but ignored (dropped field).
      const { isCoordinator: _ignored, ...applied } = patch;
      let updated: Bot | undefined;
      const bots = get().bots.map((b) => {
        if (b.id !== id) return b;
        updated = { ...b, ...applied };
        return updated;
      });
      if (!updated) return undefined;
      set({ bots });
      persist(bots);
      return updated;
    },

    softDeleteBot: (id) => {
      const bots = get().bots.map((b) =>
        b.id === id && !b.deletedAt ? { ...b, deletedAt: Date.now() } : b,
      );
      set({ bots });
      persist(bots);
    },

    restoreBot: (id) => {
      const bots = get().bots.map((b) =>
        b.id === id ? { ...b, deletedAt: null } : b,
      );
      set({ bots });
      persist(bots);
    },

    listBots: () => get().bots.filter((b) => !b.deletedAt),

    getBot: (id) => get().bots.find((b) => b.id === id),
  }));
}

/** Build an isolated bots store bound to a specific storage adapter (tests). */
export function createBotsStore(storage: StorageLike): BotsStore {
  return createBotsStoreWith(() => storage);
}

/** App-wide bots store. Uses whatever adapter configureEngineStorage set. */
export const useBotsStore: BotsStore = createBotsStoreWith(() => activeStorage);
