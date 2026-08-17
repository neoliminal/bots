// Glue between the chat store, the bot engine, and the OpenRouter client:
// a user message becomes an engine runLoop call (engine v2) whose streamed
// reply is written back into the chat store, with usage logged per delivery.
//
// The run loop gives every bot the app tool registry (workspace fs,
// web_fetch, send_email, memory tools); gated tools park a PendingApproval
// on the shared botApprovals manager, which the approvals UI resolves to
// resume the bot (human-handoff spec).
//
// Transparent peer delegation (multi-bot-collaboration spec): every bot with
// teammates gets contact_bot, whose per-bot description embeds live
// capability cards (role + platform-derived experience from the work record
// + live availability). A delegation renders as an inline delegation card in
// the ORIGINATING thread (target bot, brief, live status, report — direct
// threads included; no group thread required), the target's own thread
// records its side, and a busy target never blocks: the engine spawns an
// ephemeral instance that runs the brief concurrently from a memory
// snapshot, merging learnings back on success (bot-memory spec).
//
// Completed deliveries are appended to the bot's work record (worklog.ts),
// from which its capability card's experience summary is compiled/versioned.
//
// Deliveries are serialized per bot (spec: openspec/specs/messaging,
// "Reliable delivery" — processed in order) and every run — in flight OR
// still queued — is abortable (spec: "Interruption and cancellation").
// Every run is registered in the engine's run tracker (runs.ts) with its
// parentRunId, so Stop cancels the ENTIRE delegation tree (multi-bot spec,
// "Stop cancels the tree"): cancelThreadDelivery aborts each of the
// thread's runs and their descendants; cancelBotRuns (deletion) also halts
// the bot's ephemeral instances. Aborting a run withdraws its pending
// approval.

import { chatStream as realChatStream } from "../lib/openrouter";
import type { ChatResult, ChatStreamParams } from "../lib/openrouter";
import {
  BotPausedError,
  botInstances,
  botRuns,
  botRuntime,
  buildCapabilityCard,
  compileExperience,
  deriveAvailability,
  getCardStore,
  getContactPermissionsStore,
  getMemoryStore,
  getWorklogStore,
  haltInstances,
  hydrateWorklog,
  recordCompletedWork,
  discoverSkills,
  registerDelegationTool,
  runLog,
  runLoop,
  MAX_RESUME_ATTEMPTS,
  useBotsStore,
  type AvailabilityState,
  type Bot,
  type DelegationRequest,
  type LoopChatFn,
  type RunLogEntry,
  type SkillPack,
  type TeammateCardText,
  type TeammateInfo,
  type ThreadMessage,
  type ToolCallRequest,
} from "../lib/engine";
import { workspaceList, workspaceRead } from "../lib/native";
import { chatStore, type ChoiceBlock, type MessageMeta } from "../features/chat";
import {
  selectModelForRole,
  useModelConfigStore,
  useUsageStore,
} from "../features/models";
import { appToolRegistry } from "./tools";
import { notifyBotFinished } from "./notifications";

export type StreamFn = (params: ChatStreamParams) => Promise<ChatResult>;

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Thread history as seen by `botId`: completed (delivered, non-streaming)
 * messages in thread order. The bot's own replies map to `assistant`; user
 * messages and other bots' messages map to `user` (teammate messages are
 * prefixed with the author's name so the model can attribute them). When
 * `targetMessageId` is given — the user message being delivered — it is
 * appended last, and other still-pending messages are excluded.
 */
export function threadHistoryFor(
  threadId: string,
  botId: string,
  targetMessageId?: string,
): ThreadMessage[] {
  const thread = chatStore.getState().threads[threadId] ?? [];
  const completed = thread.filter(
    (m) =>
      m.id !== targetMessageId &&
      m.status === "delivered" &&
      !m.streaming &&
      m.text.trim() !== "" &&
      // Session timeline events (lifecycle indicators, sync warnings) are
      // for the user, not model context.
      m.meta?.kind !== "session",
  );
  const target =
    targetMessageId === undefined
      ? undefined
      : thread.find((m) => m.id === targetMessageId && m.status !== "error");
  const bots = useBotsStore.getState();
  return (target ? [...completed, target] : completed).map((m) => {
    if (m.role === "user") return { role: "user" as const, content: m.text };
    const author = m.authorBotId;
    if (author === undefined || author === botId) {
      return { role: "assistant" as const, content: m.text };
    }
    const name = bots.getBot(author)?.name ?? "teammate";
    return { role: "user" as const, content: `[${name}] ${m.text}` };
  });
}

/** Compat: direct-thread history (direct threadId === botId). */
export function threadHistory(botId: string, targetMessageId?: string): ThreadMessage[] {
  return threadHistoryFor(botId, botId, targetMessageId);
}

