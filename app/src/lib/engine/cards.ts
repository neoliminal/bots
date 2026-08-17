// Capability cards (multi-bot-collaboration spec, "Capability cards"):
// name + user-authored role + PLATFORM-DERIVED experience summary + live
// availability. The experience text is a deterministic compile of the bot's
// work record (see worklog.ts) — never model-authored — bounded to a hard
// character budget because cards ride in peers' model context.
//
// Also here (kept out of bots.ts by ownership): versioned card history with
// user pin/override of the experience text, and the per-bot contact
// permission side store (can-contact / can-be-contacted, default open).
import { getEngineStorage } from "./bots";
import type { BotRuntimeState, StorageLike } from "./types";
import { categorySummary, inferTaskCategory, WORK_CATEGORIES, type WorkRecord } from "./worklog";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Card-level availability (spec: idle/busy/paused/waiting-on-human). */
export type AvailabilityState = "idle" | "busy" | "paused" | "waiting-on-human";

export const AVAILABILITY_STATES: readonly AvailabilityState[] = [
  "idle",
  "busy",
  "paused",
  "waiting-on-human",
] as const;

const BUSY_RUNTIME_STATES: ReadonlySet<BotRuntimeState> = new Set([
  "thinking",
  "working",
  "talkingToUser",
  "talkingToBot",
  "handoff",
]);

/**
 * Map a runtime state + paused flag to card availability. The paused flag
 * wins over everything ("sleeping" is the runtime's paused presentation).
 */
export function deriveAvailability(state: BotRuntimeState, paused: boolean): AvailabilityState {
  if (paused || state === "sleeping") return "paused";
  if (state === "waitingOnUser") return "waiting-on-human";
  if (BUSY_RUNTIME_STATES.has(state)) return "busy";
  // idle, celebrating, error, disconnected: contactable.
  return "idle";
}

/** Narrow view of the runtime layer this module needs (injected, not imported). */
export interface AvailabilityDeps {
  /** Current runtime state for a bot (e.g. runtime.getState). */
  getRuntimeState(botId: string): BotRuntimeState;
  /** The bot's paused flag (e.g. from the bots store). */
  isPaused(botId: string): boolean;
}

/** Build a per-bot availability getter from the runtime state map + paused flag. */
export function createAvailabilityGetter(deps: AvailabilityDeps): (botId: string) => AvailabilityState {
  return (botId) => deriveAvailability(deps.getRuntimeState(botId), deps.isPaused(botId));
}

// ---------------------------------------------------------------------------
// Experience compile (deterministic — no LLM calls anywhere in this module)
// ---------------------------------------------------------------------------

/** Hard budget for the experience text (cards ride in model context). */
export const EXPERIENCE_CHAR_BUDGET = 400;

const MAX_CATEGORY_SEGMENTS = 4;
const MAX_TOOLS = 3;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function relativeAge(latestAt: number, now: number): string {
  const ms = Math.max(0, now - latestAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Taxonomy order index used as the deterministic tiebreak for categories. */
function categoryOrder(categoryId: string): number {
  const idx = WORK_CATEGORIES.findIndex((c) => c.id === categoryId);
  return idx === -1 ? WORK_CATEGORIES.length : idx;
}

/**
 * Deterministically compile an experience summary from a bot's work record:
 * task-category counts, most-used tools, learned-correction COUNT, artifact
 * count, and recency — clipped to EXPERIENCE_CHAR_BUDGET.
 *
 * SECURITY: the compiled text rides verbatim into every peer's contact_bot
 * tool description, so it must NEVER contain model-authored free text.
 * `learnedCorrection` strings originate from the model's own remember_memory
 * calls (chatGlue records them), so only their COUNT is summarized here —
 * a hostile correction can never poison teammates' capability cards. The
 * only verbatim free text a card may carry is the USER's pinned override.
 */
export function compileExperience(
  worklog: readonly WorkRecord[],
  opts: { now?: number; budget?: number } = {},
): string {
  const budget = opts.budget ?? EXPERIENCE_CHAR_BUDGET;
  if (worklog.length === 0) return clip("No completed work yet.", budget);
  const now = opts.now ?? Date.now();

  // Category counts, most frequent first, taxonomy order as tiebreak.
  const categoryCounts = new Map<string, number>();
  for (const rec of worklog) {
    const id = inferTaskCategory(rec.taskTitle);
    categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
  }
  const categories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || categoryOrder(a[0]) - categoryOrder(b[0]))
    .slice(0, MAX_CATEGORY_SEGMENTS)
    .map(([id, count]) => `${categorySummary(id)} x${count}`);

  // Most-used tools (count of records using each), alpha tiebreak.
  const toolCounts = new Map<string, number>();
  for (const rec of worklog) {
    for (const tool of new Set(rec.toolsUsed)) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
  }
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOOLS)
    .map(([name]) => name);

  // Corrections learned: count only — never the model-authored text itself
  // (see the SECURITY note above).
  const correctionCount = worklog.filter(
    (rec) => typeof rec.learnedCorrection === "string" && rec.learnedCorrection.trim() !== "",
  ).length;

  const deliverableCount = worklog.reduce((sum, rec) => sum + rec.deliverables.length, 0);
  const latestAt = worklog.reduce((max, rec) => Math.max(max, rec.at), 0);

  const segments: string[] = [categories.join(", ")];
  if (tools.length > 0) segments.push(`tools: ${tools.join(", ")}`);
  if (correctionCount > 0) {
    segments.push(
      `${correctionCount} ${correctionCount === 1 ? "correction" : "corrections"} learned`,
    );
  }
  if (deliverableCount > 0) {
    segments.push(`${deliverableCount} ${deliverableCount === 1 ? "artifact" : "artifacts"}`);
  }
  segments.push(`last completed ${relativeAge(latestAt, now)}`);

  return clip(segments.join(" · "), budget);
}

