// Spec: openspec/specs/routines (as scoped by openspec/changes/build-routines):
// schedule math, persisted store, single-fire scheduler, save_routine tool.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  createRoutineScheduler,
  createRoutinesStore,
  createSaveRoutineTool,
  describeSchedule,
  dueSlot,
  formatScheduleTime,
  lastSlotAt,
  nextRunAt,
  parseScheduleTime,
  ROUTINE_RUN_HISTORY_LIMIT,
  ROUTINES_STORAGE_KEY,
  type Routine,
  type RoutinesStore,
} from "./routines";
import type { ToolContext } from "./tools";
import type { Bot } from "./types";

/** Local-time timestamp helper (tests run in the host timezone). */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

const daily = (time: string, days?: number[]) => ({
  kind: "daily" as const,
  time,
  ...(days !== undefined ? { days } : {}),
});

describe("schedule math", () => {
  it("parses valid times and rejects malformed ones", () => {
    expect(parseScheduleTime("07:00")).toEqual({ hours: 7, minutes: 0 });
    expect(parseScheduleTime("23:59")).toEqual({ hours: 23, minutes: 59 });
    for (const bad of ["7am", "24:00", "12:60", "", "07:0"]) {
      expect(parseScheduleTime(bad)).toBeUndefined();
    }
  });

  it("nextRunAt returns the same day when the time is still ahead", () => {
    // 2026-08-12 is a Wednesday.
    const from = at(2026, 8, 12, 6, 0);
    expect(nextRunAt(daily("07:00"), from)).toBe(at(2026, 8, 12, 7, 0));
  });

  it("nextRunAt rolls past excluded days (weekdays over a weekend)", () => {
    // Friday 08:00 -> next weekday slot is Monday 07:00.
    const from = at(2026, 8, 14, 8, 0);
    expect(nextRunAt(daily("07:00", [1, 2, 3, 4, 5]), from)).toBe(
      at(2026, 8, 17, 7, 0),
    );
  });

  it("nextRunAt is undefined for manual and empty-day schedules", () => {
    expect(nextRunAt({ kind: "manual" }, at(2026, 8, 12))).toBeUndefined();
    expect(nextRunAt(daily("07:00", []), at(2026, 8, 12))).toBeUndefined();
  });

  it("lastSlotAt finds the most recent matching slot at or before now", () => {
    // Saturday 10:00 with a weekday schedule -> Friday's slot.
    const now = at(2026, 8, 15, 10, 0);
    expect(lastSlotAt(daily("07:00", [1, 2, 3, 4, 5]), now)).toBe(
      at(2026, 8, 14, 7, 0),
    );
    expect(lastSlotAt(daily("07:00"), now)).toBe(at(2026, 8, 15, 7, 0));
  });

  it("describes schedules in words", () => {
    expect(describeSchedule({ kind: "manual" })).toBe("on demand");
    expect(describeSchedule(daily("08:00"))).toBe("every day at 8:00 AM");
    expect(describeSchedule(daily("07:00", [1, 2, 3, 4, 5]))).toBe(
      "weekdays at 7:00 AM",
    );
    expect(describeSchedule(daily("19:30", [0, 6]))).toBe("weekends at 7:30 PM");
    expect(describeSchedule(daily("12:00", [3, 1]))).toBe("Mon, Wed at 12:00 PM");
    expect(formatScheduleTime("00:05")).toBe("12:05 AM");
  });
});

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    botId: "b1",
    name: "Morning briefing",
    steps: ["summarize inbox"],
    schedule: daily("07:00"),
    enabled: true,
    mode: "supervised",
    createdAt: at(2026, 8, 10, 12, 0),
    runs: [],
    ...overrides,
  };
}