/**
 * The bot a user message in this thread is delivered to. Direct threads
 * resolve to their sole bot. Group threads resolve to the first active
 * participant (a legacy coordinator flag from older stores is still honored
 * as an ordering preference, but there is no coordinator mechanism — any
 * participant can delegate to any teammate via contact_bot).
 */
export function threadTargetBot(threadId: string): Bot | undefined {
  const thread = chatStore.getState().threadsById[threadId];
  const bots = useBotsStore.getState();
  const participants = (thread?.participantBotIds ?? [threadId])
    .map((id) => bots.getBot(id))
    .filter((b): b is Bot => b !== undefined && !b.deletedAt);
  if (participants.length === 0) return undefined;
  return participants.find((b) => b.isCoordinator === true) ?? participants[0];
}

// ---------------------------------------------------------------------------
// Capability cards (multi-bot-collaboration spec, "Capability cards")
// ---------------------------------------------------------------------------

/** Live card availability for a bot: runtime state + paused flag. */
export function botAvailability(botId: string): AvailabilityState {
  const paused = useBotsStore.getState().getBot(botId)?.paused === true;
  return deriveAvailability(botRuntime.getState(botId), paused);
}

/**
 * One-line capability card for a teammate, embedded in peers' contact_bot
 * descriptions: name + live availability + user-authored role + the
 * platform-derived experience summary (user pin wins when set). Synchronous
 * compile over the shared worklog/card stores (hydrated at bootstrap).
 */
export function capabilityCardText(bot: Bot): string {
  const worklog = getWorklogStore(bot.id).list();
  const pin = getCardStore(bot.id).getPin();
  const experience = pin ?? compileExperience(worklog);
  const role = bot.roleDescription.trim() || "no role description";
  return `${bot.name} [${botAvailability(bot.id)}] — ${role} | Experience: ${experience}`;
}

// ---------------------------------------------------------------------------
// Choice chips (messaging spec, "Structured choice prompts")
// ---------------------------------------------------------------------------

/** An assistant reply split into display text and an optional choice block. */
export interface ParsedChoices {
  /** The reply with the structured marker stripped out. */
  text: string;
  /** The parsed choice block, when the reply carried a valid marker. */
  choices?: ChoiceBlock;
}

/**
 * The structured marker a bot emits at the END of a reply to offer choice
 * chips: `<<choices>>["Option A","Option B"]<</choices>>` or
 * `<<choices>>{"prompt":"…","options":["A","B"]}<</choices>>`.
 *
 * The closer is lenient — `<</choices>>`, a slashless `<<choices>>`, or
 * nothing at all — because models regularly botch it, and the failure mode
 * (raw JSON rendered in the bubble) is worse than accepting a sloppy close.
 * The payload still has to be valid JSON at the very end of the reply.
 */
const CHOICES_MARKER = /\s*<<choices>>\s*([\s\S]+?)\s*(?:<<\/?choices>>)?\s*$/;

/**
 * Shown when a reply is NOTHING but a promptless marker (array form, no
 * surrounding text): the options must still render as chips, so the bubble
 * gets this generic prompt instead of silently dropping the reply.
 */
export const CHOICES_FALLBACK_PROMPT = "Choose an option:";

/**
 * Strip a trailing choices marker from an assistant reply and parse it into
 * a `ChoiceBlock`. Malformed markers (bad JSON, no usable string options)
 * are left in the text untouched — the reply then renders as-is rather than
 * silently losing content the model produced.
 */
export function parseChoicesMarker(fullText: string): ParsedChoices {
  const match = CHOICES_MARKER.exec(fullText);
  if (!match) return { text: fullText };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { text: fullText };
  }

  let rawOptions: unknown;
  let prompt: string | undefined;
  if (Array.isArray(parsed)) {
    rawOptions = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    rawOptions = obj.options;
    if (typeof obj.prompt === "string" && obj.prompt.trim() !== "") {
      prompt = obj.prompt;
    }
  } else {
    return { text: fullText };
  }

  if (!Array.isArray(rawOptions)) return { text: fullText };
  const options = rawOptions.filter(
    (o): o is string => typeof o === "string" && o.trim() !== "",
  );
  if (options.length === 0) return { text: fullText };

  return {
    text: fullText.slice(0, match.index),
    choices: { ...(prompt === undefined ? {} : { prompt }), options },
  };
}

/** Cut a task title out of free text (first-line snippet, bounded). */
export function taskTitleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= 80 ? t : `${t.slice(0, 79).trimEnd()}…`;
}

/** What a run did, collected for the bot's work record. */
interface WorkCollector {
  toolsUsed: string[];
  deliverables: string[];
  learnedCorrection?: string;
  onToolResult: (call: ToolCallRequest, result: string) => void;
}

