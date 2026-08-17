// Approval card (human-handoff spec, "Approval requests"): shows exactly
// what a gated tool call will do — tool, summarized arguments (recipient/
// subject/body for email, path for deletes) — with Allow / Deny-with-reason.
// Resolving (from the thread or the inbox) resumes the parked run loop.
// Requests arising from delegated work show the full provenance chain
// ("You → EA → Mailer: send email" — multi-bot-collaboration spec,
// "Provenance on delegated approvals"), with an instance marker when the
// acting run is an ephemeral copy.
//
// Visual language (docs/design/visual-style.md): white card, hairline
// border, rounded-xl, near-black text; #007aff for the primary action.

import { useState } from "react";
import { resolveApproval, type ApprovalDecision, type PendingApproval } from "../lib/engine";

export interface ApprovalCardProps {
  approval: PendingApproval;
  /** Requesting bot's display name (falls back to the bot id). */
  botName?: string;
  /** Bot display names by id, for the delegation provenance chain. */
  botNames?: Record<string, string>;
  /** Resolution handler; defaults to the shared engine resolver. */
  onResolve?: (id: string, decision: ApprovalDecision, reason?: string) => void;
}

/**
 * Provenance line for a delegated approval: "You → EA → Mailer: send email".
 * Null when the request did not arise from delegation (chain of one bot).
 */
export function provenanceLine(
  approval: PendingApproval,
  botNames?: Record<string, string>,
): string | null {
  const chain = approval.provenance?.chain ?? [];
  if (chain.length <= 1) return null;
  const names = chain.map((id) => botNames?.[id] ?? id);
  const action = describeApproval(approval).title.toLowerCase();
  return `You → ${names.join(" → ")}: ${action}`;
}

interface ApprovalField {
  label: string;
  /** Bounded preview (truncated at PREVIEW_MAX chars). */
  value: string;
  /** The complete, untruncated text of this argument. */
  full: string;
}

const PREVIEW_MAX = 280;

