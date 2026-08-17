// App startup: wire the engine to real persistence and hydrate all stores.

import {
  auditLog,
  botInstances,
  botRuntime,
  configureEngineStorage,
  getCardStore,
  getContactPermissionsStore,
  hydrateMemory,
  hydrateWorklog,
  runLog,
  useRoutinesStore,
  useBotsStore,
} from "../lib/engine";
import { createLocalStorage } from "../lib/storage";
import { chatStore } from "../features/chat";
import { resumeInterruptedRuns } from "./chatGlue";
import { initMcp } from "./mcpGlue";
import { initApprovalNotifications } from "./notifications";
import { initOnboarding } from "./onboardingCompute";
import { registerRoutineTools, startRoutineScheduler } from "./routineGlue";
import { initSessions } from "./sessionGlue";
import { initShellIntegration } from "./shell";

let bootstrapped: Promise<void> | null = null;

/** Idempotent app bootstrap: storage wiring + store hydration. */
export function bootstrapApp(): Promise<void> {
  if (bootstrapped) return bootstrapped;
  configureEngineStorage(createLocalStorage());
  bootstrapped = (async () => {
    await Promise.all([
      useBotsStore.getState().hydrate(),
      chatStore.getState().loadPersisted(),
      // Audit history loads before any run can append to it, so the log
      // stays continuous across restarts (security spec, audit log).
      auditLog.getState().hydrate(),
      // Steps of any run a quit interrupted, so resumption can re-enter
      // them with their context intact (task-execution spec).
      runLog.getState().hydrate(),
      // Routines, so the scheduler below sees them on its first tick.
      useRoutinesStore.getState().hydrate(),
    ]);
    const bots = useBotsStore.getState().listBots();
    // Load each bot's long-term memory so the first run loop composes with
    // it, plus its work record + capability card stores (contact_bot embeds
    // cards synchronously) and instance merge history (memory panel).
    await Promise.all([
      ...bots.map((bot) => hydrateMemory(bot.id)),
      ...bots.map((bot) => hydrateWorklog(bot.id)),
      ...bots.map((bot) => getCardStore(bot.id).hydrate()),
      ...bots.map((bot) => botInstances.hydrateMergeHistory(bot.id)),
      getContactPermissionsStore().hydrate(),
    ]);
    // Reflect persisted pause flags in the runtime feed.
    for (const bot of bots) {
      if (bot.paused) botRuntime.setState(bot.id, "sleeping");
    }
    // First-run compute-location question (agent-computer spec, "Onboarding
    // compute location choice"): a roster that already has bots means this
    // user predates the flow, so the flag is set without ever asking them.
    await initOnboarding({ hasBots: bots.length > 0 });
    // Compute sessions (agent-computer spec): register session tools for
    // the persisted provider choice (local default). Provisioning stays
    // transparent — nothing spins up until a bot's first session tool call.
    await initSessions();
    // MCP servers (tool-extensibility): reconnect persisted servers so
    // their tools re-enter the registry; failures leave them unhealthy
    // (tools hidden) without blocking startup.
    await initMcp();
    // Native shell wiring: notifications, tray menu, dock badge.
    initApprovalNotifications();
    initShellIntegration();
    // Routines (routines spec): the save_routine tool so bots can create
    // them from conversation, and the tick that fires the due ones. The
    // scheduler ticks once on start, so a slot missed while the app was
    // closed runs now rather than waiting for the next interval.
    registerRoutineTools();
    startRoutineScheduler();
    // Work a quit or crash interrupted (task-execution spec, "Durable,
    // resumable execution"). Last, so a resumed run finds every store
    // hydrated and its tools registered. Fire-and-forget: resumption must
    // never delay or fail startup.
    void resumeInterruptedRuns().catch((err: unknown) => {
      console.error("[app] failed to resume interrupted runs:", err);
    });
  })();
  return bootstrapped;
}

/** Test helper: allow bootstrap to run again. */
export function resetBootstrap(): void {
  bootstrapped = null;
}
