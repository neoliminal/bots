// Message list for a thread: user messages right (near-black bubbles), bot
// messages left (light-gray bubbles), Markdown for bot text, auto-scroll
// pinned to bottom unless the user scrolled up, streaming + status
// indicators, error retry.
//
// Visual language (docs/design/visual-style.md): iMessage pattern with an
// inverted palette — rounded-2xl bubbles with a tighter tail corner on the
// last bubble of a cluster, 2px gaps inside same-author clusters, centered
// 11px gray timestamp separators, and white hairline-border cards for
// delegations. Direct threads show no per-bubble avatar (the header
// identifies the bot); group threads caption each cluster with a small
// avatar + author name (spec: openspec/specs/messaging "Group threads").
//
// Delegation messages render as inline collapsible delegation cards (spec:
// multi-bot-collaboration "Delegation visibility without group chats"):
// target bot avatar + name, brief, live status, expandable full exchange
// including the report, and an instance badge when the run was an instance.

import { useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import {
  resolveApproval,
  type ApprovalDecision,
  type PendingApproval,
} from "../../lib/engine";
import { Markdown } from "./markdown";
import type { ChatMessage, Thread } from "./store";

export interface ThreadViewProps {
  messages: ChatMessage[];
  /** Thread being rendered. Group threads show per-message author attribution;
   * omitted or direct threads render exactly as before. */
  thread?: Thread;
  /** Bot display names by id, for group-thread author labels (falls back to the id). */
  botNames?: Record<string, string>;
  /** Slot rendered in group-thread cluster captions and delegation cards
   * (keeps this feature decoupled from avatars). Called as (botId, size);
   * legacy zero-arg callbacks still work. */
  renderBotAvatar?: (botId: string, size: number) => ReactNode;
  /** Called with the message id when the user hits Retry on an errored message. */
  onRetry?: (messageId: string) => void;
  /**
   * Called with (messageId, option) when the user taps a live choice chip
   * (messaging spec, "Structured choice prompts"). The handler posts the
   * option as a normal user message via the existing send path — which also
   * marks the block answered, making the chips inert.
   */
  onChoiceSelect?: (messageId: string, option: string) => void;
  /**
   * Pending approvals belonging to this thread. Each renders inline draft
   * actions (approve / edit / discard) on the requesting bot's latest
   * message (messaging spec, "Inline draft actions").
   */
  pendingApprovals?: PendingApproval[];
  /**
   * Resolution handler for inline draft actions. Defaults to the shared
   * engine resolver — the SAME function `ApprovalCard` uses, so acting
   * in-thread and acting from the approvals inbox are one code path
   * (human-handoff spec).
   */
  onResolveApproval?: (id: string, decision: ApprovalDecision, reason?: string) => void;
}

/** How close to the bottom (px) still counts as "pinned". */
const PIN_THRESHOLD = 48;

/** Avatar size (px) for the group-thread cluster caption. */
const CAPTION_AVATAR_SIZE = 20;

/** Gap (ms) after which a centered timestamp separator is inserted. */
const SEPARATOR_GAP_MS = 20 * 60 * 1000;

/** Centered separator text: "Today 2:14 PM", "Yesterday …", weekday, or date. */
export function formatSeparatorTimestamp(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const ref = new Date(now);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(ref) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) return `Today ${time}`;
  if (dayDiff === 1) return `Yesterday ${time}`;
  if (dayDiff < 7) {
    return `${date.toLocaleDateString([], { weekday: "long" })} ${time}`;
  }
  const sameYear = date.getFullYear() === ref.getFullYear();
  return `${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })} ${time}`;
}

function TimestampSeparator({ at }: { at: number }) {
  return (
    <div className="flex justify-center pb-1 pt-4" data-testid="timestamp-separator">
      <span className="text-[11px] font-medium text-neutral-400">
        {formatSeparatorTimestamp(at)}
      </span>
    </div>
  );
}

function StreamingIndicator() {
  return (
    <span
      data-testid="streaming-indicator"
      aria-label="Bot is typing"
      className="ml-1 inline-block animate-pulse select-none"
    >
      ▍
    </span>
  );
}