// ---------------------------------------------------------------------------
// Card store: versioned snapshots + user pin/override
// ---------------------------------------------------------------------------

/** Narrow view of a bot needed to build its card. */
export interface CardBot {
  id: string;
  name: string;
  roleDescription: string;
}

export interface CapabilityCard {
  name: string;
  role: string;
  /** Platform-derived (or user-pinned) experience summary. */
  experience: string;
  availability: AvailabilityState;
  /** Monotonic card version (bumps when name/role/experience change). */
  version: number;
}

export interface CardSnapshot {
  version: number;
  name: string;
  role: string;
  experience: string;
  /** True when the experience text was a user pin at snapshot time. */
  pinned: boolean;
  /** Epoch ms when this version was recorded. */
  at: number;
}

/** Bounded version history per bot. */
export const MAX_CARD_VERSIONS = 20;

export const cardStorageKey = (botId: string): string => `engine.cards.${botId}`;

interface PersistedCardState {
  versions: CardSnapshot[];
  pin: string | null;
}

export interface CardStore {
  readonly botId: string;
  hydrate(): Promise<void>;
  /** Version history, oldest first. */
  history(): CardSnapshot[];
  /** Latest snapshot, if any card has been published. */
  current(): CardSnapshot | undefined;
  /** User-pinned experience override (null when none). */
  getPin(): string | null;
  /** Pin/edit the experience text; wins over the compiled summary until cleared. */
  pin(text: string): void;
  /** Clear the pin — the next build reverts to the compiled summary. */
  clearPin(): void;
  /**
   * Record a card publication. Appends a new version only when name, role, or
   * experience changed vs the latest snapshot. Returns the current snapshot.
   */
  publish(input: { name: string; role: string; experience: string; pinned: boolean; at: number }): CardSnapshot;
}

export function createCardStore(botId: string, storage: StorageLike): CardStore {
  let versions: CardSnapshot[] = [];
  let pinText: string | null = null;
  let hydrated = false;

  const persist = (): void => {
    const state: PersistedCardState = { versions, pin: pinText };
    void storage.set(cardStorageKey(botId), state).catch((err: unknown) => {
      console.error(`[engine] failed to persist card for bot ${botId}:`, err);
    });
  };

  return {
    botId,

    hydrate: async () => {
      if (hydrated) return;
      const stored = await storage.get<PersistedCardState>(cardStorageKey(botId));
      hydrated = true;
      if (stored) {
        versions = [...(stored.versions ?? []), ...versions].slice(-MAX_CARD_VERSIONS);
        if (pinText === null) pinText = stored.pin ?? null;
      }
    },

    history: () => [...versions],

    current: () => versions[versions.length - 1],

    getPin: () => pinText,

    pin: (text) => {
      pinText = clip(text, EXPERIENCE_CHAR_BUDGET);
      persist();
    },

    clearPin: () => {
      pinText = null;
      persist();
    },

    publish: ({ name, role, experience, pinned, at }) => {
      const latest = versions[versions.length - 1];
      if (
        latest &&
        latest.name === name &&
        latest.role === role &&
        latest.experience === experience
      ) {
        return latest;
      }
      const snapshot: CardSnapshot = {
        version: (latest?.version ?? 0) + 1,
        name,
        role,
        experience,
        pinned,
        at,
      };
      versions = [...versions, snapshot].slice(-MAX_CARD_VERSIONS);
      persist();
      return snapshot;
    },
  };
}

// Shared per-bot card store cache.
interface CachedCardStore {
  store: CardStore;
  ready: Promise<void>;
}

const cardStores = new Map<string, CachedCardStore>();

function getCachedCardStore(botId: string, storage?: StorageLike): CachedCardStore {
  let cached = cardStores.get(botId);
  if (!cached) {
    const store = createCardStore(botId, storage ?? getEngineStorage());
    cached = { store, ready: store.hydrate() };
    cardStores.set(botId, cached);
  }
  return cached;
}

