import { describe, expect, it, vi } from "vitest";
import { createApprovalManager } from "./approvals";
import {
  createContactBotTool,
  DELEGATION_MAX_DEPTH,
  delegationRefusals,
  registerDelegationTool,
  type DelegationDeps,
  type DelegationRequest,
  type TeammateInfo,
} from "./delegation";
import { createInstanceRegistry, MAX_INSTANCES_PER_BOT } from "./instances";
import { runLoop } from "./loop";
import { createMemoryStorage } from "./bots";
import { createMemoryStore } from "./memory";
import { createRunTracker } from "./runs";
import { createRuntime } from "./runtime";
import { ToolRegistry, type ToolContext } from "./tools";
import type { Bot, LoopChatFn, LoopChatRequest } from "./types";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "ea-1",
    name: "Atlas",
    color: "#8b5cf6",
    roleDescription: "My interface — take anything I ask and get it done",
    createdAt: Date.now(),
    paused: false,
    deletedAt: null,
    ...overrides,
  };
}

const TEAMMATES: TeammateInfo[] = [
  { id: "scout-1", name: "Scout", role: "Deep account research", paused: false },
  { id: "mailer-1", name: "Mailer", role: "Outbound email drafting", paused: false },
];

function makeDeps(overrides: Partial<DelegationDeps> = {}): DelegationDeps {
  return {
    delegate: vi.fn(async () => "report"),
    runtime: createRuntime(),
    runs: createRunTracker(),
    getTeammates: () => TEAMMATES,
    ...overrides,
  };
}

function ctxFor(
  bot: Bot,
  run: { runId: string; ancestry: string[] } = { runId: "run-1", ancestry: [] },
): ToolContext {
  return { bot, threadId: "t1", run };
}

describe("contact_bot availability and description", () => {
  it("is offered to EVERY bot with teammates — no coordinator gate", () => {
    const registry = new ToolRegistry();
    registerDelegationTool(registry, makeDeps());

    const anyBot = makeBot({ id: "b2", name: "Scout" });
    expect(registry.listFor(anyBot).map((t) => t.name)).toEqual(["contact_bot"]);
    // Legacy isCoordinator flags change nothing.
    expect(
      registry.listFor(makeBot({ isCoordinator: false })).map((t) => t.name),
    ).toEqual(["contact_bot"]);
  });

  it("is hidden when the bot has no teammates", () => {
    const registry = new ToolRegistry();
    registerDelegationTool(registry, makeDeps({ getTeammates: () => [] }));
    expect(registry.listFor(makeBot())).toEqual([]);
  });

  it("embeds teammates' capability cards in the per-bot description, with name+role fallback", () => {
    const tool = createContactBotTool(
      makeDeps({
        getCards: () => [
          { botId: "scout-1", card: "Scout (Research) — 12 account briefs completed; idle" },
        ],
      }),
    );
    const description = tool.describeFor!(makeBot());
    expect(description).toContain("Scout (Research) — 12 account briefs completed; idle");
    // No card for Mailer -> name + role fallback.
    expect(description).toContain("Mailer — Outbound email drafting");
    expect(description).toContain("self-contained brief");
  });

  it("excludes the bot itself from its own teammate roster", () => {
    const tool = createContactBotTool(
      makeDeps({
        getTeammates: () => [
          { id: "ea-1", name: "Atlas", role: "interface", paused: false },
        ],
      }),
    );
    expect(tool.availableFor!(makeBot())).toBe(false);
  });
});

describe("contact_bot delegation flow", () => {
  it("emits a self-contained DelegationRequest and resolves with the target's report", async () => {
    const runtime = createRuntime();
    const registry = new ToolRegistry();
    let resolveReply!: (reply: string) => void;
    const delegate = vi.fn(
      (_req: DelegationRequest) =>
        new Promise<string>((resolve) => {
          resolveReply = resolve;
        }),
    );
    registerDelegationTool(registry, makeDeps({ delegate, runtime }));

    const requests: LoopChatRequest[] = [];
    const chatStream: LoopChatFn = async (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "contact_bot",
              argumentsJson:
                '{"botName":"Scout","brief":"Research Acme Corp; deliver a 5-bullet brief.","expectReport":true}',
            },
          ],
        };
      }
      return { text: "Here is the synthesized answer." };
    };

    const pending = runLoop(makeBot(), [{ role: "user", content: "brief me on Acme" }], {
      chatStream,
      tools: registry,
      runtime,
      approvals: createApprovalManager(),
      threadId: "group-1",
      runId: "run-ea",
    });

    // While awaiting the peer's reply, the sender shows talkingToBot.
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledTimes(1));
    expect(runtime.getState("ea-1")).toBe("talkingToBot");
    const request = delegate.mock.calls[0]![0];
    expect(request).toMatchObject({
      fromBotId: "ea-1",
      fromBotName: "Atlas",
      targetBotId: "scout-1",
      targetBotName: "Scout",
      brief: "Research Acme Corp; deliver a 5-bullet brief.",
      message: "Research Acme Corp; deliver a 5-bullet brief.",
      expectReport: true,
      threadId: "group-1",
      parentRunId: "run-ea",
      // The child run's ancestry ends with the requester: the target never
      // receives the origin thread, only the brief + chain.
      ancestry: ["ea-1"],
    });
    expect(request.id).toBeTruthy();
    expect(request.instanceId).toBeUndefined();

    resolveReply("Acme brief: 5 bullets.");
    const result = await pending;
    expect(result).toBe("Here is the synthesized answer.");
    const toolMsg = requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ content: "Acme brief: 5 bullets.", tool_call_id: "c1" });
  });

  it("defaults expectReport to true and surfaces delegate failures as tool errors", async () => {
    const delegate = vi.fn().mockRejectedValue(new Error("target thread unavailable"));
    const tool = createContactBotTool(makeDeps({ delegate }));

    const result = await tool.run(
      { botName: "Scout", brief: "do the thing" },
      ctxFor(makeBot()),
    );

    expect(delegate.mock.calls[0]![0]).toMatchObject({ expectReport: true });
    expect(result).toBe(
      'Error: delegation to "Scout" failed: target thread unavailable',
    );
  });

  it("keeps sleeping state authoritative for the sender", async () => {
    const runtime = createRuntime();
    const tool = createContactBotTool(makeDeps({ runtime }));
    runtime.setState("ea-1", "sleeping");

    const result = await tool.run(
      { botName: "Scout", brief: "hi" },
      ctxFor(makeBot()),
    );

    expect(result).toBe("report");
    expect(runtime.getState("ea-1")).toBe("sleeping");
  });
});