function StatusLine({ message, onRetry }: { message: ChatMessage; onRetry?: (id: string) => void }) {
  if (message.status === "pending" && message.role === "user") {
    return <div className="mt-0.5 text-[11px] text-neutral-400">Sending…</div>;
  }
  if (message.status === "error") {
    return (
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-red-500">
        <span>Failed</span>
        {onRetry && (
          <button
            type="button"
            onClick={() => onRetry(message.id)}
            className="rounded-full border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 dark:hover:bg-red-950"
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  return null;
}

/** Badge text for EA-flow messages (delegation/report), or null for normal ones. */
function metaLabel(
  message: ChatMessage,
  botNames?: Record<string, string>,
): string | null {
  const meta = message.meta;
  if (!meta || meta.kind === "normal") return null;
  if (meta.kind === "report") return "Report";
  const target = meta.targetBotId ? botNames?.[meta.targetBotId] : undefined;
  return target ? `Delegated to ${target}` : "Delegated";
}

/** Small "copy" badge marking work done by an ephemeral instance. */
function InstanceBadge() {
  return (
    <span
      data-testid="instance-badge"
      title="Handled by an ephemeral copy of this bot"
      className="rounded-full bg-[#f2f2f7] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
    >
      copy
    </span>
  );
}

/**
 * Subtle in-thread session indicator (agent-computer spec): a centered,
 * de-emphasized line marking a compute-session lifecycle event
 * (provisioned / warm-resumed / stopped) or a sync-back warning. Commands
 * are not shown here — they live in the Activity log.
 */
function SessionEventRow({ message }: { message: ChatMessage }) {
  const meta = message.meta;
  return (
    <div
      data-message-id={message.id}
      data-testid="session-event"
      data-session-event={meta?.sessionEvent}
      className="flex justify-center pt-3"
    >
      <span
        className="max-w-[85%] truncate rounded-full bg-[#f2f2f7] px-2.5 py-0.5 text-[11px] italic text-neutral-400 dark:bg-neutral-900 dark:text-neutral-500"
        title={message.text}
      >
        {message.text}
      </span>
    </div>
  );
}

const BRIEF_SNIPPET_MAX = 90;

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= BRIEF_SNIPPET_MAX ? t : `${t.slice(0, BRIEF_SNIPPET_MAX - 1)}…`;
}

const STATUS_STYLES: Record<string, string> = {
  "in-progress":
    "bg-[#007aff]/10 text-[#007aff] dark:bg-sky-950/60 dark:text-sky-300 animate-pulse",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  interrupted:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

const STATUS_LABELS: Record<string, string> = {
  "in-progress": "in progress",
  done: "done",
  failed: "failed",
  interrupted: "interrupted",
};

/**
 * Inline collapsible delegation card (white card, hairline border — the
 * shared card language): collapsed it reads "asked Scout: <brief snippet> —
 * in progress"; expanded it shows the full brief and, once resolved, the
 * target's report (or the failure reason).
 */
function DelegationCard({
  message,
  botNames,
  renderBotAvatar,
  onRetry,
}: {
  message: ChatMessage;
  botNames?: Record<string, string>;
  renderBotAvatar?: (botId: string, size: number) => ReactNode;
  onRetry?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = message.meta;
  const targetBotId = meta?.targetBotId ?? "";
  const targetName = botNames?.[targetBotId] ?? "teammate";
  const status = meta?.status ?? "done";
  const brief = meta?.brief ?? message.text;
  // Avatar keyed by the instance id when the run is an instance, so
  // instance-aware renderers can badge and animate the copy itself.
  const avatarId = meta?.instanceId ?? targetBotId;

  return (
    <div
      data-testid="delegation-card"
      data-status={status}
      data-delegation-id={meta?.delegationId}
      className="w-full rounded-xl border border-neutral-200 bg-white text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Delegation to ${targetName}: ${STATUS_LABELS[status] ?? status}`}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-[#f7f7f9] dark:hover:bg-neutral-800"
      >
        <span className="shrink-0">{renderBotAvatar?.(avatarId, 24)}</span>
        <span className="min-w-0 flex-1 truncate text-[#1c1c1e] dark:text-neutral-200">
          <span className="font-semibold">asked {targetName}</span>
          {meta?.instance === true && (
            <span className="ml-1.5 align-middle">
              <InstanceBadge />
            </span>
          )}
          <span className="text-neutral-500 dark:text-neutral-400">
            {" "}
            — {snippet(brief)}
          </span>
        </span>
        <span
          data-testid="delegation-status"
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            STATUS_STYLES[status] ?? STATUS_STYLES.done
          }`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs text-neutral-400">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {status === "interrupted" && (
        <div
          data-testid="delegation-interrupted"
          className="flex flex-wrap items-center gap-2 border-t border-neutral-200 px-3 py-1.5 text-xs text-amber-700 dark:border-neutral-700 dark:text-amber-400"
        >
          <span>Interrupted — the app restarted before {targetName} reported back.</span>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              className="rounded-full border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-50 dark:border-amber-700 dark:hover:bg-amber-950"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {expanded && (
        <div
          data-testid="delegation-detail"
          className="space-y-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700"
        >
          <div>
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Brief
            </div>
            <div className="whitespace-pre-wrap break-words text-[#1c1c1e] dark:text-neutral-200">
              {brief}
            </div>
          </div>
          {meta?.report !== undefined && meta.report !== "" && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Report
              </div>
              <Markdown text={meta.report} />
            </div>
          )}
          {status === "failed" && (
            <div className="text-red-600 dark:text-red-400">
              {meta?.error ?? "The delegation failed."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline routine-run card (routines spec, "Per-run reporting"): the same
 * card language as a delegation, different words. Collapsed it says which
 * routine ran and how it went; expanded it shows what the Bot reported. A
 * run that happened at 6am is meant to be readable at 9 without hunting.
 */
function RoutineRunCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const meta = message.meta;
  const status = meta?.status ?? "in-progress";
  const name = meta?.routineName ?? "routine";
  const because =
    meta?.invokedBy === "schedule"
      ? "on schedule"
      : meta?.invokedBy === "trigger"
        ? "triggered"
        : "run now";
  const body = status === "failed" ? meta?.error : meta?.report;

  return (
    <div
      data-testid="routine-card"
      data-status={status}
      className="w-full rounded-xl border border-neutral-200 bg-white text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Routine ${name}: ${STATUS_LABELS[status] ?? status}`}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-[#f7f7f9] dark:hover:bg-neutral-800"
      >
        <span aria-hidden="true" className="shrink-0 text-neutral-400">
          ↻
        </span>
        <span className="min-w-0 flex-1 truncate text-[#1c1c1e] dark:text-neutral-200">
          <span className="font-semibold">{name}</span>
          <span className="text-neutral-500 dark:text-neutral-400"> — {because}</span>
        </span>
        <span
          data-testid="routine-status"
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            STATUS_STYLES[status] ?? STATUS_STYLES.done
          }`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs text-neutral-400">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && body !== undefined && body !== "" && (
        <div
          data-testid="routine-detail"
          className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700"
        >
          {status === "failed" ? (
            <div className="text-red-600 dark:text-red-400">{body}</div>
          ) : (
            <Markdown text={body} />
          )}
        </div>
      )}
    </div>
  );
}

/** Letter badge label for option index i (A, B, C, …). */
function optionBadge(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/**
 * Question card under a bot message (messaging spec, "Structured choice
 * prompts"; design pillar: minimize human typing). Live: a titled card with
 * letter-badged option rows and an inline own-answer field — clicking a row
 * or submitting the field posts the answer as a normal user message via
 * `onSelect`. Answered: the card collapses to a receipt (prompt + chosen
 * answer + check) so history stays scannable. The card accompanies — never
 * replaces — the free-text composer.
 */
function QuestionCard({
  message,
  onSelect,
}: {
  message: ChatMessage;
  onSelect?: (messageId: string, option: string) => void;
}) {
  const [ownAnswer, setOwnAnswer] = useState("");
  const choices = message.choices;
  if (!choices || choices.options.length === 0) return null;
  const answered = choices.answeredWith !== undefined;
  const prompt =
    choices.prompt !== undefined && choices.prompt !== message.text
      ? choices.prompt
      : undefined;

  if (answered) {
    return (
      <div
        data-testid="choice-chips"
        data-answered="true"
        className="mt-1.5 max-w-full rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700"
      >
        {prompt !== undefined && (
          <span
            data-testid="choice-prompt"
            className="block text-[11px] text-neutral-400 dark:text-neutral-500"
          >
            {prompt}
          </span>
        )}
        <span
          data-testid="choice-receipt"
          className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-neutral-300"
        >
          <span className="truncate">{choices.answeredWith}</span>
          <span aria-label="answered" className="shrink-0 text-[#34c759]">
            ✓
          </span>
        </span>
      </div>
    );
  }

  const submitOwnAnswer = () => {
    const text = ownAnswer.trim();
    if (text === "") return;
    onSelect?.(message.id, text);
    setOwnAnswer("");
  };

  return (
    <div
      data-testid="choice-chips"
      data-answered="false"
      role="group"
      aria-label="Choices"
      className="mt-1.5 max-w-full rounded-xl border border-neutral-200 p-2 dark:border-neutral-700"
    >
      {prompt !== undefined && (
        <span
          data-testid="choice-prompt"
          className="block px-1 pb-1.5 text-[12px] font-medium text-neutral-700 dark:text-neutral-200"
        >
          {prompt}
        </span>
      )}
      <div className="space-y-1">
        {choices.options.map((option, i) => (
          <button
            key={option}
            type="button"
            onClick={() => onSelect?.(message.id, option)}
            className="flex w-full items-center gap-2 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-left text-[12px] font-medium text-neutral-700 hover:border-[#007aff]/50 hover:bg-[#007aff]/5 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-[#409cff]/50 dark:hover:bg-sky-950/30"
          >
            <span
              aria-hidden="true"
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-neutral-100 text-[10px] font-semibold text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500"
            >
              {optionBadge(i)}
            </span>
            <span className="truncate">{option}</span>
          </button>
        ))}
      </div>
      <form
        className="mt-1.5 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submitOwnAnswer();
        }}
      >
        <input
          type="text"
          value={ownAnswer}
          onChange={(e) => setOwnAnswer(e.target.value)}
          placeholder="Type your own answer"
          aria-label="Type your own answer"
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12px] placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:placeholder:text-neutral-500"
        />
        <button
          type="submit"
          disabled={ownAnswer.trim() === ""}
          aria-label="Send answer"
          className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          ↑
        </button>
      </form>
    </div>
  );
}

/** Draft text of a gated call, for the inline editor (body-ish arg first). */
function draftTextOf(approval: PendingApproval): string {
  const { body, text, content } = approval.args;
  for (const value of [body, text, content]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return approval.summary;
}

/**
 * Inline draft actions on a message tied to a pending approval (messaging
 * spec, "Inline draft actions"): Approve / Edit / Discard, resolved through
 * the SAME approval-resolution function `ApprovalCard` defaults to — never
 * a parallel path (human-handoff spec). "Edit" opens the draft in a
 * textarea; sending the revision resolves as a deny whose reason carries
 * the revised draft, which the bot incorporates and resubmits for approval.
 */
function DraftActions({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve?: (id: string, decision: ApprovalDecision, reason?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftTextOf(approval));
  const resolve = onResolve ?? resolveApproval;

  return (
    <div
      data-testid="draft-actions"
      data-approval-id={approval.id}
      role="group"
      aria-label={`Draft actions: ${approval.summary}`}
      className="mt-1.5 w-full"
    >
      {editing ? (
        <div className="flex w-full flex-col gap-1.5">
          <textarea
            aria-label="Edit draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#007aff] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() =>
                resolve(
                  approval.id,
                  "deny",
                  `Revise the draft as follows and resend it for approval:\n${draft}`,
                )
              }
              className="rounded-full bg-[#007aff] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#0a66d0]"
            >
              Send revision
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full px-2.5 py-1 text-[12px] text-neutral-500 hover:bg-[#f2f2f7] dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* What is being approved must be visible NEXT TO the button. The
              summary previously lived only in an aria-label, so a bot could
              stream reassuring text above a one-click Approve for something
              else entirely. */}
          <p
            data-testid="draft-actions-summary"
            className="text-[12px] text-neutral-500 dark:text-neutral-400"
          >
            {approval.summary.trim() !== ""
              ? approval.summary
              : `Run ${approval.toolName}`}
          </p>
          <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => resolve(approval.id, "allow")}
            className="rounded-full bg-[#007aff] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#0a66d0]"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-neutral-200 px-3 py-1 text-[12px] font-medium text-[#1c1c1e] hover:bg-[#f2f2f7] dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => resolve(approval.id, "deny", "Discard this draft — do not send it.")}
            className="rounded-full border border-neutral-200 px-3 py-1 text-[12px] font-medium text-red-600 hover:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Discard
          </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  authorBotId,
  authorName,
  botNames,
  renderBotAvatar,
  onRetry,
  onChoiceSelect,
  draftApprovals,
  onResolveApproval,
  clusterStart,
  clusterEnd,
  first,
}: {
  message: ChatMessage;
  /** Bot to attribute this message to (caption avatar + group author label). */
  authorBotId: string;
  /** Author label shown above the cluster in group threads only. */
  authorName?: string;
  /** Bot display names, for delegation badge targets. */
  botNames?: Record<string, string>;
  renderBotAvatar?: (botId: string, size: number) => ReactNode;
  onRetry?: (id: string) => void;
  onChoiceSelect?: (messageId: string, option: string) => void;
  /** Pending approvals whose draft actions render on THIS message. */
  draftApprovals?: PendingApproval[];
  onResolveApproval?: (id: string, decision: ApprovalDecision, reason?: string) => void;
  /** First message of a same-author cluster (gets caption + wider gap). */
  clusterStart: boolean;
  /** Last message of a cluster (gets the tail-corner treatment). */
  clusterEnd: boolean;
  /** Very first row in the log (no top gap). */
  first: boolean;
}) {
  const isUser = message.role === "user";
  const isDelegation = !isUser && message.meta?.kind === "delegation";
  const isRoutine = !isUser && message.meta?.kind === "routine-run";
  const isCard = isDelegation || isRoutine;
  const badge = isUser || isCard ? null : metaLabel(message, botNames);
  const showInstanceBadge = !isUser && !isCard && message.meta?.instance === true;
  const gap = first ? "" : clusterStart ? "mt-3" : "mt-[2px]";

  const bubbleClass = isUser
    ? `whitespace-pre-wrap rounded-2xl bg-[#1c1c1e] px-3.5 py-1.5 text-white dark:bg-[#f2f2f7] dark:text-[#1c1c1e] ${
        clusterEnd ? "rounded-br-[6px]" : ""
      }`
    : `rounded-2xl bg-[#e9e9eb] px-3.5 py-1.5 text-[#1c1c1e] dark:bg-[#2c2c2e] dark:text-neutral-100 ${
        clusterEnd ? "rounded-bl-[6px]" : ""
      }`;

  return (
    <div
      data-message-id={message.id}
      data-message-role={message.role}
      data-status={message.status}
      className={`flex ${gap} ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex flex-col ${isUser ? "items-end" : "items-start"} ${
          isDelegation ? "w-full max-w-[85%]" : "max-w-[75%]"
        }`}
      >
        {!isUser &&
          clusterStart &&
          (authorName !== undefined || badge !== null || showInstanceBadge) && (
            <div className="mb-0.5 flex items-center gap-1.5 px-1">
              {authorName !== undefined && (
                <>
                  <span className="shrink-0" data-testid="caption-avatar-slot">
                    {renderBotAvatar?.(authorBotId, CAPTION_AVATAR_SIZE)}
                  </span>
                  <span
                    data-testid="message-author"
                    className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400"
                  >
                    {showInstanceBadge ? `${authorName} · copy` : authorName}
                  </span>
                </>
              )}
              {showInstanceBadge && authorName === undefined && <InstanceBadge />}
              {badge !== null && (
                <span
                  data-testid="message-meta"
                  data-meta-kind={message.meta?.kind}
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    message.meta?.kind === "report"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                      : "bg-[#f2f2f7] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                  }`}
                >
                  {badge}
                </span>
              )}
            </div>
          )}
        {isDelegation ? (
          <DelegationCard
            message={message}
            botNames={botNames}
            renderBotAvatar={renderBotAvatar}
            onRetry={onRetry}
          />
        ) : isRoutine ? (
          <RoutineRunCard message={message} />
        ) : (
          <div className={bubbleClass}>
            {isUser ? message.text : <Markdown text={message.text} />}
            {message.streaming && <StreamingIndicator />}
          </div>
        )}
        {!isUser && <QuestionCard message={message} onSelect={onChoiceSelect} />}
        {!isUser &&
          draftApprovals?.map((approval) => (
            <DraftActions
              key={approval.id}
              approval={approval}
              onResolve={onResolveApproval}
            />
          ))}
        <StatusLine message={message} onRetry={onRetry} />
      </div>
    </div>
  );
}