function makeWorkCollector(): WorkCollector {
  const collector: WorkCollector = {
    toolsUsed: [],
    deliverables: [],
    onToolResult: (call, result) => {
      if (result.startsWith("Error:")) return;
      if (!collector.toolsUsed.includes(call.name)) collector.toolsUsed.push(call.name);
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.argumentsJson || "{}");
        if (typeof parsed === "object" && parsed !== null) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        return;
      }
      if (call.name === "workspace_write" && typeof args.path === "string") {
        collector.deliverables.push(args.path);
      }
      if (
        call.name === "remember_memory" &&
        typeof args.text === "string" &&
        collector.learnedCorrection === undefined
      ) {
        collector.learnedCorrection = args.text;
      }
    },
  };
  return collector;
}

/**
 * Append a completed delivery to the bot's work record and re-publish its
 * capability card (versioned) so teammates route by real experience.
 */
async function recordDeliveredWork(
  botId: string,
  taskTitle: string,
  threadId: string,
  work: WorkCollector,
): Promise<void> {
  try {
    await recordCompletedWork(botId, {
      taskTitle,
      threadId,
      toolsUsed: [...work.toolsUsed],
      deliverables: [...work.deliverables],
      ...(work.learnedCorrection !== undefined
        ? { learnedCorrection: work.learnedCorrection }
        : {}),
      at: Date.now(),
    });
    const bot = useBotsStore.getState().getBot(botId);
    if (!bot || bot.deletedAt) return;
    const store = await hydrateWorklog(botId);
    await buildCapabilityCard(
      { id: bot.id, name: bot.name, roleDescription: bot.roleDescription },
      store.list(),
      botAvailability(botId),
    );
  } catch (err) {
    console.error("[chat] failed to record completed work:", err);
  }
}

// ---------------------------------------------------------------------------
// Run tracking (delegation trees + cancellation)
// ---------------------------------------------------------------------------

/** One tracked run (a delivery or a delegation) known to the glue. */
interface RunHandle {
  botId: string;
  threadId: string;
  /** Engine run id — the node in botRuns' delegation tree. */
  runId: string;
  controller: AbortController;
}

/**
 * Every enqueued run, queued or in flight. Controllers are created when the
 * run is ENQUEUED (not when it starts), so Stop and bot deletion reach runs
 * still waiting behind other work on a bot's serial queue.
 */
const activeRuns = new Set<RunHandle>();

/** Per-bot delivery queue tails (runs execute strictly in order). */
const queueTails = new Map<string, Promise<unknown>>();

/** Stream function of each bot's in-flight delivery (delegation reuses it). */
const activeStreams = new Map<string, StreamFn>();

/** Enqueue a run on a bot's serial queue. */
function enqueue<T>(botId: string, run: () => Promise<T>): Promise<T> {
  const prev = queueTails.get(botId) ?? Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.catch(() => undefined);
  queueTails.set(botId, tail);
  void tail.then(() => {
    if (queueTails.get(botId) === tail) queueTails.delete(botId);
  });
  return next;
}

/**
 * Start an abortable, tree-tracked run. Its controller is registered
 * immediately (so Stop reaches queued runs) and the run is registered in the
 * engine run tracker under `runId` (with `parentRunId` for delegated runs,
 * so aborting an ancestor cancels it too). `queue: false` runs concurrently
 * — used for ephemeral-instance delegations, which must never wait behind
 * the busy canonical bot.
 */
function startRun<T>(
  botId: string,
  threadId: string,
  runId: string,
  parentRunId: string | undefined,
  run: (controller: AbortController) => Promise<T>,
  options: { queue: boolean } = { queue: true },
): Promise<T> {
  const handle: RunHandle = { botId, threadId, runId, controller: new AbortController() };
  activeRuns.add(handle);
  botRuns.register(runId, {
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    abort: () => {
      handle.controller.abort();
    },
  });
  const exec = (): Promise<T> => run(handle.controller);
  const result = options.queue ? enqueue(botId, exec) : exec();
  const finish = (): void => {
    activeRuns.delete(handle);
    botRuns.complete(runId);
  };
  void result.then(finish, finish);
  return result;
}

/**
 * Abort the bot's direct-thread runs (spec: messaging, cancellation). A
 * direct thread's id is the bot's id, so this never touches work the same
 * bot is doing for a group thread.
 */
export function cancelDelivery(botId: string): void {
  cancelThreadDelivery(botId);
}

/**
 * Abort every run belonging to a thread (Stop): the in-flight delivery, any
 * delegation still queued behind other work, AND — via the engine run tree —
 * every descendant of those runs (multi-bot spec, "Stop cancels the tree").
 * Runs the same bots own in OTHER threads are left alone.
 */
export function cancelThreadDelivery(threadId: string): void {
  for (const run of [...activeRuns]) {
    if (run.threadId !== threadId) continue;
    botRuns.abortTree(run.runId);
    run.controller.abort();
  }
}

