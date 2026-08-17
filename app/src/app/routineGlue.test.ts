import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../features/chat";
import { useBotsStore, useRoutinesStore, type Bot } from "../lib/engine";
import {
  notifyTrigger,
  routineBrief,
  runRoutineNow,
  startRoutineScheduler,
  stopRoutineScheduler,
} from "./routineGlue";
import * as chatGlue from "./chatGlue";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    color: "#14b8a6",
    roleDescription: "Runs things",
    createdAt: 0,
    paused: false,
    deletedAt: null,
    ...overrides,
  };
}

/** A saved routine owned by bot-1. */
function seedRoutine(name = "Morning briefing") {
  return useRoutinesStore.getState().createRoutine({
    botId: "bot-1",
    name,
    steps: ["Check the error tracker", "Summarize what changed"],
    schedule: { kind: "daily", time: "07:00" },
  });
}

/** The routine-run cards in the bot's thread. */
function cards() {
  return (chatStore.getState().threads["bot-1"] ?? []).filter(
    (m) => m.meta?.kind === "routine-run",
  );
}

describe("routineGlue (routines spec)", () => {
  beforeEach(() => {
    chatStore.setState({
      threads: {},
      threadsById: {},
      unread: {},
      activeThreadId: null,
      activeBotId: null,
      hydrated: true,
    });
    useBotsStore.setState({ bots: [makeBot()], hydrated: true });
    useRoutinesStore.setState({ routines: [], hydrated: true });
    stopRoutineScheduler();
    vi.restoreAllMocks();
  });

  describe("the brief", () => {
    it("numbers the steps and says why it is running", () => {
      const routine = seedRoutine();
      const brief = routineBrief(routine, "schedule");
      expect(brief).toContain('"Morning briefing"');
      expect(brief).toContain("scheduled run");
      expect(brief).toContain("1. Check the error tracker");
      expect(brief).toContain("2. Summarize what changed");
    });

    it("tells a supervised routine to check before acting outward", () => {
      const routine = seedRoutine();
      expect(routineBrief(routine, "user")).toContain("still being validated");
    });

    it("drops that framing once the routine is autonomous", () => {
      const routine = seedRoutine();
      useRoutinesStore.getState().updateRoutine(routine.id, { mode: "autonomous" });
      const updated = useRoutinesStore.getState().getRoutine(routine.id)!;
      expect(routineBrief(updated, "schedule")).not.toContain("still being validated");
    });
  });

  describe("a run", () => {
    it("posts a card, runs the brief, and records the outcome", async () => {
      const routine = seedRoutine();
      const runBrief = vi
        .spyOn(chatGlue, "runBrief")
        .mockResolvedValue("Checked the tracker: 2 new errors.");

      await runRoutineNow(routine.id, "user");

      expect(runBrief).toHaveBeenCalledTimes(1);
      const [botId, threadId, brief] = runBrief.mock.calls[0];
      expect(botId).toBe("bot-1");
      expect(threadId).toBe("bot-1");
      expect(brief).toContain("Morning briefing");

      const card = cards()[0];
      expect(card.meta?.status).toBe("done");
      expect(card.meta?.report).toContain("2 new errors");
      expect(card.meta?.invokedBy).toBe("user");

      const [run] = useRoutinesStore.getState().getRoutine(routine.id)!.runs;
      expect(run.status).toBe("ok");
      expect(run.summary).toContain("2 new errors");
      expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    });

    it("records a failure without throwing at its caller", async () => {
      const routine = seedRoutine();
      vi.spyOn(chatGlue, "runBrief").mockRejectedValue(new Error("model exploded"));

      await expect(runRoutineNow(routine.id)).resolves.toBeUndefined();

      expect(cards()[0].meta?.status).toBe("failed");
      expect(cards()[0].meta?.error).toBe("model exploded");
      const [run] = useRoutinesStore.getState().getRoutine(routine.id)!.runs;
      expect(run.status).toBe("error");
    });

    it("distinguishes a stopped run from a failed one", async () => {
      const routine = seedRoutine();
      vi.spyOn(chatGlue, "runBrief").mockRejectedValue(
        new DOMException("cancelled", "AbortError"),
      );

      await runRoutineNow(routine.id);

      const [run] = useRoutinesStore.getState().getRoutine(routine.id)!.runs;
      expect(run.status).toBe("cancelled");
      expect(run.summary).toContain("Stopped");
    });

    it("says so when a run finishes with nothing to report", async () => {
      const routine = seedRoutine();
      vi.spyOn(chatGlue, "runBrief").mockResolvedValue("   ");
      await runRoutineNow(routine.id);
      expect(useRoutinesStore.getState().getRoutine(routine.id)!.runs[0].summary).toContain(
        "nothing to report",
      );
    });

    it("does nothing for a routine that no longer exists", async () => {
      const runBrief = vi.spyOn(chatGlue, "runBrief");
      await runRoutineNow("gone");
      expect(runBrief).not.toHaveBeenCalled();
      expect(cards()).toHaveLength(0);
    });

    it("marks a triggered run as triggered", async () => {
      const routine = seedRoutine();
      vi.spyOn(chatGlue, "runBrief").mockResolvedValue("done");
      await notifyTrigger(routine.id);
      expect(cards()[0].meta?.invokedBy).toBe("trigger");
    });
  });

  describe("the scheduler", () => {
    it("fires a due routine once, and not again for the same slot", async () => {
      const routine = seedRoutine();
      const runBrief = vi.spyOn(chatGlue, "runBrief").mockResolvedValue("done");
      // 07:30 local, the day after creation — the 07:00 slot has passed.
      const at = new Date();
      at.setHours(7, 30, 0, 0);
      const when = at.getTime() + 86_400_000;

      startRoutineScheduler({ tickMs: 1_000_000, now: () => when });
      await vi.waitFor(() => expect(runBrief).toHaveBeenCalledTimes(1));

      // A second tick at the same time must not re-fire the handled slot.
      stopRoutineScheduler();
      startRoutineScheduler({ tickMs: 1_000_000, now: () => when });
      await new Promise((r) => setTimeout(r, 10));
      expect(runBrief).toHaveBeenCalledTimes(1);
      expect(useRoutinesStore.getState().getRoutine(routine.id)!.lastFiredAt).toBeDefined();
    });

    it("does not fire a disabled routine", async () => {
      const routine = seedRoutine();
      useRoutinesStore.getState().updateRoutine(routine.id, { enabled: false });
      const runBrief = vi.spyOn(chatGlue, "runBrief").mockResolvedValue("done");
      const at = new Date();
      at.setHours(7, 30, 0, 0);

      startRoutineScheduler({ tickMs: 1_000_000, now: () => at.getTime() + 86_400_000 });
      await new Promise((r) => setTimeout(r, 10));
      expect(runBrief).not.toHaveBeenCalled();
    });

    it("starting twice does not double-fire (idempotent)", async () => {
      seedRoutine();
      const runBrief = vi.spyOn(chatGlue, "runBrief").mockResolvedValue("done");
      const at = new Date();
      at.setHours(7, 30, 0, 0);
      const when = at.getTime() + 86_400_000;

      startRoutineScheduler({ tickMs: 1_000_000, now: () => when });
      startRoutineScheduler({ tickMs: 1_000_000, now: () => when });
      await vi.waitFor(() => expect(runBrief).toHaveBeenCalledTimes(1));
    });
  });
});
