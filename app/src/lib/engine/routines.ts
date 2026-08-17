// Routines: persisted recurring jobs per bot with run records and pure
// schedule math (openspec/specs/routines/spec.md; first slice scoped by
// openspec/changes/build-routines). The store mirrors bots.ts (zustand +
// StorageLike); execution lives in integration (app/routineGlue.ts) — the
// engine only knows definitions, due-ness, and history.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import type { EngineTool } from "./tools";
import type { StorageLike } from "./types";

export const ROUTINES_STORAGE_KEY = "engine.routines";

/** Run records kept per routine (newest first). */
export const ROUTINE_RUN_HISTORY_LIMIT = 20;

/** A fire this long after its slot is a catch-up and is marked late. */
export const ROUTINE_LATE_AFTER_MS = 5 * 60 * 1000;

export interface RoutineSchedule {
  /** "manual" = on-demand only; "daily" fires at `time` on `days`. */
  kind: "manual" | "daily";
  /** "HH:MM" 24h local wall-clock (daily only). */
  time?: string;
  /** Days 0(Sun)–6(Sat); absent = every day (daily only). */
  days?: number[];
}

export type RoutineInvoker = "user" | "schedule" | "trigger";

export interface RoutineRunRecord {
  id: string;
  status: "ok" | "error" | "cancelled";
  /** Report text (ok) or failure message. */
  summary: string;
  invokedBy: RoutineInvoker;
  /** Set on catch-up runs for a slot missed while the app was closed. */
  late?: boolean;
  startedAt: number;
  finishedAt: number;
}

export interface Routine {
  id: string;
  botId: string;
  name: string;
  /** Human-readable intent steps, in order. */
  steps: string[];
  schedule: RoutineSchedule;
  enabled: boolean;
  /** Trust progression (routines spec): supervised until the user promotes. */
  mode: "supervised" | "autonomous";
  createdAt: number;
  /** Slot bookkeeping: the last slot (or manual fire) already handled. */
  lastFiredAt?: number;
  /** Newest first, capped at ROUTINE_RUN_HISTORY_LIMIT. */
  runs: RoutineRunRecord[];
}

export interface CreateRoutineInput {
  botId: string;
  name: string;
  steps: string[];
  schedule: RoutineSchedule;
  mode?: Routine["mode"];
}

export type UpdateRoutinePatch = Partial<
  Pick<Routine, "name" | "steps" | "schedule" | "enabled" | "mode">
>;

// ---------------------------------------------------------------------------
// Schedule math (pure; all local wall-clock, DST-correct via Date fields)
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM"; undefined when malformed. */
export function parseScheduleTime(
  time: string,
): { hours: number; minutes: number } | undefined {
  const m = TIME_RE.exec(time);
  if (!m) return undefined;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

function runsOnDay(schedule: RoutineSchedule, day: number): boolean {
  return schedule.days === undefined || schedule.days.includes(day);
}

/** The timestamp of `schedule.time` on the same local date as `at`. */
function slotOnDate(at: Date, hours: number, minutes: number): number {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate(), hours, minutes, 0, 0);
  return d.getTime();
}

/** Next scheduled fire strictly after `from`; undefined for manual. */
export function nextRunAt(schedule: RoutineSchedule, from: number): number | undefined {
  if (schedule.kind !== "daily" || schedule.time === undefined) return undefined;
  const t = parseScheduleTime(schedule.time);
  if (!t) return undefined;
  if (schedule.days !== undefined && schedule.days.length === 0) return undefined;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(from + offset * 86_400_000);
    const slot = slotOnDate(day, t.hours, t.minutes);
    if (slot > from && runsOnDay(schedule, new Date(slot).getDay())) return slot;
  }
  return undefined;
}

/** Most recent scheduled slot at or before `now`; undefined for manual. */
export function lastSlotAt(schedule: RoutineSchedule, now: number): number | undefined {
  if (schedule.kind !== "daily" || schedule.time === undefined) return undefined;
  const t = parseScheduleTime(schedule.time);
  if (!t) return undefined;
  if (schedule.days !== undefined && schedule.days.length === 0) return undefined;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(now - offset * 86_400_000);
    const slot = slotOnDate(day, t.hours, t.minutes);
    if (slot <= now && runsOnDay(schedule, new Date(slot).getDay())) return slot;
  }
  return undefined;
}

/**
 * The slot a scheduled run should fire for right now, or undefined.
 * A slot is due when it is at or before `now`, after the routine was
 * created, and not yet handled (lastFiredAt) — so a slot missed while the
 * app was closed reads as due exactly once on the next tick.
 */