/** Special messages (delegations, reports, session events) break clusters. */
function isSpecial(m: ChatMessage): boolean {
  return m.meta !== undefined && m.meta.kind !== "normal";
}

function sameAuthor(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.role === "user") return true;
  return (a.authorBotId ?? "") === (b.authorBotId ?? "");
}

export function ThreadView({
  messages,
  thread,
  botNames,
  renderBotAvatar,
  onRetry,
  onChoiceSelect,
  pendingApprovals,
  onResolveApproval,
}: ThreadViewProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const isGroup = thread?.kind === "group";

  // Each pending approval's draft actions attach to the requesting bot's
  // LATEST non-session message in the thread — the draft the user is being
  // asked about (messaging spec, "Inline draft actions"). Approvals with no
  // such message stay reachable via the approvals panel/inbox.
  const draftApprovalsByMessage = new Map<string, PendingApproval[]>();
  for (const approval of pendingApprovals ?? []) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "bot" || m.meta?.kind === "session") continue;
      const author = m.authorBotId ?? thread?.participantBotIds[0] ?? "";
      if (author !== approval.botId) continue;
      const list = draftApprovalsByMessage.get(m.id) ?? [];
      list.push(approval);
      draftApprovalsByMessage.set(m.id, list);
      break;
    }
  }

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      role="log"
      aria-label="Messages"
      className="flex-1 overflow-y-auto bg-white px-4 pb-3 pt-1 text-sm dark:bg-neutral-950"
    >
      {messages.length === 0 ? (
        <div className="py-8 text-center text-sm text-neutral-400">No messages yet</div>
      ) : (
        messages.map((message, i) => {
          const prev = i > 0 ? messages[i - 1] : undefined;
          const next = i < messages.length - 1 ? messages[i + 1] : undefined;
          const separated =
            prev === undefined ||
            message.createdAt - prev.createdAt > SEPARATOR_GAP_MS;
          const separator = separated ? (
            <TimestampSeparator at={message.createdAt} />
          ) : null;

          if (message.meta?.kind === "session") {
            return (
              <div key={message.id}>
                {separator}
                <SessionEventRow message={message} />
              </div>
            );
          }

          const clusterStart =
            separated ||
            prev === undefined ||
            isSpecial(message) ||
            isSpecial(prev) ||
            !sameAuthor(prev, message);
          const clusterEnd =
            next === undefined ||
            isSpecial(message) ||
            isSpecial(next) ||
            !sameAuthor(message, next) ||
            next.createdAt - message.createdAt > SEPARATOR_GAP_MS;

          const authorBotId =
            message.authorBotId ?? thread?.participantBotIds[0] ?? "";
          const row = (
            <MessageRow
              message={message}
              authorBotId={authorBotId}
              authorName={
                isGroup && message.role === "bot"
                  ? (botNames?.[authorBotId] ?? authorBotId)
                  : undefined
              }
              botNames={botNames}
              renderBotAvatar={renderBotAvatar}
              onRetry={onRetry}
              onChoiceSelect={onChoiceSelect}
              draftApprovals={draftApprovalsByMessage.get(message.id)}
              onResolveApproval={onResolveApproval}
              clusterStart={clusterStart}
              clusterEnd={clusterEnd}
              first={i === 0 || separated}
            />
          );
          return separator ? (
            <div key={message.id}>
              {separator}
              {row}
            </div>
          ) : (
            <div key={message.id}>{row}</div>
          );
        })
      )}
    </div>
  );
}