describe("dueSlot", () => {
  it("is due once the slot passes and not again after markFired", () => {
    const r = makeRoutine();
    expect(dueSlot(r, at(2026, 8, 12, 6, 59))).toBe(at(2026, 8, 11, 7, 0));
    const fired = { ...r, lastFiredAt: at(2026, 8, 11, 7, 0) };
    expect(dueSlot(fired, at(2026, 8, 12, 6, 59))).toBeUndefined();
    expect(dueSlot(fired, at(2026, 8, 12, 7, 0))).toBe(at(2026, 8, 12, 7, 0));
  });

  it("never fires slots from before the routine existed", () => {
    // Created 09:00; today's 07:00 slot already passed -> not due today.
    const r = makeRoutine({ createdAt: at(2026, 8, 12, 9, 0) });
    expect(dueSlot(r, at(2026, 8, 12, 9, 5))).toBeUndefined();
    expect(dueSlot(r, at(2026, 8, 13, 7, 0))).toBe(at(2026, 8, 13, 7, 0));
  });

  it("ignores disabled routines", () => {
    const r = makeRoutine({ enabled: false });
    expect(dueSlot(r, at(2026, 8, 12, 8, 0))).toBeUndefined();
  });

  it("reads a slot missed while closed as due exactly once", () => {
    // Last handled Tuesday; the app slept over Wednesday 07:00.
    const r = makeRoutine({ lastFiredAt: at(2026, 8, 11, 7, 0) });
    const reopenedAt = at(2026, 8, 12, 9, 30);
    expect(dueSlot(r, reopenedAt)).toBe(at(2026, 8, 12, 7, 0));
    const caughtUp = { ...r, lastFiredAt: at(2026, 8, 12, 7, 0) };
    expect(dueSlot(caughtUp, reopenedAt)).toBeUndefined();
  });
});

describe("routines store", () => {
  let store: RoutinesStore;

  beforeEach(() => {
    store = createRoutinesStore(createMemoryStorage());
  });

  it("creates enabled supervised routines and lists per bot", () => {
    const r = store.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a", "b"],
      schedule: { kind: "manual" },
    });
    expect(r.enabled).toBe(true);
    expect(r.mode).toBe("supervised");
    store.getState().createRoutine({
      botId: "b2",
      name: "Other",
      steps: ["x"],
      schedule: { kind: "manual" },
    });
    expect(store.getState().listRoutines("b1").map((x) => x.id)).toEqual([r.id]);
    expect(store.getState().listRoutines()).toHaveLength(2);
  });

  it("persists across hydrate and hard-deletes with history", async () => {
    const storage = createMemoryStorage();
    const a = createRoutinesStore(storage);
    const r = a.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a"],
      schedule: { kind: "manual" },
    });
    a.getState().deleteRoutine(r.id);
    // Deletion persisted: a fresh store over the same storage sees nothing.
    const b = createRoutinesStore(storage);
    await b.getState().hydrate();
    expect(b.getState().routines).toEqual([]);
    expect(await storage.get(ROUTINES_STORAGE_KEY)).toEqual([]);
  });

  it("markFired never moves lastFiredAt backwards", () => {
    const r = store.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a"],
      schedule: daily("07:00"),
    });
    store.getState().markFired(r.id, 2000);
    store.getState().markFired(r.id, 1000);
    expect(store.getState().getRoutine(r.id)?.lastFiredAt).toBe(2000);
  });

  it("caps run history at the limit, newest first", () => {
    const r = store.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a"],
      schedule: { kind: "manual" },
    });
    for (let i = 0; i < ROUTINE_RUN_HISTORY_LIMIT + 5; i += 1) {
      store.getState().appendRun(r.id, {
        id: `run-${i}`,
        status: "ok",
        summary: `run ${i}`,
        invokedBy: "user",
        startedAt: i,
        finishedAt: i + 1,
      });
    }
    const runs = store.getState().getRoutine(r.id)?.runs ?? [];
    expect(runs).toHaveLength(ROUTINE_RUN_HISTORY_LIMIT);
    expect(runs[0].id).toBe(`run-${ROUTINE_RUN_HISTORY_LIMIT + 4}`);
  });
});