/**
 * Abort every run a bot owns, in any thread, halt its ephemeral instances
 * (no merge for interrupted work), and cancel each run's delegation subtree.
 * Aborting a run's signal also withdraws its parked approvals. Used when a
 * bot is deleted — deletion stops all its activity immediately.
 */
export function cancelBotRuns(botId: string): void {
  haltInstances(botId);
  for (const run of [...activeRuns]) {
    if (run.botId !== botId) continue;
    botRuns.abortTree(run.runId);
    run.controller.abort();
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) && err.name === "AbortError"
  );
}

/** Usage accumulated across every model round of one run. */
interface UsageAcc {
  promptTokens: number;
  completionTokens: number;
  cost: number | undefined;
  sawUsage: boolean;
}

/** Adapt the OpenRouter-style StreamFn to the engine's LoopChatFn, accumulating usage. */
function makeLoopStream(stream: StreamFn, modelId: string, acc: UsageAcc): LoopChatFn {
  return async ({ messages, tools, onDelta, signal }) => {
    const result = await stream({
      model: modelId,
      messages,
      ...(tools !== undefined ? { tools } : {}),
      onDelta,
      signal,
    });
    if (result.usage) {
      acc.sawUsage = true;
      acc.promptTokens += result.usage.promptTokens;
      acc.completionTokens += result.usage.completionTokens;
      if (result.usage.cost !== undefined) {
        acc.cost = (acc.cost ?? 0) + result.usage.cost;
      }
    }
    return {
      text: result.message.content,
      ...(result.toolCalls !== undefined && result.toolCalls.length > 0
        ? { toolCalls: result.toolCalls }
        : {}),
    };
  };
}

/**
 * Discover the bot's authored skills (skills/<dir>/SKILL.md in its
 * workspace) for prompt injection. Best-effort: a failed discovery returns
 * [] — skills must never block a run. Outside Tauri the workspace lists
 * empty.
 */
async function loadSkillsFor(botId: string): Promise<SkillPack[]> {
  try {
    return await discoverSkills(
      {
        listPaths: async (id) =>
          (await workspaceList(id)).filter((e) => !e.isDir).map((e) => e.path),
        readFile: (id, path) => workspaceRead(id, path),
      },
      botId,
    );
  } catch {
    return [];
  }
}

function recordUsage(botId: string, modelId: string, acc: UsageAcc): void {
  if (!acc.sawUsage) return;
  useUsageStore.getState().recordUsage({
    botId,
    modelId,
    promptTokens: acc.promptTokens,
    completionTokens: acc.completionTokens,
    ...(acc.cost !== undefined ? { cost: acc.cost } : {}),
  });
}

