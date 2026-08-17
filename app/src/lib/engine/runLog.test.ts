import { describe, expect, it } from "vitest";
import {
  createRunLogStore,
  INTERRUPTED_CALL_OUTPUT,
  reconstructMessages,
  RUN_LOG_STORAGE_KEY,
  type RunLogEntry,
} from "./runLog";
import { createMemoryStorage } from "../storage";
import type { ThreadMessage } from "./types";

/** An assistant step requesting one call, then its result. */
function seedRun(
  store: ReturnType<typeof createRunLogStore>,
  runId: string,
  cmd: string,
  at = 1_000,
): void {
  store.getState().record({
    runId,
    botId: "b1",
    threadId: "t1",
    at,
    kind: "assistant-calls",
    text: "",
    calls: [{ id: `call-${cmd}`, name: "session_exec", argumentsJson: `{"cmd":"${cmd}"}` }],
  });
  store.getState().record({
    runId,
    botId: "b1",
    threadId: "t1",
    at: at + 1,
    kind: "tool-result",
    toolCallId: `call-${cmd}`,
    output: `ran ${cmd}`,
  });
}

describe("runLog (task-execution spec, 'Durable, resumable execution')", () => {
  it("persists on every append, not at run end", async () => {
    const storage = createMemoryStorage();
    const a = createRunLogStore(storage);
    seedRun(a, "run-1", "ls");

    // Nothing signalled completion; the steps must already be durable.
    const b = createRunLogStore(storage);
    await b.getState().hydrate();
    expect(b.getState().entriesFor("run-1")).toHaveLength(2);
    expect(await storage.get(RUN_LOG_STORAGE_KEY)).toBeDefined();
  });

  it("keeps runs separate", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "run-1", "ls");
    seedRun(store, "run-2", "pwd");
    expect(store.getState().entriesFor("run-1")).toHaveLength(2);
    expect(store.getState().entriesFor("run-2")).toHaveLength(2);
    expect(store.getState().openRuns()).toHaveLength(2);
  });

  it("drops a run's steps when it completes", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "run-1", "ls");
    seedRun(store, "run-2", "pwd");
    store.getState().complete("run-1");
    expect(store.getState().entriesFor("run-1")).toEqual([]);
    expect(store.getState().entriesFor("run-2")).toHaveLength(2);
    expect(store.getState().openRuns().map((r) => r.runId)).toEqual(["run-2"]);
  });

  it("completing an unknown run changes nothing", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "run-1", "ls");
    const before = store.getState().entries;
    store.getState().complete("run-nope");
    expect(store.getState().entries).toBe(before);
  });

  it("reports open runs newest first with their bot and thread", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "old", "ls", 1_000);
    seedRun(store, "new", "pwd", 5_000);
    const open = store.getState().openRuns();
    expect(open.map((r) => r.runId)).toEqual(["new", "old"]);
    expect(open[0]).toMatchObject({ botId: "b1", threadId: "t1", attempts: 0 });
    expect(open[0].at).toBe(5_001);
  });

  it("counts resume attempts durably, so a poison run stops retrying", async () => {
    const storage = createMemoryStorage();
    const a = createRunLogStore(storage);
    seedRun(a, "run-1", "ls");
    expect(a.getState().countAttempt("run-1")).toBe(1);
    expect(a.getState().countAttempt("run-1")).toBe(2);

    const b = createRunLogStore(storage);
    await b.getState().hydrate();
    expect(b.getState().openRuns()[0].attempts).toBe(2);
  });

  it("forgets attempts once the run completes", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "run-1", "ls");
    store.getState().countAttempt("run-1");
    store.getState().complete("run-1");
    expect(store.getState().attempts["run-1"]).toBeUndefined();
  });
});

describe("reconstructMessages (task-execution spec, 'Model-visible means logged')", () => {
  const history: ThreadMessage[] = [
    { role: "user", content: "clean up the temp files" },
  ];

  it("rebuilds system prompt, history and every recorded step in order", () => {
    const store = createRunLogStore(createMemoryStorage());
    seedRun(store, "run-1", "ls");
    const messages = reconstructMessages(
      "SYSTEM",
      history,
      store.getState().entriesFor("run-1"),
    );
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[2].tool_calls?.[0]).toMatchObject({
      id: "call-ls",
      type: "function",
      function: { name: "session_exec", arguments: '{"cmd":"ls"}' },
    });
    expect(messages[3]).toMatchObject({
      role: "tool",
      content: "ran ls",
      tool_call_id: "call-ls",
    });
  });

  it("is just system + history when a run has recorded nothing yet", () => {
    expect(reconstructMessages("SYSTEM", history, [])).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "clean up the temp files" },
    ]);
  });

  it("answers a call that was in flight when the app died, rather than leaving it dangling", () => {
    // A request whose assistant message carries a tool_call that no tool
    // message answers is malformed — providers reject it — so the step that
    // never finished has to be accounted for.
    const entries: RunLogEntry[] = [
      {
        id: "e1",
        runId: "r",
        botId: "b1",
        threadId: "t1",
        at: 1,
        kind: "assistant-calls",
        text: "",
        calls: [
          { id: "done", name: "session_exec", argumentsJson: "{}" },
          { id: "inflight", name: "session_exec", argumentsJson: "{}" },
        ],
      },
      {
        id: "e2",
        runId: "r",
        botId: "b1",
        threadId: "t1",
        at: 2,
        kind: "tool-result",
        toolCallId: "done",
        output: "finished",
      },
    ];
    const messages = reconstructMessages("SYSTEM", [], entries);
    const toolMessages = messages.filter((m) => m.role === "tool");
    // Every call is answered exactly once.
    expect(toolMessages.map((m) => m.tool_call_id).sort()).toEqual([
      "done",
      "inflight",
    ]);
    // The recorded one keeps its real output; the interrupted one says so
    // instead of inventing a plausible result.
    expect(toolMessages.find((m) => m.tool_call_id === "done")?.content).toBe(
      "finished",
    );
    expect(toolMessages.find((m) => m.tool_call_id === "inflight")?.content).toBe(
      INTERRUPTED_CALL_OUTPUT,
    );
  });

  it("preserves assistant text that accompanied the calls", () => {
    const entries: RunLogEntry[] = [
      {
        id: "e1",
        runId: "r",
        botId: "b1",
        threadId: "t1",
        at: 1,
        kind: "assistant-calls",
        text: "Let me look.",
        calls: [{ id: "c1", name: "read_file", argumentsJson: "{}" }],
      },
    ];
    expect(reconstructMessages("SYSTEM", [], entries)[1].content).toBe("Let me look.");
  });
});