describe("contact_bot structural safeguards", () => {
  it("refuses an unknown teammate with the exact message", async () => {
    const tool = createContactBotTool(makeDeps());
    const result = await tool.run({ botName: "Ghost", brief: "x" }, ctxFor(makeBot()));
    expect(result).toBe(
      'Error: no teammate named "Ghost" — contact only the teammates listed in the contact_bot tool description.',
    );
  });

  it("refuses a contact that would create a cycle (target already in ancestry)", async () => {
    const deps = makeDeps({
      getTeammates: () => [
        { id: "ea-1", name: "Atlas", role: "interface", paused: false },
        ...TEAMMATES,
      ],
    });
    const tool = createContactBotTool(deps);
    // Scout's run originated from Atlas: Scout delegating back to Atlas cycles.
    const scout = makeBot({ id: "scout-1", name: "Scout" });
    const result = await tool.run(
      { botName: "Atlas", brief: "please handle this" },
      ctxFor(scout, { runId: "run-scout", ancestry: ["ea-1"] }),
    );
    expect(result).toBe(
      "Refused: contacting Atlas would create a delegation cycle — Atlas is already in this request's delegation chain. Handle this part yourself or report the limitation.",
    );
    expect(deps.delegate).not.toHaveBeenCalled();
  });

  it("refuses when the chain is already at the depth cap (2 hops)", async () => {
    const deps = makeDeps();
    const tool = createContactBotTool(deps);
    // This run is 2 hops from the originating request (A -> B -> me).
    const result = await tool.run(
      { botName: "Scout", brief: "go deeper" },
      ctxFor(makeBot({ id: "c-1", name: "Cataloger" }), {
        runId: "run-c",
        ancestry: ["a-1", "b-1"],
      }),
    );
    expect(DELEGATION_MAX_DEPTH).toBe(2);
    expect(result).toBe(
      "Refused: this request is already 2 delegation hops from the originating request — the chain depth limit. Handle the work yourself or report the limitation.",
    );
    expect(deps.delegate).not.toHaveBeenCalled();
  });

  it("refuses the 4th delegation in one run (fan-out cap 3)", async () => {
    const deps = makeDeps();
    const tool = createContactBotTool(deps);
    const ctx = ctxFor(makeBot());

    for (let i = 0; i < 3; i++) {
      const ok = await tool.run({ botName: "Scout", brief: `task ${i}` }, ctx);
      expect(ok).toBe("report");
    }
    const fourth = await tool.run({ botName: "Mailer", brief: "one more" }, ctx);
    expect(fourth).toBe(
      "Refused: this run has already contacted 3 teammates — the fan-out limit. Work with the reports you have or report the limitation.",
    );
    expect(deps.delegate).toHaveBeenCalledTimes(3);
  });

  it("refusals do not consume fan-out budget", async () => {
    const deps = makeDeps();
    const tool = createContactBotTool(deps);
    const ctx = ctxFor(makeBot());
    for (let i = 0; i < 5; i++) {
      await tool.run({ botName: "Ghost", brief: "x" }, ctx); // unknown — refused
    }
    expect(await tool.run({ botName: "Scout", brief: "real work" }, ctx)).toBe("report");
  });

  it("refuses a paused target with the exact message", async () => {
    const deps = makeDeps({
      getTeammates: () => [
        { id: "scout-1", name: "Scout", role: "research", paused: true },
      ],
    });
    const tool = createContactBotTool(deps);
    const result = await tool.run({ botName: "Scout", brief: "x" }, ctxFor(makeBot()));
    expect(result).toBe(
      "Refused: Scout is paused by the user and cannot take work right now. Proceed without them or surface the gap to the user.",
    );
    expect(deps.delegate).not.toHaveBeenCalled();
  });

  it("refuses a target with can-be-contacted disabled", async () => {
    const deps = makeDeps({ canBeContacted: (botId) => botId !== "scout-1" });
    const tool = createContactBotTool(deps);
    const result = await tool.run({ botName: "Scout", brief: "x" }, ctxFor(makeBot()));
    expect(result).toBe(
      "Refused: Scout has can-be-contacted disabled. Proceed without them or surface the gap to the user.",
    );
    expect(deps.delegate).not.toHaveBeenCalled();
    // Other teammates remain reachable.
    expect(await tool.run({ botName: "Mailer", brief: "x" }, ctxFor(makeBot()))).toBe(
      "report",
    );
  });

  it("matches the exported refusal builders exactly", () => {
    expect(delegationRefusals.cycle("Atlas")).toContain("delegation cycle");
    expect(delegationRefusals.instanceCap("Scout")).toBe(
      `Refused: Scout is busy and already running ${MAX_INSTANCES_PER_BOT} concurrent instances — the instance cap. Try again later or proceed without them.`,
    );
  });
});