/** Get (or lazily create + hydrate) the shared card store for a bot. */
export function getCardStore(botId: string, storage?: StorageLike): CardStore {
  return getCachedCardStore(botId, storage).store;
}

/** Drop cached card stores (tests, or after switching storage adapters). */
export function resetCardStores(): void {
  cardStores.clear();
}

/**
 * Build (and version) a bot's capability card. The experience text is the
 * user's pinned override when one is set, otherwise a deterministic compile
 * of the work record. A new version is recorded whenever name, role, or
 * experience changed since the last publication.
 */
export async function buildCapabilityCard(
  bot: CardBot,
  worklog: readonly WorkRecord[],
  availability: AvailabilityState,
  opts: { storage?: StorageLike; now?: number } = {},
): Promise<CapabilityCard> {
  const cached = getCachedCardStore(bot.id, opts.storage);
  await cached.ready;
  const store = cached.store;

  const pin = store.getPin();
  const experience = pin ?? compileExperience(worklog, { now: opts.now });
  const snapshot = store.publish({
    name: bot.name,
    role: bot.roleDescription,
    experience,
    pinned: pin !== null,
    at: opts.now ?? Date.now(),
  });

  return {
    name: snapshot.name,
    role: snapshot.role,
    experience: snapshot.experience,
    availability,
    version: snapshot.version,
  };
}

/** Version history for a bot's card (oldest first). */
export async function getCardHistory(botId: string, storage?: StorageLike): Promise<CardSnapshot[]> {
  const cached = getCachedCardStore(botId, storage);
  await cached.ready;
  return cached.store.history();
}

/** Pin (or edit) a user override for the experience text; wins until cleared. */
export async function pinExperience(
  botId: string,
  text: string,
  storage?: StorageLike,
): Promise<void> {
  const cached = getCachedCardStore(botId, storage);
  await cached.ready;
  cached.store.pin(text);
}

/** Remove the user override — the compiled summary takes effect on next build. */
export async function clearPin(botId: string, storage?: StorageLike): Promise<void> {
  const cached = getCachedCardStore(botId, storage);
  await cached.ready;
  cached.store.clearPin();
}

// ---------------------------------------------------------------------------
// Contact permissions side store (spec: "Per-Bot settings MAY restrict this
// (can-contact / can-be-contacted), defaulting to open within the team.")
// Pure module keyed by botId — deliberately not a field on the Bot record.
// ---------------------------------------------------------------------------

export interface ContactPermissions {
  /** May this bot contact teammates? */
  canContact: boolean;
  /** May teammates contact this bot? */
  canBeContacted: boolean;
}

export const DEFAULT_CONTACT_PERMISSIONS: ContactPermissions = {
  canContact: true,
  canBeContacted: true,
};

export const CONTACT_PERMISSIONS_STORAGE_KEY = "engine.contactPermissions";

export interface ContactPermissionsStore {
  hydrate(): Promise<void>;
  /** Permissions for a bot (defaults when never set). */
  get(botId: string): ContactPermissions;
  /** Patch a bot's permissions; persists and returns the new value. */
  set(botId: string, patch: Partial<ContactPermissions>): ContactPermissions;
  /** All explicitly-set permissions (bots at defaults are absent). */
  list(): Record<string, ContactPermissions>;
}

export function createContactPermissionsStore(storage: StorageLike): ContactPermissionsStore {
  let byBot: Record<string, ContactPermissions> = {};
  let hydrated = false;

  const persist = (): void => {
    void storage.set(CONTACT_PERMISSIONS_STORAGE_KEY, byBot).catch((err: unknown) => {
      console.error("[engine] failed to persist contact permissions:", err);
    });
  };

  return {
    hydrate: async () => {
      if (hydrated) return;
      const stored = await storage.get<Record<string, ContactPermissions>>(
        CONTACT_PERMISSIONS_STORAGE_KEY,
      );
      hydrated = true;
      if (stored) byBot = { ...stored, ...byBot };
    },

    get: (botId) => byBot[botId] ?? { ...DEFAULT_CONTACT_PERMISSIONS },

    set: (botId, patch) => {
      const next: ContactPermissions = {
        ...(byBot[botId] ?? DEFAULT_CONTACT_PERMISSIONS),
        ...patch,
      };
      byBot = { ...byBot, [botId]: next };
      persist();
      return next;
    },

    list: () => ({ ...byBot }),
  };
}

let sharedContactPermissions: { store: ContactPermissionsStore; ready: Promise<void> } | null = null;

/** Shared app-wide contact permissions store (lazily created + hydrated). */
export function getContactPermissionsStore(storage?: StorageLike): ContactPermissionsStore {
  if (!sharedContactPermissions) {
    const store = createContactPermissionsStore(storage ?? getEngineStorage());
    sharedContactPermissions = { store, ready: store.hydrate() };
  }
  return sharedContactPermissions.store;
}

/** Drop the shared contact-permissions store (tests / storage swap). */
export function resetContactPermissionsStore(): void {
  sharedContactPermissions = null;
}
