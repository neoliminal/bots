// Activity log (security spec, "Comprehensive audit log"): the door to the
// record that has been kept all along.
//
// Bots do ordinary workspace work without asking (task-execution spec,
// "Workspace-scoped work needs no per-action approval") and their commands
// never appear in the thread. That trade is only honest if "what did it
// actually do?" stays answerable afterwards — this view is that answer:
// every tool call, newest first, with the decision that let it run, one
// click per bot to narrow it, and the plain-text export for keeping.
//
// The entry cap is stated on screen, not hidden: a trimmed log must never
// read as a complete one.

import { useEffect, useMemo, useState } from "react";
import {
  auditLog,
  AUDIT_LOG_LIMIT,
  exportAuditLog,
  useBotsStore,
  type AuditEvent,
  type AuditEventKind,
  type AuditStore,
} from "../lib/engine";
import { saveTextFile } from "../lib/native";

export interface ActivityLogProps {
  /** Store override for tests; defaults to the shared audit log. */
  store?: AuditStore;
}

/**
 * How each entry kind reads to a user, and how loudly. "Ran on its own" is
 * deliberately unremarkable — it is the normal case now — while denials and
 * refusals stay visually distinct, because those are the entries someone
 * scanning the log is usually looking for.
 */
const KIND_LABELS: Record<AuditEventKind, { label: string; tone: string }> = {
  "tool.allowed": {
    label: "Ran on its own",
    tone: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  },
  "tool.approved": {
    label: "You approved",
    tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  "tool.denied": {
    label: "You declined",
    tone: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  },
  "tool.refused": {
    label: "Blocked by policy",
    tone: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  },
  "tool.blocked": {
    label: "Stopped",
    tone: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  },
  "grant.recorded": {
    label: "Access granted",
    tone: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  },
  "grant.revoked": {
    label: "Access revoked",
    tone: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  },
  "config.changed": {
    label: "Setting changed",
    tone: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  },
};

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActivityLog({ store = auditLog }: ActivityLogProps) {
  const events = store((s) => s.events);
  const hydrated = store((s) => s.hydrated);
  const bots = useBotsStore((s) => s.bots);
  const [botFilter, setBotFilter] = useState<string | null>(null);
  /** "" idle, "saving" in flight, otherwise the result message. */
  const [exportState, setExportState] = useState("");

  useEffect(() => {
    if (!hydrated) void store.getState().hydrate();
  }, [hydrated, store]);

  const shown = useMemo(
    () => store.getState().list(botFilter ?? undefined),
    // `events` drives recomputation; list() reads the same state.
    [events, botFilter, store],
  );

  // Only bots that actually appear in the log are worth offering as filters
  // (design pillar: one click per real option, never a list of dead ends).
  const actingBots = useMemo(() => {
    const seen = new Map<string, string>();
    for (const event of events) {
      if (event.botId !== undefined && !seen.has(event.botId)) {
        seen.set(event.botId, event.botName ?? event.botId);
      }
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [events]);

  const exportLog = async () => {
    setExportState("saving");
    try {
      const path = await saveTextFile(
        "bots-activity-log.txt",
        exportAuditLog(shown),
      );
      setExportState(path === null ? "Export needs the desktop app." : `Saved to ${path}`);
    } catch (err) {
      setExportState(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const atCap = events.length >= AUDIT_LOG_LIMIT;

  return (
    <fieldset>
      <legend className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        Activity log
      </legend>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Everything your bots have done — every command, file change, and
        connector call, including the ones they ran without asking. Bots work
        in their own folders without interrupting you; this is the record.
      </p>

      {actingBots.length > 1 && (
        <div
          role="group"
          aria-label="Filter by bot"
          className="mt-3 flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            onClick={() => setBotFilter(null)}
            aria-pressed={botFilter === null}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              botFilter === null
                ? "border-[#007aff] bg-[#007aff]/10 text-[#007aff] dark:border-[#409cff] dark:text-[#409cff]"
                : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            }`}
          >
            All bots
          </button>
          {actingBots.map((bot) => (
            <button
              key={bot.id}
              type="button"
              onClick={() => setBotFilter(bot.id)}
              aria-pressed={botFilter === bot.id}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                botFilter === bot.id
                  ? "border-[#007aff] bg-[#007aff]/10 text-[#007aff] dark:border-[#409cff] dark:text-[#409cff]"
                  : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              }`}
            >
              {bot.name}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p
          data-testid="activity-empty"
          className="mt-3 rounded-xl border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
        >
          {bots.length === 0
            ? "Nothing yet — your first bot's work will show up here."
            : "Nothing recorded for this filter yet."}
        </p>
      ) : (
        <ul aria-label="Activity log" className="mt-3 space-y-1.5">
          {shown.map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void exportLog()}
          disabled={exportState === "saving" || shown.length === 0}
          className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {exportState === "saving" ? "Saving…" : "Export as text"}
        </button>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {exportState !== "" && exportState !== "saving"
            ? exportState
            : atCap
              ? `Showing the most recent ${AUDIT_LOG_LIMIT} entries — older ones have been dropped.`
              : `${events.length} ${events.length === 1 ? "entry" : "entries"} kept.`}
        </span>
      </div>
    </fieldset>
  );
}

function ActivityRow({ event }: { event: AuditEvent }) {
  const kind = KIND_LABELS[event.kind];
  // A delegated actor is named by its chain, so "who told it to?" is
  // answerable without opening the thread.
  const chain =
    event.chain !== undefined && event.chain.length > 1
      ? event.chain.join(" → ")
      : undefined;
  return (
    <li
      data-testid="activity-row"
      data-kind={event.kind}
      className="rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-neutral-800 dark:text-neutral-100">
          {event.summary}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kind.tone}`}
        >
          {kind.label}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-400 dark:text-neutral-500">
        <span>{formatWhen(event.at)}</span>
        {event.botName !== undefined && <span>· {event.botName}</span>}
        {chain !== undefined && <span>· {chain}</span>}
        {event.detail !== undefined && (
          <span className="min-w-0 truncate">· {event.detail}</span>
        )}
      </div>
    </li>
  );
}