export function dueSlot(routine: Routine, now: number): number | undefined {
  if (!routine.enabled) return undefined;
  const slot = lastSlotAt(routine.schedule, now);
  if (slot === undefined) return undefined;
  if (slot < routine.createdAt) return undefined;
  if (routine.lastFiredAt !== undefined && slot <= routine.lastFiredAt) return undefined;
  return slot;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

function sameDaySet(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);
}

/** "7:00 AM" from "07:00". */
export function formatScheduleTime(time: string): string {
  const t = parseScheduleTime(time);
  if (!t) return time;
  const period = t.hours < 12 ? "AM" : "PM";
  const hour12 = t.hours % 12 === 0 ? 12 : t.hours % 12;
  return `${hour12}:${String(t.minutes).padStart(2, "0")} ${period}`;
}

/** Human words for a schedule: "weekdays at 7:00 AM", "on demand". */
export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind !== "daily" || schedule.time === undefined) return "on demand";
  const at = formatScheduleTime(schedule.time);
  const days = schedule.days;
  if (days === undefined || days.length === 7) return `every day at ${at}`;
  if (sameDaySet(days, WEEKDAYS)) return `weekdays at ${at}`;
  if (sameDaySet(days, WEEKEND)) return `weekends at ${at}`;
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? String(d));
  return `${names.join(", ")} at ${at}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RoutinesState {
  routines: Routine[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createRoutine: (input: CreateRoutineInput) => Routine;
  updateRoutine: (id: string, patch: UpdateRoutinePatch) => Routine | undefined;
  /** Hard delete — history dies with the routine (routines spec). */
  deleteRoutine: (id: string) => void;
  /** Stamp the slot (or manual fire time) as handled. */
  markFired: (id: string, at: number) => void;
  /** Append a settled run record, newest first, capped. */
  appendRun: (id: string, record: RoutineRunRecord) => void;
  listRoutines: (botId?: string) => Routine[];
  getRoutine: (id: string) => Routine | undefined;
}

export type RoutinesStore = UseBoundStore<StoreApi<RoutinesState>>;

function createRoutinesStoreWith(getStorage: () => StorageLike): RoutinesStore {
  const persist = (routines: Routine[]): void => {
    void getStorage()
      .set(ROUTINES_STORAGE_KEY, routines)
      .catch((err: unknown) => {
        console.error("[engine] failed to persist routines:", err);
      });
  };

  return create<RoutinesState>()((set, get) => {
    const apply = (routines: Routine[]): void => {
      set({ routines });
      persist(routines);
    };

    const patchOne = (id: string, fn: (r: Routine) => Routine): Routine | undefined => {
      let updated: Routine | undefined;
      const routines = get().routines.map((r) => {
        if (r.id !== id) return r;
        updated = fn(r);
        return updated;
      });
      if (updated) apply(routines);
      return updated;
    };

    return {
      routines: [],
      hydrated: false,

      hydrate: async () => {
        const stored = await getStorage().get<Routine[]>(ROUTINES_STORAGE_KEY);
        set({ routines: stored ?? [], hydrated: true });
      },

      createRoutine: (input) => {
        const routine: Routine = {
          id: makeId("routine"),
          botId: input.botId,
          name: input.name,
          steps: [...input.steps],
          schedule: { ...input.schedule },
          enabled: true,
          mode: input.mode ?? "supervised",
          createdAt: Date.now(),
          runs: [],
        };
        apply([...get().routines, routine]);
        return routine;
      },

      updateRoutine: (id, patch) => patchOne(id, (r) => ({ ...r, ...patch })),

      deleteRoutine: (id) => {
        const routines = get().routines.filter((r) => r.id !== id);
        if (routines.length !== get().routines.length) apply(routines);
      },

      markFired: (id, at) => {
        patchOne(id, (r) => ({
          ...r,
          lastFiredAt: r.lastFiredAt === undefined ? at : Math.max(r.lastFiredAt, at),
        }));
      },

      appendRun: (id, record) => {
        patchOne(id, (r) => ({
          ...r,
          runs: [record, ...r.runs].slice(0, ROUTINE_RUN_HISTORY_LIMIT),
        }));
      },

      listRoutines: (botId) =>
        botId === undefined
          ? get().routines
          : get().routines.filter((r) => r.botId === botId),

      getRoutine: (id) => get().routines.find((r) => r.id === id),
    };
  });
}

/** Build an isolated routines store bound to a specific adapter (tests). */
export function createRoutinesStore(storage: StorageLike): RoutinesStore {
  return createRoutinesStoreWith(() => storage);
}

/** App-wide routines store; uses whatever adapter configureEngineStorage set. */
export const useRoutinesStore: RoutinesStore = createRoutinesStoreWith(() =>
  getEngineStorage(),
);

// ---------------------------------------------------------------------------
// Scheduler (pure tick; integration owns the timer)
// ---------------------------------------------------------------------------

export interface RoutineSchedulerDeps {
  /** Routines to consider (typically the store's full list). */
  list: () => Routine[];
  /** Stamp a slot handled BEFORE firing — no double-fire on slow runs. */
  markFired: (id: string, at: number) => void;
  /** Start the run (routineGlue.runRoutineNow); errors are the rail's job. */
  fire: (routine: Routine, opts: { late: boolean }) => void;
  now?: () => number;
}

export interface RoutineScheduler {
  /** Fire every due routine once. Returns the ids fired (tests). */
  tick: () => string[];
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const now = deps.now ?? (() => Date.now());
  return {
    tick: () => {
      const t = now();
      const fired: string[] = [];
      for (const routine of deps.list()) {
        const slot = dueSlot(routine, t);
        if (slot === undefined) continue;
        deps.markFired(routine.id, slot);
        deps.fire(routine, { late: t - slot > ROUTINE_LATE_AFTER_MS });
        fired.push(routine.id);
      }
      return fired;
    },
  };
}

// ---------------------------------------------------------------------------
// save_routine tool (routines spec, "Routine creation from conversation")
// ---------------------------------------------------------------------------

const SAVE_ROUTINE_DESCRIPTION =
  "Save a recurring or repeatable job as a named routine owned by you. Use " +
  "this when the user asks for something to happen on a schedule ('every " +
  "morning', 'weekdays at 7') or wants a workflow they can re-run on " +
  "demand. Steps are plain-language intents, in order. New routines start " +
  "supervised: runs still pause for approvals until the user promotes them. " +
  "Confirm to the user in words what was saved and when it will run.";

export interface SaveRoutineDeps {
  create: (input: CreateRoutineInput) => Routine;
}

function parseDays(raw: unknown): number[] | undefined | string {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return "days must be an array of integers 0 (Sunday) through 6 (Saturday)";
  }
  return [...new Set(raw as number[])];
}

export function createSaveRoutineTool(deps: SaveRoutineDeps): EngineTool {
  return {
    name: "save_routine",
    description: SAVE_ROUTINE_DESCRIPTION,
    category: "workspace-mutate",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short routine name, e.g. 'Morning briefing'" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Plain-language intent steps, in order (1-20)",
        },
        schedule_kind: {
          type: "string",
          enum: ["manual", "daily"],
          description: "'daily' runs at a time; 'manual' is on-demand only",
        },
        time: {
          type: "string",
          description: "24h local time 'HH:MM' (required when schedule_kind is 'daily')",
        },
        days: {
          type: "array",
          items: { type: "integer" },
          description:
            "Days 0 (Sunday) through 6 (Saturday); omit for every day. Weekdays = [1,2,3,4,5]",
        },
      },
      required: ["name", "steps", "schedule_kind"],
    },
    run: (args, ctx) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name === "") throw new Error("name must be a non-empty string");
      const rawSteps = args.steps;
      if (
        !Array.isArray(rawSteps) ||
        rawSteps.length === 0 ||
        rawSteps.length > 20 ||
        rawSteps.some((s) => typeof s !== "string" || s.trim() === "")
      ) {
        throw new Error("steps must be 1-20 non-empty strings");
      }
      const kind = args.schedule_kind;
      if (kind !== "manual" && kind !== "daily") {
        throw new Error("schedule_kind must be 'manual' or 'daily'");
      }
      const schedule: RoutineSchedule = { kind };
      if (kind === "daily") {
        const time = typeof args.time === "string" ? args.time : "";
        if (parseScheduleTime(time) === undefined) {
          throw new Error("time must be 'HH:MM' 24h local time when schedule_kind is 'daily'");
        }
        schedule.time = time;
        const days = parseDays(args.days);
        if (typeof days === "string") throw new Error(days);
        if (days !== undefined) {
          if (days.length === 0) throw new Error("days must not be empty when given");
          schedule.days = days;
        }
      }
      const routine = deps.create({
        botId: ctx.bot.id,
        name,
        steps: (rawSteps as string[]).map((s) => s.trim()),
        schedule,
      });
      return (
        `Saved routine "${routine.name}" (${describeSchedule(routine.schedule)}, ` +
        `supervised). The user can run, promote, or disable it from your details panel.`
      );
    },
  };
}
