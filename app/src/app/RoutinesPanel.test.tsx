import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutinesPanel } from "./RoutinesPanel";
import { useRoutinesStore } from "../lib/engine";
import * as routineGlue from "./routineGlue";

function seed(name: string, botId = "bot-1") {
  return useRoutinesStore.getState().createRoutine({
    botId,
    name,
    steps: ["Check the tracker"],
    schedule: { kind: "daily", time: "07:00" },
  });
}

describe("RoutinesPanel (routines spec, 'Routine management')", () => {
  beforeEach(() => {
    useRoutinesStore.setState({ routines: [], hydrated: true });
    vi.restoreAllMocks();
  });

  it("teaches how to make one instead of offering a form", () => {
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);
    // Creation is conversational (design pillar: no typed schedules).
    expect(screen.getByText("No routines yet")).toBeInTheDocument();
    expect(screen.getByText(/Ask Scout to do something regularly/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("lists this bot's routines with their schedule in words", () => {
    seed("Morning briefing");
    seed("Someone else's", "bot-2");
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);

    const rows = screen.getAllByTestId("routine-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Morning briefing");
    expect(rows[0]).toHaveTextContent(/every day at/i);
    // New routines are supervised until the user promotes them.
    expect(rows[0]).toHaveTextContent("supervised");
  });

  it("runs one on demand", async () => {
    const routine = seed("Morning briefing");
    const run = vi.spyOn(routineGlue, "runRoutineNow").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);

    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(run).toHaveBeenCalledWith(routine.id, "user");
  });

  it("pauses and re-enables a routine, and says which state it is in", async () => {
    const routine = seed("Morning briefing");
    const user = userEvent.setup();
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);

    await user.click(screen.getByRole("button", { name: /Disable Morning briefing/ }));
    expect(useRoutinesStore.getState().getRoutine(routine.id)?.enabled).toBe(false);
    expect(screen.getByTestId("routine-row")).toHaveAttribute("data-enabled", "false");
    expect(screen.getByTestId("routine-row")).toHaveTextContent("paused");

    await user.click(screen.getByRole("button", { name: /Enable Morning briefing/ }));
    expect(useRoutinesStore.getState().getRoutine(routine.id)?.enabled).toBe(true);
  });

  it("asks before deleting, and deletion takes the history with it", async () => {
    const routine = seed("Morning briefing");
    const user = userEvent.setup();
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);

    await user.click(screen.getByRole("button", { name: /Delete Morning briefing/ }));
    expect(screen.getByText(/Delete this routine and its history\?/)).toBeInTheDocument();
    // Backing out leaves it alone.
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(useRoutinesStore.getState().getRoutine(routine.id)).toBeDefined();

    await user.click(screen.getByRole("button", { name: /Delete Morning briefing/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(useRoutinesStore.getState().getRoutine(routine.id)).toBeUndefined();
  });

  it("shows run history behind a toggle, newest first", async () => {
    const routine = seed("Morning briefing");
    const store = useRoutinesStore.getState();
    store.appendRun(routine.id, {
      id: "r1",
      status: "ok",
      summary: "Checked the tracker: 2 new errors.\nsecond line",
      invokedBy: "schedule",
      startedAt: Date.now() - 3_600_000,
      finishedAt: Date.now() - 3_599_000,
    });
    store.appendRun(routine.id, {
      id: "r2",
      status: "error",
      summary: "the host was unreachable",
      invokedBy: "schedule",
      startedAt: Date.now() - 60_000,
      finishedAt: Date.now() - 59_000,
    });
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);

    // Collapsed by default; the last run's recency is on the row.
    expect(screen.queryByTestId("routine-history")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Run history for Morning briefing/ }));

    const history = screen.getByTestId("routine-history");
    const items = within(history).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("host was unreachable");
    // Only the first line of a multi-line summary, so the list stays scannable.
    expect(items[1]).toHaveTextContent("2 new errors");
    expect(items[1]).not.toHaveTextContent("second line");
  });

  it("offers no history toggle before a routine has ever run", () => {
    seed("Morning briefing");
    render(<RoutinesPanel botId="bot-1" botName="Scout" />);
    expect(screen.queryByRole("button", { name: /Run history/ })).toBeNull();
  });
});
