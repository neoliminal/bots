// The durable-run-log half of the loop (task-execution spec, "Durable,
// resumable execution" + "Model-visible means logged"). Kept beside
// loop.test.ts rather than inside it: these tests are about what survives a
// process death, which is a different question from what the loop computes.

import { describe, expect, it, vi } from "vitest";
import { createApprovalManager } from "./approvals";
import { createMemoryStorage } from "./bots";
import { runLoop } from "./loop";
import {
  createRunLogStore,
  reconstructMessages,
  type RunLogSink,
} from "./runLog";
import { createRuntime } from "./runtime";
import { ToolRegistry } from "./tools";
import type {
  Bot,
  ChatMessage,
  LoopChatFn,
  LoopChatRequest,
  LoopChatResult,
  ThreadMessage,
} from "./types";

function makeBot(): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    color: "#14b8a6",
    roleDescription: "Runs things",
    createdAt: 0,
    paused: false,
    deletedAt: null,
  };
}

function execRegistry(run: () => string = () => "ran ls") {
  const registry = new ToolRegistry();
  registry.register({
    name: "session_exec",
    description: "shell",
    parameters: { type: "object", properties: {} },
    category: "shell-local",
    run,
  });
  return registry;
}

/**
 * Scripted chat that captures the exact messages each round received.
 *
 * The messages array is snapshotted, not stored by reference: the loop
 * mutates one array in place across rounds, so keeping the reference would
 * make every recorded round show the run's FINAL state — and would quietly
 * turn the invariant check below into a comparison of a thing with itself.
 */
function scriptedChat(script: LoopChatResult[]): {
  chatStream: LoopChatFn;
  requests: LoopChatRequest[];
} {
  const requests: LoopChatRequest[] = [];
  const chatStream: LoopChatFn = async (req) => {
    requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    return script[Math.min(requests.length - 1, script.length - 1)]!;
  };
  return { chatStream, requests };
}

const CALL = {
  id: "call-1",
  name: "session_exec",
  argumentsJson: '{"cmd":"ls"}',
};

const HISTORY: ThreadMessage[] = [{ role: "user", content: "list the files" }];

const baseDeps = () => ({
  tools: execRegistry(),
  runtime: createRuntime(),
  approvals: createApprovalManager(),
  threadId: "thread-1",
});