describe("contact_bot ephemeral instances (busy targets)", () => {
  function busySetup(overrides: Partial<DelegationDeps> = {}) {
    const storage = createMemoryStorage();
    const canonical = createMemoryStore("scout-1", storage);
    const instances = createInstanceRegistry({
      getCanonicalStore: () => canonical,
      runtime: createRuntime(),
      storage: () => storage,
    });
    const deps = makeDeps({ isBusy: () => true, instances, ...overrides });
    return { canonical, instances, deps, tool: createContactBotTool(deps) };
  }

  it("spawns an instance for a busy target and carries instanceId on the request", async () => {
    const seen: DelegationRequest[] = [];
    const { instances, deps, tool } = busySetup({
      delegate: vi.fn(async (req: DelegationRequest) => {
        seen.push(req);
        return "instance report";
      }),
    });

    const result = await tool.run(
      { botName: "Scout", brief: "parallel research" },
      ctxFor(makeBot()),
    );

    expect(result).toBe("instance report");
    const request = seen[0]!;
    expect(request.instanceId).toBeTruthy();
    const instance = instances.get(request.instanceId!)!;
    expect(instance.parentBotId).toBe("scout-1");
    expect(instance.parentBotName).toBe("Scout");
    // Awaited delegation completed -> the instance settled (merged).
    expect(instances.get(request.instanceId!)?.state).toBe("completed");
    expect(deps.delegate).toHaveBeenCalledTimes(1);
  });

  it("refuses the 4th concurrent delegation to a busy bot (instance cap 3)", async () => {
    const gate: Array<(reply: string) => void> = [];
    const { instances, deps, tool } = busySetup({
      delegate: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            gate.push(resolve);
          }),
      ),
    });
    // Four different requesters hit the busy Scout simultaneously.
    const pending = ["r1", "r2", "r3"].map((runId) =>
      tool.run(
        { botName: "Scout", brief: `task ${runId}` },
        ctxFor(makeBot({ id: `caller-${runId}`, name: runId }), { runId, ancestry: [] }),
      ),
    );
    await vi.waitFor(() => expect(gate).toHaveLength(3));
    expect(instances.listRunning("scout-1")).toHaveLength(3);

    const fourth = await tool.run(
      { botName: "Scout", brief: "task r4" },
      ctxFor(makeBot({ id: "caller-r4", name: "r4" }), { runId: "r4", ancestry: [] }),
    );
    expect(fourth).toBe(
      `Refused: Scout is busy and already running ${MAX_INSTANCES_PER_BOT} concurrent instances — the instance cap. Try again later or proceed without them.`,
    );
    expect(deps.delegate).toHaveBeenCalledTimes(3);

    // Draining one instance frees capacity for the next delegation.
    gate[0]!("done");
    await pending[0];
    expect(instances.listRunning("scout-1")).toHaveLength(2);
    gate[1]!("done");
    gate[2]!("done");
    await Promise.all(pending);
  });

  it("a failed instance delegation aborts the instance — nothing merges", async () => {
    const { canonical, instances, tool } = busySetup({
      delegate: vi.fn(async (req: DelegationRequest) => {
        // Instance wrote memory mid-run, then the run crashed.
        instances.memoryOf(req.instanceId!)!.remember("half-finished learning");
        throw new Error("instance crashed");
      }),
    });

    const result = await tool.run(
      { botName: "Scout", brief: "doomed" },
      ctxFor(makeBot()),
    );

    expect(result).toBe('Error: delegation to "Scout" failed: instance crashed');
    const spawned = instances.list("scout-1")[0]!;
    expect(spawned.state).toBe("aborted");
    expect(canonical.list()).toEqual([]); // canonical untouched
    expect(instances.mergeHistoryOf("scout-1")).toEqual([]);
  });
});
