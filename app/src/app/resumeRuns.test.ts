// Resumption of interrupted runs (task-execution spec, "Durable, resumable
// execution"). Separate from chatGlue.test.ts because every test here starts
// from the state a crash leaves behind rather than from a user message.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../features/chat";
import { runLog, useBotsStore, type Bot } from "../lib/engine";
import {
  RESUME_MAX_AGE_MS,
  resumeInterruptedRuns,
  type StreamFn,
} from "./chatGlue";

const NOW = 1_000_000_000;

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

/** A stream that never resolves — enough to observe that a run STARTED. */
const hangingStream: StreamFn = () => new Promise(() => {});

/** Seed the log as an interrupted run would have left it. */
function seedInterrupted(runId: string, at: number, botId = "bot-1"): void {
  runLog.getState().record({
    runId,
    botId,
    threadId: botId,
    at,
    kind: "assistant-calls",
    text: "",
    calls: [{ id: "c1", name: "session_exec", argumentsJson: '{"cmd":"ls"}' }],
  });
  runLog.getState().record({
    runId,
    botId,
    threadId: botId,
    at: at + 1,
    kind: "tool-result",
    toolCallId: "c1",
    output: "ran ls",
  });
}

describe("resumeInterruptedRuns", () => {
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
    runLog.setState({ entries: [], attempts: {}, hydrated: true });
    vi.restoreAllMocks();
  });

  it("resumes a recent interrupted run and says so in the thread", async () => {
    seedInterrupted("run-1", NOW - 60_000);
    const resumed = await resumeInterruptedRuns(NOW, hangingStream);

    expect(resumed).toEqual(["run-1"]);
    const posted = (chatStore.getState().threads["bot-1"] ?? []).map((m) => m.text);
    expect(posted.some((t) => t.includes("Picking up where I left off"))).toBe(true);
  });

  it("leaves stale work alone rather than resurrecting it a day late", async () => {
    // A run's age is measured from its LAST step, which seedInterrupted
    // stamps at `at + 1`; back it well clear of the boundary.
    seedInterrupted("run-old", NOW - RESUME_MAX_AGE_MS - 60_000);
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual([]);
    // Not resumed, but not discarded either.
    expect(runLog.getState().entriesFor("run-old")).toHaveLength(2);
    expect(chatStore.getState().threads["bot-1"] ?? []).toHaveLength(0);
  });

  it("resumes a run sitting exactly on the age limit", async () => {
    // The boundary is inclusive: older THAN the limit is what disqualifies.
    seedInterrupted("run-edge", NOW - RESUME_MAX_AGE_MS - 1);
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual(["run-edge"]);
  });

  it("gives up on a run that has already been resumed twice (poison-run guard)", async () => {
    seedInterrupted("run-2", NOW - 60_000);
    runLog.getState().countAttempt("run-2");
    runLog.getState().countAttempt("run-2");
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual([]);
  });

  it("counts each resumption, so repeated crashes converge on giving up", async () => {
    seedInterrupted("run-3", NOW - 60_000);
    await resumeInterruptedRuns(NOW, hangingStream);
    expect(runLog.getState().attempts["run-3"]).toBe(1);
  });

  it("does not resume a paused or deleted bot's work", async () => {
    useBotsStore.setState({
      bots: [makeBot({ paused: true }), makeBot({ id: "bot-2", deletedAt: NOW })],
      hydrated: true,
    });
    seedInterrupted("run-paused", NOW - 60_000, "bot-1");
    seedInterrupted("run-deleted", NOW - 60_000, "bot-2");
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual([]);
  });

  it("resumes each interrupted run, newest first", async () => {
    useBotsStore.setState({
      bots: [makeBot(), makeBot({ id: "bot-2", name: "EA" })],
      hydrated: true,
    });
    seedInterrupted("run-older", NOW - 120_000, "bot-1");
    seedInterrupted("run-newer", NOW - 30_000, "bot-2");
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual([
      "run-newer",
      "run-older",
    ]);
  });

  it("does nothing when no run was interrupted", async () => {
    expect(await resumeInterruptedRuns(NOW, hangingStream)).toEqual([]);
    expect(chatStore.getState().threads["bot-1"] ?? []).toHaveLength(0);
  });
});