async function deliverNow(
  threadId: string,
  botId: string,
  /**
   * The user message being delivered. Empty when RESUMING an interrupted
   * run: there is no new message, the original is already delivered and in
   * the thread, and the store's mark* calls no-op on an unknown id.
   */
  userMessageId: string,
  runId: string,
  stream: StreamFn,
  controller: AbortController,
  /** Steps an earlier attempt at this run already completed. */
  resumeFrom?: readonly RunLogEntry[],
): Promise<void> {
  const bot = useBotsStore.getState().getBot(botId);
  if (!bot || bot.deletedAt) {
    chatStore.getState().markError(threadId, userMessageId);
    return;
  }
  // Stopped while still queued: deliver nothing (mirrors the abort path below).
  if (controller.signal.aborted) {
    chatStore.getState().markDelivered(threadId, userMessageId);
    return;
  }

  const modelId = selectModelForRole(useModelConfigStore.getState(), botId, "primary");
  const history = threadHistoryFor(threadId, botId, userMessageId);
  const userText =
    (chatStore.getState().threads[threadId] ?? []).find((m) => m.id === userMessageId)
      ?.text ?? "";
  const botMessageId = newId();
  activeStreams.set(botId, stream);

  const acc: UsageAcc = {
    promptTokens: 0,
    completionTokens: 0,
    cost: undefined,
    sawUsage: false,
  };
  const work = makeWorkCollector();
  let settled = false;
  // Every delta the user watched stream, across ALL model rounds. onDone's
  // fullText is only the FINAL round's text, so the accumulated stream —
  // not fullText — is what the finished bubble must preserve.
  let streamed = "";

  try {
    await runLoop(bot, history, {
      tools: appToolRegistry,
      threadId,
      runId,
      // Durable steps (task-execution spec, "Durable, resumable execution"):
      // recorded as they complete so a quit costs at most the step in flight.
      runLog: runLog.getState(),
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      getBot: (id) => useBotsStore.getState().getBot(id),
      memory: getMemoryStore(botId),
      skills: await loadSkillsFor(botId),
      isPaused: () => useBotsStore.getState().getBot(botId)?.paused === true,
      signal: controller.signal,
      chatStream: makeLoopStream(stream, modelId, acc),
      onToolResult: work.onToolResult,
      onDelta: (delta) => {
        streamed += delta;
        chatStore.getState().appendBotDelta(threadId, botMessageId, delta, botId);
      },
      onDone: (fullText) => {
        settled = true;
        const chat = chatStore.getState();
        chat.markDelivered(threadId, userMessageId);
        // Reconstruct the full reply as the user saw it: everything that
        // streamed, plus the final round's text when it arrived without
        // deltas (e.g. the round after a tool call).
        const accumulated =
          streamed === "" || streamed.endsWith(fullText)
            ? streamed === ""
              ? fullText
              : streamed
            : `${streamed}${fullText}`;
        // A trailing structured marker becomes a choice block: stripped from
        // the display text, attached to the message, rendered as chips
        // (messaging spec, "Structured choice prompts"). Parsing runs over
        // the ACCUMULATED reply so earlier rounds' streamed text survives.
        const parsed = parseChoicesMarker(accumulated);
        let choices = parsed.choices;
        let display =
          parsed.text.trim() !== "" ? parsed.text : (choices?.prompt ?? "");
        if (display.trim() === "" && choices !== undefined) {
          // Marker-only reply with no prompt (array form): fall back to a
          // generic prompt so the offered options still render.
          display = CHOICES_FALLBACK_PROMPT;
          choices = { ...choices, prompt: CHOICES_FALLBACK_PROMPT };
        }
        // A reply can arrive without streamed deltas: materialize the bubble
        // before finalizing.
        const exists = (chat.threads[threadId] ?? []).some((m) => m.id === botMessageId);
        if (!exists && display.trim() !== "") {
          chat.appendBotDelta(threadId, botMessageId, display, botId);
        }
        if (choices !== undefined) {
          // Also rewrites the bubble text, which included the raw marker.
          chatStore
            .getState()
            .attachChoices(threadId, botMessageId, choices, display);
        } else if (exists && accumulated !== streamed) {
          // The final round never streamed: append its text so the bubble
          // carries the whole reply.
          chat.appendBotDelta(threadId, botMessageId, fullText, botId);
        }
        chatStore.getState().finalizeBotMessage(threadId, botMessageId);
        recordUsage(botId, modelId, acc);
        // Completed delivery accrues to the bot's work record + card.
        void recordDeliveredWork(botId, taskTitleFrom(userText), threadId, work);
        notifyBotFinished(bot, threadId);
      },
      onError: () => {
        settled = true;
        const chat = chatStore.getState();
        chat.markError(threadId, userMessageId);
        if ((chat.threads[threadId] ?? []).some((m) => m.id === botMessageId)) {
          chatStore.getState().markError(threadId, botMessageId);
        }
      },
    });

    // Cancelled: the engine settles the bot back to idle without onDone/onError.
    // Keep whatever partial reply arrived and leave nothing stuck in the thread.
    if (!settled && controller.signal.aborted) {
      const chat = chatStore.getState();
      chat.markDelivered(threadId, userMessageId);
      if ((chat.threads[threadId] ?? []).some((m) => m.id === botMessageId)) {
        chat.finalizeBotMessage(threadId, botMessageId);
      }
    }
  } catch (err) {
    // Entry-time pause refusal or a mid-run halt at a safe boundary
    // (BotPausedError): the bot did not act on the message, so it errors
    // (retry after resume re-delivers it) and any partial reply is closed
    // out so nothing stays stuck streaming in the thread.
    const chat = chatStore.getState();
    chat.markError(threadId, userMessageId);
    if ((chat.threads[threadId] ?? []).some((m) => m.id === botMessageId)) {
      chat.markError(threadId, botMessageId);
    }
    if (!(err instanceof BotPausedError)) {
      console.error("[chat] delivery failed:", err);
    }
  } finally {
    if (activeStreams.get(botId) === stream) activeStreams.delete(botId);
  }
}

/**
 * Deliver an already-appended user message in a thread to a specific bot.
 * Runs on the bot's serial queue so a reply always has previous replies in
 * its context.
 */
export function deliverToThread(
  threadId: string,
  botId: string,
  userMessageId: string,
  stream: StreamFn = realChatStream,
): Promise<void> {
  const runId = newId();
  return startRun(botId, threadId, runId, undefined, (controller) =>
    deliverNow(threadId, botId, userMessageId, runId, stream, controller),
  );
}

/** Runs older than this are not picked up again at launch. */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resume runs that a quit or crash interrupted (task-execution spec,
 * "Durable, resumable execution"). Called once at bootstrap.
 *
 * Deliberately timid. A bot that silently resumes work is indistinguishable
 * from a bot that spontaneously started work, so each resumed run says so in
 * its thread first; stale work is left alone rather than resurrected a day
 * late; and a run that has already been resumed twice is abandoned, so a
 * step that kills the app cannot do it on every launch.
 *
 * A gated step needs no special handling: approvals are per-run and
 * in-memory, so re-entering the loop re-parks the request rather than
 * inheriting an answer the user never gave.
 *
 * @returns the runIds actually resumed.
 */