describe("scheduler", () => {
  it("fires due routines once, stamping before firing, and flags late runs", () => {
    const store = createRoutinesStore(createMemoryStorage());
    const r = store.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a"],
      schedule: daily("07:00"),
    });
    // Make yesterday's slot eligible relative to a fixed "now".
    const now = at(2026, 8, 12, 9, 30);
    store.setState({
      routines: store
        .getState()
        .routines.map((x) => ({ ...x, createdAt: at(2026, 8, 11, 6, 0) })),
    });

    const fire = vi.fn();
    const scheduler = createRoutineScheduler({
      list: () => store.getState().routines,
      markFired: (id, slotAt) => store.getState().markFired(id, slotAt),
      fire,
      now: () => now,
    });

    expect(scheduler.tick()).toEqual([r.id]);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0][1]).toEqual({ late: true });
    // The slot was stamped, so the next tick is quiet.
    expect(scheduler.tick()).toEqual([]);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("does not flag an on-time fire as late", () => {
    const store = createRoutinesStore(createMemoryStorage());
    store.getState().createRoutine({
      botId: "b1",
      name: "Briefing",
      steps: ["a"],
      schedule: daily("07:00"),
    });
    const now = at(2026, 8, 12, 7, 0, /* +30s via ms below */);
    store.setState({
      routines: store
        .getState()
        .routines.map((x) => ({ ...x, createdAt: at(2026, 8, 12, 6, 0) })),
    });
    const fire = vi.fn();
    createRoutineScheduler({
      list: () => store.getState().routines,
      markFired: (id, slotAt) => store.getState().markFired(id, slotAt),
      fire,
      now: () => now + 30_000,
    }).tick();
    expect(fire.mock.calls[0][1]).toEqual({ late: false });
  });
});

describe("save_routine tool", () => {
  const bot = { id: "b1", name: "Scout" } as Bot;
  const ctx = { bot, threadId: "b1" } as ToolContext;

  it("creates a routine for the calling bot and confirms in words", () => {
    const store = createRoutinesStore(createMemoryStorage());
    const tool = createSaveRoutineTool({
      create: (input) => store.getState().createRoutine(input),
    });
    const reply = tool.run(
      {
        name: "Morning briefing",
        steps: [" summarize inbox ", "post highlights"],
        schedule_kind: "daily",
        time: "07:00",
        days: [1, 2, 3, 4, 5],
      },
      ctx,
    );
    expect(reply).toContain("weekdays at 7:00 AM");
    const saved = store.getState().listRoutines("b1")[0];
    expect(saved.steps).toEqual(["summarize inbox", "post highlights"]);
    expect(saved.schedule).toEqual({
      kind: "daily",
      time: "07:00",
      days: [1, 2, 3, 4, 5],
    });
    expect(saved.mode).toBe("supervised");
    expect(tool.category).toBe("workspace-mutate");
  });

  it.each([
    [{ name: " ", steps: ["a"], schedule_kind: "manual" }, /name/],
    [{ name: "X", steps: [], schedule_kind: "manual" }, /steps/],
    [{ name: "X", steps: ["a"], schedule_kind: "hourly" }, /schedule_kind/],
    [{ name: "X", steps: ["a"], schedule_kind: "daily", time: "7am" }, /time/],
    [
      { name: "X", steps: ["a"], schedule_kind: "daily", time: "07:00", days: [7] },
      /days/,
    ],
    [
      { name: "X", steps: ["a"], schedule_kind: "daily", time: "07:00", days: [] },
      /days/,
    ],
  ])("rejects invalid args with a correctable error (%#)", (args, message) => {
    const create = vi.fn();
    const tool = createSaveRoutineTool({ create });
    expect(() => tool.run(args as Record<string, unknown>, ctx)).toThrow(message);
    expect(create).not.toHaveBeenCalled();
  });
});