function fullText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function preview(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** True when any argument's preview hides part of its full text. */
function anyTruncated(fields: ApprovalField[]): boolean {
  return fields.some((f) => f.value.length < f.full.length);
}

interface DescribedApproval {
  title: string;
  fields: ApprovalField[];
  /** True when at least one field preview was truncated — the card MUST then
   * offer "Show full request" so nothing executes unseen. */
  truncated: boolean;
}

/** Human-readable title + field breakdown for a pending approval. Each field
 * carries both a bounded `value` preview and the COMPLETE `full` text. */
export function describeApproval(approval: PendingApproval): DescribedApproval {
  const args = approval.args;
  const field = (label: string, value: unknown): ApprovalField => ({
    label,
    value: preview(value),
    full: fullText(value),
  });
  let title: string;
  let fields: ApprovalField[];
  /**
   * Fields for a tool we render specially, PLUS every argument the named
   * ones did not cover. What executes is the whole args object, so a card
   * that shows only the fields it knows about would approve text the user
   * never saw the moment a new argument (cc, bcc, recursive, force…) is
   * added upstream.
   */
  const namedThenRest = (
    named: ReadonlyArray<[string, string]>,
  ): ApprovalField[] => {
    const covered = new Set(named.map(([key]) => key));
    return [
      ...named.map(([key, label]) => field(label, args[key] ?? "")),
      ...Object.entries(args)
        .filter(([key]) => !covered.has(key))
        .map(([key, value]) => field(key, value)),
    ];
  };

  switch (approval.toolName) {
    case "send_email":
      title = "Send an email";
      fields = namedThenRest([
        ["to", "To"],
        ["subject", "Subject"],
        ["body", "Body"],
      ]);
      break;
    case "workspace_delete":
      title = "Delete from workspace";
      fields = namedThenRest([["path", "Path"]]);
      break;
    case "session_exec":
      title = "Run a command";
      fields = namedThenRest([["cmd", "Command"]]);
      break;
    default:
      // Lead with the bot-prepared human-readable summary (design pillar:
      // never make the user parse a tool name + raw args when a prepared
      // line exists); the raw args stay available below it.
      title =
        approval.summary.trim() !== ""
          ? approval.summary
          : `Run ${approval.toolName}`;
      fields = Object.entries(args).map(([key, value]) => field(key, value));
  }
  return { title, fields, truncated: anyTruncated(fields) };
}

export function ApprovalCard({ approval, botName, botNames, onResolve }: ApprovalCardProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [showFull, setShowFull] = useState(false);
  const resolve = onResolve ?? resolveApproval;
  const { title, fields, truncated } = describeApproval(approval);
  const requester = botName ?? botNames?.[approval.botId] ?? approval.botId;
  const provenance = provenanceLine(approval, botNames);
  const isInstance = approval.provenance?.instanceId !== undefined;

  return (
    <div
      data-testid="approval-card"
      role="group"
      aria-label={`Approval request: ${title}`}
      className="rounded-xl border border-neutral-200 bg-white p-3 text-sm text-[#1c1c1e] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold">{title}</span>
          <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
            {requester} is waiting on you
          </span>
        </div>
        <code className="shrink-0 rounded bg-[#f2f2f7] px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {approval.toolName}
        </code>
      </div>

      {provenance !== null && (
        <p
          data-testid="approval-provenance"
          className="mb-2 rounded-md bg-[#f2f2f7] px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {provenance}
          {isInstance && (
            <span
              data-testid="approval-instance-badge"
              className="ml-1.5 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-700 dark:text-neutral-300"
            >
              copy
            </span>
          )}
        </p>
      )}

      <dl className="mb-3 space-y-1">
        {fields.map((field) => (
          <div key={field.label} className="flex gap-2">
            <dt className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-400">
              {field.label}
            </dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">
              {field.value === "" ? "—" : field.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Truncated previews can hide a hostile suffix: the COMPLETE args are
          always one explicit click away — never approve unseen text. */}
      {truncated && (
        <div className="-mt-1 mb-3">
          <button
            type="button"
            aria-expanded={showFull}
            onClick={() => setShowFull((v) => !v)}
            className="text-xs font-medium text-[#007aff] underline decoration-dotted hover:text-[#0a66d0] dark:text-[#409cff] dark:hover:text-[#6cb2ff]"
          >
            {showFull ? "Hide full request" : "Show full request"}
          </button>
          {showFull && (
            <pre
              data-testid="approval-full-args"
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#f2f2f7] p-2 font-mono text-xs text-[#1c1c1e] dark:bg-neutral-800 dark:text-neutral-100"
            >
              {fields
                .map((field) => `${field.label}:\n${field.full === "" ? "—" : field.full}`)
                .join("\n\n")}
            </pre>
          )}
        </div>
      )}

      {denying ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* One-click canned reasons (design pillar: the common denials
              should never require composing a sentence). */}
          {[
            "Not now — ask me later",
            "Needs changes — I'll explain in chat",
            "Too risky — I'll do this myself",
          ].map((canned) => (
            <button
              key={canned}
              type="button"
              data-testid="deny-reason-chip"
              onClick={() => resolve(approval.id, "deny", canned)}
              className="rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:border-red-300 hover:bg-red-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-red-950/30"
            >
              {canned}
            </button>
          ))}
          <input
            aria-label="Denial reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why not? (optional — the bot adjusts)"
            className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-[#007aff] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <button
            type="button"
            onClick={() => {
              const trimmed = reason.trim();
              resolve(approval.id, "deny", trimmed === "" ? undefined : trimmed);
            }}
            className="rounded-full bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setDenying(false)}
            className="rounded-full px-2.5 py-1.5 text-sm text-neutral-500 hover:bg-[#f2f2f7] dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Back
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => resolve(approval.id, "allow")}
            className="rounded-full bg-[#007aff] px-3.5 py-1.5 text-sm font-medium text-white hover:bg-[#0a66d0]"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => setDenying(true)}
            className="rounded-full border border-neutral-200 px-3.5 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Deny…
          </button>
        </div>
      )}
    </div>
  );
}
