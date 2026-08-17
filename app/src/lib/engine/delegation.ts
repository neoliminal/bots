// Transparent peer delegation: the contact_bot tool.
// Spec: openspec/specs/multi-bot-collaboration/spec.md — "Transparent peer
// delegation" (every bot may contact any teammate; no coordinator gate),
// "Delegation chain safeguards" (ancestry/cycle/depth/fan-out refusals,
// stop cancels the tree via runs.ts), "Ephemeral instances instead of
// blocking" (busy targets spawn an instance via instances.ts), and
// "Executive Assistant as a role, not a mechanism".
//
// The engine only emits a DelegationRequest through an injected callback;
// integration routes it as a visible delegation card, runs the target bot
// (or its ephemeral instance) concurrently, and resolves the returned
// promise with the target's report. The brief must be self-contained: the
// target never receives the originating thread.
import { makeId } from "./id";
import {
  botInstances,
  MAX_INSTANCES_PER_BOT,
  type InstanceRegistry,
} from "./instances";
import { botRuntime, type RuntimeStore } from "./runtime";
import { botRuns, DELEGATION_MAX_FAN_OUT, type RunTracker } from "./runs";
import type { EngineTool, ToolRegistry } from "./tools";

/** Maximum delegation hops from the originating request (chain depth cap). */
export const DELEGATION_MAX_DEPTH = 2;

export interface DelegationRequest {
  id: string;
  fromBotId: string;
  fromBotName: string;
  /** Name of the teammate being contacted. */
  targetBotName: string;
  /** Resolved teammate id (set when a teammate roster was injected). */
  targetBotId?: string;
  /**
   * The self-contained brief the target receives as its entire context —
   * the target does not see the originating thread.
   */
  brief: string;
  /** @deprecated Alias of `brief` kept for older integrations. */
  message: string;
  /** True when the requester expects a report back (vs. fire-and-forget). */
  expectReport: boolean;
  threadId: string;
  /** The requester's runId — register the delegated run as its child. */
  parentRunId: string;
  /**
   * Ancestry for the delegated run: upstream bot ids oldest first, ending
   * with the requesting bot. Pass as `ancestry` to the target's runLoop.
   */
  ancestry: string[];
  /**
   * Set when the target was busy and an ephemeral instance was spawned: run
   * the delegation on the instance (runLoop deps { instanceId, runtimeId:
   * instanceId, memory: registry.memoryOf(instanceId) }).
   */
  instanceId?: string;
}

/**
 * Injected by integration: deliver the brief to the target bot (or its
 * ephemeral instance) and resolve with its report (or a delivery
 * acknowledgement when expectReport is false). Rejections surface to the
 * model as a tool error result.
 */
export type DelegateFn = (request: DelegationRequest) => Promise<string>;

/** A teammate as the delegation tool sees it (roster injected by integration). */
export interface TeammateInfo {
  id: string;
  name: string;
  /** Role description — the card fallback when no capability card exists. */
  role: string;
  paused: boolean;
}

/** Capability-card text for one teammate (produced by cards.ts at integration). */
export interface TeammateCardText {
  botId: string;
  /** Bounded card text: role + experience summary + availability. */
  card: string;
}

export interface DelegationDeps {
  delegate: DelegateFn;
  /** Runtime feed to drive; defaults to the shared botRuntime. */
  runtime?: RuntimeStore;
  /**
   * The teammates a bot may contact (excluding itself). When absent the tool
   * is offered to every bot and target checks that need identity (cycle,
   * can-be-contacted, busy/instances) are left to the delegate callback.
   */
  getTeammates?: (forBotId: string) => TeammateInfo[];
  /**
   * Capability cards embedded in the tool description (multi-bot spec —
   * cards are "the reference peers use to decide whom to contact").
   * Fallback: each teammate's name + role.
   */
  getCards?: (forBotId: string) => TeammateCardText[];
  /** Per-bot can-be-contacted setting; absent means open within the team. */
  canBeContacted?: (botId: string) => boolean;
  /** Busy probe: true spawns an ephemeral instance instead of queueing. */
  isBusy?: (botId: string) => boolean;
  /** Instance registry; defaults to the shared botInstances. */
  instances?: InstanceRegistry;
  /** Run tracker for fan-out counting; defaults to the shared botRuns. */
  runs?: RunTracker;
}

