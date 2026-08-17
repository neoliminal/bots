// Desktop shell glue (mac-app-shell spec, menu bar / tray extra subset):
// - keeps the tray menu's per-bot "<name> — <status>" lines in sync with the
//   runtime state feed and the roster (debounced),
// - handles the tray's "Pause All Bots" action,
// - mirrors the pending-approval count onto the dock badge.
// Window show/focus for "Open Bots" is handled on the Rust side (tray.rs).

import { STATE_LABELS } from "../features/avatars";
import {
  botApprovals,
  botRuntime,
  syncPauseState,
  useBotsStore,
} from "../lib/engine";
import {
  onTrayPauseAll,
  setBadgeCount,
  trayUpdate,
  type TrayBotItem,
} from "../lib/native";

/** Trailing debounce for tray menu rebuilds (state changes arrive in bursts). */
export const TRAY_DEBOUNCE_MS = 250;

export interface ShellDeps {
  trayUpdate?: (items: TrayBotItem[]) => Promise<void>;
  setBadgeCount?: (count: number | null) => Promise<void>;
  onTrayPauseAll?: (handler: () => void) => Promise<() => void>;
  debounceMs?: number;
}

/** Pause every active bot (tray "Pause All Bots" — mac-app-shell spec). */
export function pauseAllBots(): void {
  const store = useBotsStore.getState();
  for (const bot of store.listBots()) {
    if (bot.paused) continue;
    const updated = store.updateBot(bot.id, { paused: true });
    if (updated) syncPauseState(updated);
  }
}

/** One tray line per active bot: "<name> — <status label>". */
export function trayItems(): TrayBotItem[] {
  return useBotsStore
    .getState()
    .listBots()
    .map((bot) => ({
      id: bot.id,
      title: `${bot.name} — ${STATE_LABELS[botRuntime.getState(bot.id)]}`,
    }));
}

/**
 * Wire tray + badge to the live stores. Returns a dispose function.
 * All native calls no-op outside Tauri, so this is safe in tests/browsers.
 */
export function createShellIntegration(deps: ShellDeps = {}): () => void {
  const tray = deps.trayUpdate ?? trayUpdate;
  const badge = deps.setBadgeCount ?? setBadgeCount;
  const pauseAllListener = deps.onTrayPauseAll ?? onTrayPauseAll;
  const debounceMs = deps.debounceMs ?? TRAY_DEBOUNCE_MS;

  // --- Dock badge = pending approvals count -------------------------------
  const unsubBadge = botApprovals.subscribe((pending) => {
    void badge(pending.length > 0 ? pending.length : null);
  });

  // --- Tray menu: per-bot name + status, debounced ------------------------
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tray(trayItems());
    }, debounceMs);
  };

  const runtimeUnsubs = new Map<string, () => void>();
  const syncRuntimeSubscriptions = (): void => {
    const ids = new Set(useBotsStore.getState().listBots().map((b) => b.id));
    for (const [id, unsub] of runtimeUnsubs) {
      if (!ids.has(id)) {
        unsub();
        runtimeUnsubs.delete(id);
      }
    }
    for (const id of ids) {
      if (!runtimeUnsubs.has(id)) {
        runtimeUnsubs.set(
          id,
          botRuntime.subscribe(id, () => schedule()),
        );
      }
    }
  };

  const unsubBots = useBotsStore.subscribe((state, prev) => {
    if (state.bots === prev.bots) return;
    syncRuntimeSubscriptions();
    schedule();
  });

  syncRuntimeSubscriptions();
  schedule();

  // --- Tray actions -------------------------------------------------------
  const unlistenPromise = pauseAllListener(() => pauseAllBots());

  return () => {
    unsubBadge();
    unsubBots();
    for (const unsub of runtimeUnsubs.values()) unsub();
    runtimeUnsubs.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void unlistenPromise.then((unlisten) => unlisten());
  };
}

let disposeShell: (() => void) | null = null;

/** Idempotent app wiring; returns the active dispose function. */
export function initShellIntegration(deps: ShellDeps = {}): () => void {
  if (disposeShell) return disposeShell;
  const dispose = createShellIntegration(deps);
  disposeShell = () => {
    dispose();
    disposeShell = null;
  };
  return disposeShell;
}