describe("runLoop + run log", () => {
  it("records each step as it completes, then drops them when the run ends", async () => {
    const store = createRunLogStore(createMemoryStorage());
    const recorded: string[] = [];
    const sink: RunLogSink = {
      record: (entry) => {
        recorded.push(entry.kind);
        return store.getState().record(entry);
      },
      complete: store.getState().complete,
    };
    const { chatStream } = scriptedChat([
      { text: "", toolCalls: [CALL] },
      { text: "Done." },
    ]);

    const result = await runLoop(makeBot(), HISTORY, {
      ...baseDeps(),
      chatStream,
      runId: "run-1",
      runLog: sink,
    });

    expect(result).toBe("Done.");
    // Both step kinds were recorded, the assistant's calls BEFORE the result
    // (an interruption mid-call must still know what was outstanding)…
    expect(recorded).toEqual(["assistant-calls", "tool-result"]);
    // …and a finished run keeps nothing.
    expect(store.getState().entriesFor("run-1")).toEqual([]);
  });

  it("leaves the steps behind when the run never reaches an ending", async () => {
    // A process that quits mid-run never gets to run `finally`. Standing in
    // for that: a real run whose completion call is dropped on the floor.
    // Everything before it is genuine, so this exercises what a crash leaves
    // in the store rather than asserting against a hand-built fixture.
    const store = createRunLogStore(createMemoryStorage());
    const { chatStream } = scriptedChat([
      { text: "", toolCalls: [CALL] },
      { text: "Done." },
    ]);

    await runLoop(makeBot(), HISTORY, {
      ...baseDeps(),
      chatStream,
      runId: "run-2",
      runLog: { record: store.getState().record, complete: () => {} },
    });

    const open = store.getState().openRuns();
    expect(open.map((r) => r.runId)).toEqual(["run-2"]);
    expect(open[0]).toMatchObject({ botId: "bot-1", threadId: "thread-1" });
    expect(open[0].entries.map((e) => e.kind)).toEqual([
      "assistant-calls",
      "tool-result",
    ]);
  });

  it("a resumed run continues with its completed steps in context", async () => {
    const store = createRunLogStore(createMemoryStorage());
    // What an interrupted run left behind: one command already run.
    store.getState().record({
      runId: "run-3",
      botId: "bot-1",
      threadId: "thread-1",
      at: 1_000,
      kind: "assistant-calls",
      text: "",
      calls: [CALL],
    });
    store.getState().record({
      runId: "run-3",
      botId: "bot-1",
      threadId: "thread-1",
      at: 1_001,
      kind: "tool-result",
      toolCallId: "call-1",
      output: "ran ls",
    });

    const { chatStream, requests } = scriptedChat([{ text: "All done." }]);
    const result = await runLoop(makeBot(), HISTORY, {
      ...baseDeps(),
      chatStream,
      runId: "run-3",
      runLog: {
        record: store.getState().record,
        complete: store.getState().complete,
      },
      resumeFrom: store.getState().entriesFor("run-3"),
    });

    expect(result).toBe("All done.");
    // The model saw the earlier step rather than starting over.
    const sent = requests[0].messages as ChatMessage[];
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent[2].tool_calls?.[0].function.name).toBe("session_exec");
    expect(sent[3].content).toBe("ran ls");
  });

  it("behaves exactly as before when no run log is supplied", async () => {
    const { chatStream, requests } = scriptedChat([
      { text: "", toolCalls: [CALL] },
      { text: "Done." },
    ]);
    const result = await runLoop(makeBot(), HISTORY, { ...baseDeps(), chatStream });
    expect(result).toBe("Done.");
    expect((requests[0].messages as ChatMessage[]).map((m) => m.role)).toEqual([
      "system",
      "user",
    ]);
  });

  it("marks the run complete when it errors, so failures are not resumed", async () => {
    const store = createRunLogStore(createMemoryStorage());
    const chatStream: LoopChatFn = async () => {
      throw new Error("model exploded");
    };
    store.getState().record({
      runId: "run-4",
      botId: "bot-1",
      threadId: "thread-1",
      at: 1_000,
      kind: "assistant-calls",
      text: "",
      calls: [CALL],
    });

    await runLoop(makeBot(), HISTORY, {
      ...baseDeps(),
      chatStream,
      runId: "run-4",
      runLog: {
        record: store.getState().record,
        complete: store.getState().complete,
      },
      onError: vi.fn(),
    });

    expect(store.getState().entriesFor("run-4")).toEqual([]);
  });
});

describe("the invariant: model-visible means logged", () => {
  it("reconstruction from durable state matches what the live run assembled", async () => {
    const store = createRunLogStore(createMemoryStorage());
    const { chatStream, requests } = scriptedChat([
      { text: "looking", toolCalls: [CALL] },
      { text: "Done." },
    ]);

    await runLoop(makeBot(), HISTORY, {
      ...baseDeps(),
      chatStream,
      runId: "run-5",
      runLog: {
        // Record durably, but do NOT let completion clear it — this test
        // needs the steps the run recorded in order to compare against them.
        record: store.getState().record,
        complete: () => {},
      },
    });

    // The messages the live run sent on its final round…
    const live = requests[requests.length - 1].messages as ChatMessage[];
    // …rebuilt from durable state alone.
    const rebuilt = reconstructMessages(
      live[0].content,
      HISTORY,
      store.getState().entriesFor("run-5"),
    );

    expect(rebuilt).toEqual(live);
  });
});