/**
 * Exact refusal texts contact_bot returns as tool results — the model sees
 * why and adapts (handles the work itself or reports the limitation).
 */
export const delegationRefusals = {
  cycle: (targetName: string): string =>
    `Refused: contacting ${targetName} would create a delegation cycle — ` +
    `${targetName} is already in this request's delegation chain. Handle ` +
    "this part yourself or report the limitation.",
  depth: (): string =>
    `Refused: this request is already ${DELEGATION_MAX_DEPTH} delegation ` +
    "hops from the originating request — the chain depth limit. Handle the " +
    "work yourself or report the limitation.",
  fanOut: (): string =>
    `Refused: this run has already contacted ${DELEGATION_MAX_FAN_OUT} ` +
    "teammates — the fan-out limit. Work with the reports you have or " +
    "report the limitation.",
  paused: (targetName: string): string =>
    `Refused: ${targetName} is paused by the user and cannot take work ` +
    "right now. Proceed without them or surface the gap to the user.",
  notContactable: (targetName: string): string =>
    `Refused: ${targetName} has can-be-contacted disabled. Proceed without ` +
    "them or surface the gap to the user.",
  instanceCap: (targetName: string): string =>
    `Refused: ${targetName} is busy and already running ` +
    `${MAX_INSTANCES_PER_BOT} concurrent instances — the instance cap. ` +
    "Try again later or proceed without them.",
  unknownTeammate: (targetName: string): string =>
    `Error: no teammate named "${targetName}" — contact only the teammates ` +
    "listed in the contact_bot tool description.",
} as const;

