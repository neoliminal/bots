// Per-bot runtime state machine: the avatar/roster state feed
// (bot-avatars spec — "Animation as truthful status").
import type { BotRuntimeState } from "./types";

export type RuntimeListener = (state: BotRuntimeState) => void;

/** How long the celebration animation holds before settling to idle. */
export const DEFAULT_CELEBRATE_MS = 1200;

/** How long the handoff animation holds before settling to idle. */
export const DEFAULT_HANDOFF_MS = 900;

export interface RuntimeStore {
  /** Current state for a bot; bots default to "idle". */
  getState(botId: string): BotRuntimeState;
  /** Snapshot map of every bot that has ever had a state set. */
  snapshot(): Record<string, BotRuntimeState>;
  /** Set a bot's state and notify subscribers. Cancels a pending transient-settle. */
  setState(botId: string, state: BotRuntimeState): void;
  /**
   * Set a busy/transient state unless the bot is sleeping — paused/sleeping
   * wins over everything (the engine uses this for thinking/working/
   * waitingOnUser/talkingToBot transitions).
   */
  setBusyState(botId: string, state: BotRuntimeState): void;
  /** Settle back to "idle" — no-op while the bot is sleeping. */
  settle(botId: string): void;
  /** Enter "celebrating" briefly, then settle to "idle" (bot-avatars: play once, not looping). */
  celebrate(botId: string, durationMs?: number): void;
  /** Enter "handoff" briefly (receiving a delegated task), then settle to "idle". */
  handoff(botId: string, durationMs?: number): void;
  /**
   * Subscribe to a bot's state feed. The callback fires immediately with the
   * current state, then on every change. Returns an unsubscribe function.
   */
  subscribe(botId: string, cb: RuntimeListener): () => void;
  /** Remove a bot's state and listeners (e.g., after deletion). */
  clear(botId: string): void;
}

export function createRuntime(): RuntimeStore {
  const states = new Map<string, BotRuntimeState>();
  const listeners = new Map<string, Set<RuntimeListener>>();
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelSettle = (botId: string): void => {
    const timer = settleTimers.get(botId);
    if (timer !== undefined) {
      clearTimeout(timer);
      settleTimers.delete(botId);
    }
  };

  const notify = (botId: string, state: BotRuntimeState): void => {
    const subs = listeners.get(botId);
    if (!subs) return;
    for (const cb of [...subs]) cb(state);
  };

  const getState = (botId: string): BotRuntimeState => states.get(botId) ?? "idle";

  const setState = (botId: string, state: BotRuntimeState): void => {
    cancelSettle(botId);
    if (getState(botId) === state) return;
    states.set(botId, state);
    notify(botId, state);
  };

  const setBusyState = (botId: string, state: BotRuntimeState): void => {
    if (getState(botId) === "sleeping") return; // paused/sleeping wins
    setState(botId, state);
  };

  const settle = (botId: string): void => {
    if (getState(botId) === "sleeping") return; // paused/sleeping wins
    setState(botId, "idle");
  };

  /** Enter a transient state, then settle to idle after durationMs. */
  const transient = (
    botId: string,
    state: BotRuntimeState,
    durationMs: number,
  ): void => {
    if (getState(botId) === "sleeping") return; // paused/sleeping wins
    setState(botId, state);
    const timer = setTimeout(() => {
      settleTimers.delete(botId);
      // Only settle if nothing else changed the state meanwhile
      // (setState cancels this timer, so reaching here means still in `state`).
      setState(botId, "idle");
    }, durationMs);
    settleTimers.set(botId, timer);
  };

  return {
    getState,
    setState,
    setBusyState,
    settle,

    snapshot: () => Object.fromEntries(states),

    celebrate: (botId, durationMs = DEFAULT_CELEBRATE_MS) => {
      transient(botId, "celebrating", durationMs);
    },

    handoff: (botId, durationMs = DEFAULT_HANDOFF_MS) => {
      transient(botId, "handoff", durationMs);
    },

    subscribe: (botId, cb) => {
      let subs = listeners.get(botId);
      if (!subs) {
        subs = new Set();
        listeners.set(botId, subs);
      }
      subs.add(cb);
      cb(getState(botId));
      return () => {
        subs.delete(cb);
        if (subs.size === 0) listeners.delete(botId);
      };
    },

    clear: (botId) => {
      cancelSettle(botId);
      states.delete(botId);
      listeners.delete(botId);
    },
  };
}

/** App-wide runtime feed shared by the engine and avatar renderers. */
export const botRuntime: RuntimeStore = createRuntime();