export async function resumeInterruptedRuns(
  now: number = Date.now(),
  stream: StreamFn = realChatStream,
): Promise<string[]> {
  const log = runLog.getState();
  const resumed: string[] = [];
  for (const run of log.openRuns()) {
    if (now - run.at > RESUME_MAX_AGE_MS) continue;
    if (run.attempts >= MAX_RESUME_ATTEMPTS) continue;
    const bot = useBotsStore.getState().getBot(run.botId);
    if (!bot || bot.deletedAt || bot.paused) continue;

    log.countAttempt(run.runId);
    chatStore
      .getState()
      .addBotMessage(
        run.threadId,
        run.botId,
        "Picking up where I left off — I was interrupted partway through this.",
      );
    resumed.push(run.runId);
    void startRun(run.botId, run.threadId, run.runId, undefined, (controller) =>
      deliverNow(
        run.threadId,
        run.botId,
        "",
        run.runId,
        stream,
        controller,
        run.entries,
      ),
    );
  }
  return resumed;
}

/**
 * Run a brief on a bot's serial queue and resolve with its reply — the rail
 * behind work that isn't a user message: routine runs today, other
 * app-initiated work later. Rejects with an AbortError if cancelled, or the
 * run's error if it failed.
 *
 * Deliberately thin: it owns the run registration, model selection, usage
 * accounting and the loop call — the same things `deliverNow` and the
 * delegation rail own — and leaves cards, records and reporting to its
 * caller, which is what differs between those callers.
 */
export function runBrief(
  botId: string,
  threadId: string,
  brief: string,
  stream: StreamFn = realChatStream,
): Promise<string> {
  const runId = newId();
  return startRun(botId, threadId, runId, undefined, async (controller) => {
    if (controller.signal.aborted) {
      throw new DOMException("The run was cancelled.", "AbortError");
    }
    const bot = useBotsStore.getState().getBot(botId);
    if (!bot || bot.deletedAt) throw new Error("that bot no longer exists");

    const modelId = selectModelForRole(useModelConfigStore.getState(), botId, "primary");
    const acc: UsageAcc = {
      promptTokens: 0,
      completionTokens: 0,
      cost: undefined,
      sawUsage: false,
    };
    let failure: unknown;
    const reply = await runLoop(bot, [{ role: "user", content: brief }], {
      tools: appToolRegistry,
      threadId,
      runId,
      runLog: runLog.getState(),
      getBot: (id) => useBotsStore.getState().getBot(id),
      memory: getMemoryStore(botId),
      skills: await loadSkillsFor(botId),
      isPaused: () => useBotsStore.getState().getBot(botId)?.paused === true,
      signal: controller.signal,
      chatStream: makeLoopStream(stream, modelId, acc),
      onError: (err) => {
        failure = err;
      },
    });
    recordUsage(botId, modelId, acc);
    if (reply === null) {
      if (controller.signal.aborted) {
        throw new DOMException("The run was cancelled.", "AbortError");
      }
      throw failure instanceof Error ? failure : new Error(String(failure ?? "the run failed"));
    }
    return reply;
  });
}

/** Compat: deliver a direct-thread message (direct threadId === botId). */
export function deliverToBot(
  botId: string,
  userMessageId: string,
  stream: StreamFn = realChatStream,
): Promise<void> {
  return deliverToThread(botId, botId, userMessageId, stream);
}

/**
 * Append a user message to a thread and deliver it to the thread's target
 * bot (direct threads: the bot; group threads: the first participant).
 */
export async function sendToThread(
  threadId: string,
  text: string,
  stream: StreamFn = realChatStream,
): Promise<void> {
  const id = chatStore.getState().sendUserMessage(threadId, text);
  if (id === "") return;
  const target = threadTargetBot(threadId);
  if (!target) {
    chatStore.getState().markError(threadId, id);
    return;
  }
  await deliverToThread(threadId, target.id, id, stream);
}

/** Append a user message to a bot's direct thread and deliver it. */
export async function sendToBot(
  botId: string,
  text: string,
  stream: StreamFn = realChatStream,
): Promise<void> {
  chatStore.getState().ensureDirectThread(botId);
  await sendToThread(botId, text, stream);
}

/**
 * Retry from an errored message. A user message is reset to pending and
 * re-delivered; a failed bot reply re-delivers the nearest preceding user
 * message (producing a fresh reply).
 */