const BASE_DESCRIPTION =
  "Contact a teammate bot to delegate work matching their capabilities or " +
  "request their expertise. Write a fully self-contained brief: the " +
  "teammate does NOT see this conversation, so include all context, " +
  "constraints, and the expected deliverable. When expectReport is true " +
  "(default) the result is the teammate's report. If a report surfaces a " +
  "decision only the user can make, put it to the user as ONE question " +
  "with options (choices marker) — never a list of open-ended questions.";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** Build every-bot contact_bot (teammates' capability cards in the description). */
export function createContactBotTool(deps: DelegationDeps): EngineTool {
  const teammatesFor = (botId: string): TeammateInfo[] | undefined =>
    deps.getTeammates?.(botId).filter((t) => t.id !== botId);

  return {
    name: "contact_bot",
    description: BASE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        botName: { type: "string", description: "Exact name of the teammate to contact." },
        brief: {
          type: "string",
          description:
            "Self-contained brief: all context, constraints, and the expected " +
            "deliverable. The teammate cannot see this conversation.",
        },
        expectReport: {
          type: "boolean",
          description: "Wait for and return the teammate's report (default true).",
        },
      },
      required: ["botName", "brief"],
    },
    category: "delegation",

    // Offered whenever the bot has teammates (unknown roster => offered;
    // integration injects getTeammates to scope it).
    availableFor: (bot) => {
      const teammates = teammatesFor(bot.id);
      return teammates === undefined || teammates.length > 0;
    },

    // The description embeds each teammate's capability card (fallback:
    // name + role) so the model routes by capability.
    describeFor: (bot) => {
      const teammates = teammatesFor(bot.id);
      if (teammates === undefined || teammates.length === 0) return BASE_DESCRIPTION;
      const cards = deps.getCards?.(bot.id) ?? [];
      const lines = teammates.map((t) => {
        const card = cards.find((c) => c.botId === t.id)?.card;
        return `- ${card ?? `${t.name} — ${t.role}`}`;
      });
      return `${BASE_DESCRIPTION}\n\nYour teammates:\n${lines.join("\n")}`;
    },

    run: async (args, ctx) => {
      const runtime = deps.runtime ?? botRuntime;
      const runs = deps.runs ?? botRuns;
      const instances = deps.instances ?? botInstances;

      const targetBotName = stringArg(args, "botName").trim();
      const brief = (stringArg(args, "brief") || stringArg(args, "message")).trim();
      if (targetBotName.length === 0 || brief.length === 0) {
        return "Error: contact_bot requires botName and brief.";
      }

      const runId = ctx.run?.runId ?? `${ctx.bot.id}:${ctx.threadId}`;
      const ancestry = ctx.run?.ancestry ?? [];
      const roster = teammatesFor(ctx.bot.id);
      const wanted = targetBotName.toLowerCase();
      const target = roster?.find((t) => t.name.trim().toLowerCase() === wanted);

      // --- Structural safeguards (multi-bot spec, "Delegation chain safeguards")
      if (roster !== undefined && target === undefined) {
        return delegationRefusals.unknownTeammate(targetBotName);
      }
      if (target !== undefined && (target.id === ctx.bot.id || ancestry.includes(target.id))) {
        return delegationRefusals.cycle(target.name);
      }
      if (ancestry.length >= DELEGATION_MAX_DEPTH) {
        return delegationRefusals.depth();
      }
      if (target !== undefined && target.paused) {
        return delegationRefusals.paused(target.name);
      }
      if (target !== undefined && deps.canBeContacted?.(target.id) === false) {
        return delegationRefusals.notContactable(target.name);
      }
      if (runs.fanOutOf(runId) >= DELEGATION_MAX_FAN_OUT) {
        return delegationRefusals.fanOut();
      }

      // --- Busy target: spawn an ephemeral instance instead of blocking.
      const requestId = makeId("delegation");
      let instanceId: string | undefined;
      if (target !== undefined && deps.isBusy?.(target.id) === true) {
        const spawned = instances.spawn(
          { id: target.id, name: target.name },
          { delegationId: requestId },
        );
        if (!spawned.ok) return delegationRefusals.instanceCap(target.name);
        instanceId = spawned.instance.instanceId;
      }

      runs.noteFanOut(runId);
      const request: DelegationRequest = {
        id: requestId,
        fromBotId: ctx.bot.id,
        fromBotName: ctx.bot.name,
        targetBotName: target?.name ?? targetBotName,
        ...(target !== undefined ? { targetBotId: target.id } : {}),
        brief,
        message: brief,
        expectReport: args.expectReport !== false,
        threadId: ctx.threadId,
        parentRunId: runId,
        ancestry: [...ancestry, ctx.bot.id],
        ...(instanceId !== undefined ? { instanceId } : {}),
      };

      // Requester shows talkingToBot while awaiting the peer's reply
      // (sleeping/paused wins; the loop resumes thinking afterwards).
      runtime.setBusyState(ctx.runtimeId ?? ctx.bot.id, "talkingToBot");
      try {
        const reply = await deps.delegate(request);
        // Awaited instance delegation finished: settle it (the delegated
        // runLoop settles it too when wired with instanceId — idempotent).
        if (instanceId !== undefined && request.expectReport) {
          instances.complete(instanceId);
        }
        return reply;
      } catch (err) {
        // A failed/cancelled instance delegation merges NOTHING.
        if (instanceId !== undefined) instances.abort(instanceId);
        return `Error: delegation to "${request.targetBotName}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  };
}

/** Register contact_bot on a registry (offered to every bot with teammates). */
export function registerDelegationTool(
  registry: ToolRegistry,
  deps: DelegationDeps,
): void {
  registry.register(createContactBotTool(deps));
}
