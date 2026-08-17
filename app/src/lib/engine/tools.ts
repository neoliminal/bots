// Tool registry for the engine run loop.
// Specs: openspec/specs/tool-extensibility/spec.md (registry, per-bot
// visibility filtering — a bot's model request only carries tools that
// survive its policy), openspec/specs/task-execution/spec.md (safe-action
// boundaries), openspec/specs/multi-bot-collaboration/spec.md (transparent
// peer delegation — tools may be offered/described per bot, e.g.
// contact_bot embeds teammates' capability cards and is offered whenever
// teammates exist; there is no coordinator gate).
import type { MemoryStore } from "./memory";
import { isVisible, type ActionCategory } from "./policy";
import type { Bot, ToolDef } from "./types";

/** Delegation run context carried by every loop run (chain safeguards). */
export interface ToolRunContext {
  /** Unique id of this run (delegation fan-out is tracked per runId). */
  runId: string;
  /**
   * Bot ids upstream of this run, oldest first, EXCLUDING the bot currently
   * running. Empty for a run started directly by the user.
   */
  ancestry: string[];
}

/** Context passed to every tool run. */
export interface ToolContext {
  bot: Bot;
  threadId: string;
  /** Delegation-chain context (set by runLoop; absent in bare tool tests). */
  run?: ToolRunContext;
  /**
   * Runtime-state key for this run: the instanceId for ephemeral-instance
   * runs, else the bot id. Tools driving runtime state should use
   * `ctx.runtimeId ?? ctx.bot.id`.
   */
  runtimeId?: string;
  /** Set when this run executes as an ephemeral instance of the bot. */
  instanceId?: string;
  /**
   * The memory store this run reads/writes (an instance's snapshot store for
   * ephemeral-instance runs). Memory tools prefer this over the bot's shared
   * canonical store so instance writes stay isolated until merge-back.
   */
  memory?: MemoryStore;
  /**
   * Cancellation for this run. Long-running tools (shell exec, MCP calls,
   * fetches) MUST honor it so Stop actually stops work already in flight,
   * not just the next model round.
   */
  signal?: AbortSignal;
}

export interface EngineTool {
  name: string;
  description: string;
  /** JSON Schema describing the arguments object. */
  parameters: Record<string, unknown>;
  /**
   * What kind of action this tool performs. The policy hook (policy.ts)
   * resolves each call to allow / approve / deny from this category, the
   * bot's ToolPolicy, and the hard floors — replacing the old per-tool
   * `gated` boolean.
   */
  category: ActionCategory;
  /**
   * Optional per-CALL re-categorization from the arguments. The policy hook
   * takes the tighter of `category` and this result, so it can only add
   * friction. This is what makes the `credential` and `payment` hard floors
   * reachable at all: no tool is inherently a payment, only a call is —
   * `browse_fill` typing into a password field, or a connector tool whose
   * name is payment-shaped. Return undefined to leave the category alone.
   *
   * Classification is always platform-assigned. A third-party server
   * supplies a tool's name and schema, never its category or classifier.
   */
  classify?(args: Record<string, unknown>): ActionCategory | undefined;
  /**
   * True when this tool's output is third-party controlled (web pages,
   * fetched files, shell output, MCP server responses). The run loop wraps
   * such output in an untrusted-content envelope and marks the run tainted,
   * which escalates the categories in ESCALATE_WHEN_TAINTED to approval.
   */
  untrustedOutput?: boolean;
  /**
   * Optional environment availability probe: is the tool usable at all
   * right now (running inside Tauri, provider credential present, MCP
   * server healthy)? A tool whose probe returns false is hidden from every
   * bot rather than offered-then-failing. Absent means always available.
   */
  available?(): boolean;
  /**
   * Optional per-bot availability probe (e.g. contact_bot is offered only
   * when the bot has teammates). Absent means available to every bot.
   */
  availableFor?(bot: Bot): boolean;
  /**
   * Optional per-bot description override (e.g. contact_bot embeds the
   * teammates' capability cards). Falls back to `description`.
   */
  describeFor?(bot: Bot): string;
  /** Execute the tool. The returned string is fed back to the model. */
  run(args: Record<string, unknown>, ctx: ToolContext): string | Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, EngineTool>();

  /** Register (or replace) a tool by name. */
  register(tool: EngineTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): EngineTool | undefined {
    return this.tools.get(name);
  }

  list(): EngineTool[] {
    return [...this.tools.values()];
  }

  /**
   * Tools visible to a specific bot: registry × environment availability
   * (`available`) × per-bot offering (`availableFor`) × the bot's tool
   * policy (`isVisible` — denied tools are hidden, never offered). This is
   * the visibility half of the policy pipeline; the model never sees the
   * schema of a tool excluded here.
   */
  listFor(bot: Bot): EngineTool[] {
    return this.list().filter(
      (t) =>
        (t.available === undefined || t.available()) &&
        (t.availableFor === undefined || t.availableFor(bot)) &&
        isVisible(bot, t),
    );
  }
}

/**
 * Map an engine tool to the OpenAI-style wire definition. When `forBot` is
 * given, per-bot dynamic descriptions (describeFor) are applied.
 */
export function toToolDef(tool: EngineTool, forBot?: Bot): ToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description:
        forBot !== undefined && tool.describeFor !== undefined
          ? tool.describeFor(forBot)
          : tool.description,
      parameters: tool.parameters,
    },
  };
}
