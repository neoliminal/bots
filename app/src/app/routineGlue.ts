// Glue between the routines engine (lib/engine/routines.ts) and the app:
// the run rail a routine fires down, the `save_routine` tool registration,
// and the scheduler tick.
//
// Spec: openspec/specs/routines/spec.md —
// - "On-demand and scheduled runs": a routine runs from its Run now button,
//   from its schedule, or from a trigger; every path lands here.
// - "Per-run reporting and trust progression": each run leaves a card in the
//   bot's thread and a record in the routine's history, so a run that
//   happened overnight is reviewable in the morning.
// - "Routine management": disabling stops future fires; a run already in
//   flight is the user's to Stop, like any other run.
//
// Runs go through the bot's ordinary serial queue (`runBrief`), so a routine
// that fires while the bot is mid-conversation waits its turn instead of
// racing it, and Stop/pause work on it exactly as on anything else.

import { chatStore } from "../features/chat";
import { appToolRegistry } from "./tools";
import {
  createRoutineScheduler,
  createSaveRoutineTool,
  useRoutinesStore,
  type Routine,
  type RoutineInvoker,
  type RoutineScheduler,
} from "../lib/engine";
import { runBrief, type StreamFn } from "./chatGlue";

/** How often the scheduler looks for due routines. */
export const SCHEDULER_TICK_MS = 30_000;

let scheduler: RoutineScheduler | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The brief a routine run hands the bot. Numbered steps rather than prose:
 * the routine's own words are the instruction, and the mode line tells the
 * bot how much latitude it has — without ever loosening the policy floors,
 * which apply to a routine run exactly as to a chat message.
 */
export function routineBrief(routine: Routine, invokedBy: RoutineInvoker): string {
  const steps = routine.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const trigger =
    invokedBy === "schedule"
      ? "This is its scheduled run."
      : invokedBy === "trigger"
        ? "Something triggered it."
        : "The user asked you to run it now.";
  const mode =
    routine.mode === "supervised"
      ? "This routine is still being validated: prefer checking with the user before anything outward-facing, and report what you did."
      : "You may work through it normally, within your usual limits.";
  return [
    `Run your routine "${routine.name}". ${trigger}`,
    "",
    steps,
    "",
    mode,
  ].join("\n");
}

/**
 * Run a routine now. Posts a card in the bot's thread, runs the brief on the
 * bot's queue, then resolves the card and appends the run record.
 *
 * Never throws: a routine failing is a recorded outcome, not an exception for
 * a caller (a scheduler tick, a button) to handle.
 */
export async function runRoutineNow(
  routineId: string,
  invokedBy: RoutineInvoker = "user",
  stream?: StreamFn,
): Promise<void> {
  const routines = useRoutinesStore.getState();
  const routine = routines.getRoutine(routineId);
  if (routine === undefined) return;

  const threadId = chatStore.getState().ensureDirectThread(routine.botId);
  const startedAt = Date.now();
  const cardId = chatStore
    .getState()
    .addBotMessage(threadId, routine.botId, `Running "${routine.name}"`, {
      kind: "routine-run",
      status: "in-progress",
      routineName: routine.name,
      invokedBy,
    });

  const settle = (
    status: "ok" | "error" | "cancelled",
    summary: string,
  ): void => {
    if (cardId !== "") {
      chatStore.getState().updateMessageMeta(threadId, cardId, {
        status: status === "ok" ? "done" : "failed",
        ...(status === "ok" ? { report: summary } : { error: summary }),
      });
    }
    useRoutinesStore.getState().appendRun(routineId, {
      id: `run-${startedAt.toString(36)}`,
      status,
      summary,
      invokedBy,
      startedAt,
      finishedAt: Date.now(),
    });
  };

  try {
    const reply = await runBrief(
      routine.botId,
      threadId,
      routineBrief(routine, invokedBy),
      ...(stream !== undefined ? ([stream] as const) : ([] as const)),
    );
    settle("ok", reply.trim() === "" ? "Finished with nothing to report." : reply);
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    settle(
      aborted ? "cancelled" : "error",
      aborted ? "Stopped before it finished." : errorText(err),
    );
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The rail an external event calls (routines spec, "trigger-event runs").
 * Nothing emits events yet; this is the entry point they will use.
 */
export function notifyTrigger(routineId: string): Promise<void> {
  return runRoutineNow(routineId, "trigger");
}

/**
 * Start the schedule tick. Idempotent — a second call is a no-op rather than
 * a second interval, so a re-bootstrap cannot double-fire every routine.
 */
export function startRoutineScheduler(options?: {
  tickMs?: number;
  now?: () => number;
}): void {
  if (timer !== null) return;
  scheduler = createRoutineScheduler({
    list: () => useRoutinesStore.getState().listRoutines(),
    markFired: (id, at) => useRoutinesStore.getState().markFired(id, at),
    fire: (routine) => {
      void runRoutineNow(routine.id, "schedule");
    },
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });
  timer = setInterval(() => scheduler?.tick(), options?.tickMs ?? SCHEDULER_TICK_MS);
  // A routine whose slot passed while the app was closed is due right now;
  // waiting a full tick to notice would make every launch feel asleep.
  scheduler.tick();
}

/** Stop the schedule tick (app teardown, tests). */
export function stopRoutineScheduler(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  scheduler = null;
}

/** Register `save_routine` so bots can create routines from conversation. */
export function registerRoutineTools(): void {
  appToolRegistry.register(
    createSaveRoutineTool({
      create: (input) => useRoutinesStore.getState().createRoutine(input),
    }),
  );
}