export async function retryFromMessage(
  threadId: string,
  messageId: string,
  stream: StreamFn = realChatStream,
): Promise<void> {
  const thread = chatStore.getState().threads[threadId] ?? [];
  const index = thread.findIndex((m) => m.id === messageId);
  if (index === -1) return;

  const start = thread[index].role === "user" ? index : index - 1;
  for (let i = start; i >= 0; i--) {
    if (thread[i].role === "user") {
      const target = threadTargetBot(threadId);
      if (!target) return;
      chatStore.getState().retryMessage(threadId, thread[i].id);
      await deliverToThread(threadId, target.id, thread[i].id, stream);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Delegation glue (multi-bot-collaboration spec — transparent peer
// delegation from ANY thread; ephemeral instances for busy targets)
// ---------------------------------------------------------------------------

/** Compose the delegated brief the target bot receives as its user turn. */
export function delegationBrief(request: DelegationRequest): string {
  return (
    `[Delegated task from ${request.fromBotName}, a teammate bot — the brief ` +
    `below is your entire context. Handle it in your own role and report back. ` +
    `You cannot ask the user anything: if the brief leaves something ` +
    `ambiguous, make the most reasonable assumption and state it in your report]` +
    `\n\n${request.brief}`
  );
}

/** The teammates a bot may contact: every other active bot on the roster. */
function teammatesFor(forBotId: string): TeammateInfo[] {
  return useBotsStore
    .getState()
    .listBots()
    .filter((b) => b.id !== forBotId)
    .map((b) => ({
      id: b.id,
      name: b.name,
      role: b.roleDescription,
      paused: b.paused,
    }));
}

/** Live capability cards for a bot's teammates (contact_bot description). */
function teammateCardsFor(forBotId: string): TeammateCardText[] {
  return useBotsStore
    .getState()
    .listBots()
    .filter((b) => b.id !== forBotId)
    .map((b) => ({ botId: b.id, card: capabilityCardText(b) }));
}

/** Per-bot can-be-contacted setting (bot field AND side store; default open). */
function canBeContacted(botId: string): boolean {
  if (useBotsStore.getState().getBot(botId)?.canBeContacted === false) return false;
  return getContactPermissionsStore().get(botId).canBeContacted;
}

/** A bot is busy while it has any run in flight or queued. */
function isBusy(botId: string): boolean {
  for (const run of activeRuns) {
    if (run.botId === botId) return true;
  }
  return false;
}

/** Run the target bot (or its ephemeral instance) against the delegated brief. */
async function runDelegatedNow(
  target: Bot,
  request: DelegationRequest,
  runId: string,
  stream: StreamFn,
  controller: AbortController,
): Promise<string> {
  // Cancelled (thread Stop / bot deletion) while still queued: never start —
  // no tool calls, no model rounds, no report.
  if (controller.signal.aborted) {
    throw new DOMException("The delegation was cancelled.", "AbortError");
  }
  // Re-check liveness: the target may have been deleted while queued.
  const live = useBotsStore.getState().getBot(target.id);
  if (!live || live.deletedAt) {
    throw new Error(`${target.name} was deleted before the delegation started`);
  }

  const instanceId = request.instanceId;
  if (instanceId !== undefined) {
    // Halting the instance (canonical pause/delete) cancels its run.
    const signal = botInstances.signalOf(instanceId);
    if (signal?.aborted) {
      throw new DOMException("The delegation was cancelled.", "AbortError");
    }
    signal?.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );
  }
  const memory =
    instanceId !== undefined
      ? (botInstances.memoryOf(instanceId) ?? getMemoryStore(target.id))
      : getMemoryStore(target.id);

  const threadId = request.threadId;
  const modelId = selectModelForRole(
    useModelConfigStore.getState(),
    target.id,
    "primary",
  );

  // The canonical receiver plays the handoff animation (instance spawns
  // already played it on the instance's own runtime entry), then the loop
  // drives thinking -> talkingToUser as it works (bot-avatars spec).
  if (instanceId === undefined) botRuntime.handoff(target.id);

  const acc: UsageAcc = {
    promptTokens: 0,
    completionTokens: 0,
    cost: undefined,
    sawUsage: false,
  };
  const work = makeWorkCollector();
  let failure: unknown;

  // Nested delegation (chain depth 2) from this run reuses the same stream.
  const hadStream = activeStreams.has(target.id);
  if (!hadStream) activeStreams.set(target.id, stream);
  let reply: string | null;
  try {
    reply = await runLoop(
    live,
    [{ role: "user", content: delegationBrief(request) }],
    {
      tools: appToolRegistry,
      threadId,
      runId,
      ancestry: request.ancestry,
      // Policy intersection along the delegation chain: this run may do no
      // more than the most restricted bot that asked for it.
      getBot: (id) => useBotsStore.getState().getBot(id),
      ...(instanceId !== undefined ? { instanceId } : {}),
      memory,
      skills: await loadSkillsFor(target.id),
      isPaused: () => useBotsStore.getState().getBot(target.id)?.paused === true,
      signal: controller.signal,
      chatStream: makeLoopStream(stream, modelId, acc),
      onToolResult: work.onToolResult,
      onError: (err) => {
        failure = err;
      },
    },
    );
  } finally {
    if (!hadStream && activeStreams.get(target.id) === stream) {
      activeStreams.delete(target.id);
    }
  }
  recordUsage(target.id, modelId, acc);
  if (reply === null) {
    if (controller.signal.aborted) {
      throw new DOMException("The delegation was cancelled.", "AbortError");
    }
    throw failure instanceof Error
      ? failure
      : new Error(String(failure ?? "delegated run failed"));
  }

  // Completed delegated work accrues to the CANONICAL bot's experience
  // summary — instance runs included (multi-bot spec).
  void recordDeliveredWork(target.id, taskTitleFrom(request.brief), threadId, work);

  // The target bot's own thread records its side of the exchange.
  if (reply.trim() !== "") {
    const directId = chatStore.getState().ensureDirectThread(target.id);
    chatStore.getState().addBotMessage(directId, target.id, reply, {
      kind: "report",
      delegationId: request.id,
      fromBotId: request.fromBotId,
      brief: request.brief,
      ...(instanceId !== undefined ? { instance: true, instanceId } : {}),
    });
    notifyBotFinished(live, threadId);
  }
  return reply;
}

/**
 * DelegateFn wired into the engine's contact_bot tool: post an inline
 * delegation card into the ORIGINATING thread (direct or group — no group
 * thread required), run the target bot — on its own serial queue, or
 * concurrently on its ephemeral instance when the engine spawned one for a
 * busy target — and resolve with the report, updating the card's live
 * status (in-progress -> done/failed) and embedding the report. With
 * expectReport:false the requester gets an immediate delivery
 * acknowledgement (fire-and-forget). Thrown errors surface to the
 * requester's model as tool error text.
 */
export async function runDelegation(request: DelegationRequest): Promise<string> {
  const threadId = request.threadId;
  const bots = useBotsStore.getState();
  const wanted = request.targetBotName.trim().toLowerCase();
  const target =
    (request.targetBotId !== undefined ? bots.getBot(request.targetBotId) : undefined) ??
    bots.listBots().find((b) => b.name.trim().toLowerCase() === wanted);
  if (!target || target.deletedAt || target.id === request.fromBotId) {
    throw new Error(
      `no teammate named "${request.targetBotName}" is on the team — ` +
        "contact only the teammates listed in the tool description",
    );
  }
  if (target.paused) {
    throw new Error(
      `${target.name} is paused by the user and cannot take work right now`,
    );
  }

  const isInstance = request.instanceId !== undefined;

  // The delegation is visible where the need arose (spec: "Delegation
  // visibility without group chats"): an inline card in the originating
  // thread carrying the target, brief, live status, and later the report.
  const cardId = chatStore.getState().addBotMessage(threadId, request.fromBotId, request.brief, {
    kind: "delegation",
    targetBotId: target.id,
    delegationId: request.id,
    status: "in-progress",
    brief: request.brief,
    fromBotId: request.fromBotId,
    ...(isInstance ? { instance: true, instanceId: request.instanceId } : {}),
  });
  const patchCard = (patch: Partial<MessageMeta>): void => {
    if (cardId !== "") chatStore.getState().updateMessageMeta(threadId, cardId, patch);
  };

  // Reuse the requester's in-flight stream function (tests inject fakes;
  // production uses the real OpenRouter client either way).
  const stream = activeStreams.get(request.fromBotId) ?? realChatStream;
  const runId = newId();
  const runPromise = startRun(
    target.id,
    threadId,
    runId,
    request.parentRunId,
    (controller) => runDelegatedNow(target, request, runId, stream, controller),
    // Instance delegations run concurrently — a busy teammate never blocks.
    { queue: !isInstance },
  );

  const tracked = runPromise.then(
    (report) => {
      patchCard({ status: "done", report });
      return report;
    },
    (err: unknown) => {
      patchCard({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    },
  );

  if (request.expectReport) return await tracked;

  // Fire-and-forget (delegation.ts contract): acknowledge delivery now — the
  // requester moves on immediately — while the target's run still executes
  // and resolves the delegation card when done.
  tracked.catch((err: unknown) => {
    if (!isAbortError(err) && !(err instanceof BotPausedError)) {
      console.error("[chat] delegated run failed:", err);
    }
  });
  return `Delivered to ${target.name}.`;
}

// contact_bot for EVERY bot with teammates, wired to the app's delegation
// flow with live capability cards, contact permissions, and the busy probe
// that triggers ephemeral instances.
registerDelegationTool(appToolRegistry, {
  delegate: runDelegation,
  getTeammates: teammatesFor,
  getCards: teammateCardsFor,
  canBeContacted,
  isBusy,
});
