// Routines inspector for a bot (routines spec, "Routine management" +
// "Per-run reporting and trust progression").
//
// Read and control, not authoring: rows show what a routine is and when it
// next runs, with Run now / enable / delete and an expandable run history.
// There is deliberately NO creation form — routines are created by asking
// the bot ("every weekday at 7, check the error tracker"), which the
// save_routine tool turns into one of these. Typing a schedule into a form
// is exactly the mental load the design pillar exists to avoid.

import { useEffect, useMemo, useState } from "react";
import {
  describeSchedule,
  nextRunAt,
  useRoutinesStore,
  type Routine,
  type RoutineRunRecord,
} from "../lib/engine";
import { runRoutineNow } from "./routineGlue";

/** Run records shown when a routine's history is expanded. */
const HISTORY_SHOWN = 5;

export interface RoutinesPanelProps {
  botId: string;
  botName: string;
}

function relative(at: number, now: number): string {
  const mins = Math.round((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function whenNext(routine: Routine, now: number): string {
  if (!routine.enabled) return "paused";
  const next = nextRunAt(routine.schedule, now);
  if (next === undefined) return "on demand";
  const mins = Math.round((next - now) / 60_000);
  if (mins < 60) return `in ${Math.max(mins, 1)}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

const RUN_DOT: Record<RoutineRunRecord["status"], string> = {
  ok: "bg-[#34c759]",
  error: "bg-red-500",
  cancelled: "bg-neutral-300 dark:bg-neutral-600",
};

export function RoutinesPanel({ botId, botName }: RoutinesPanelProps) {
  const all = useRoutinesStore((s) => s.routines);
  const hydrated = useRoutinesStore((s) => s.hydrated);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!hydrated) void useRoutinesStore.getState().hydrate();
  }, [hydrated]);

  const routines = useMemo(
    () => all.filter((r) => r.botId === botId),
    [all, botId],
  );

  if (routines.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="text-[13px] font-medium text-neutral-500 dark:text-neutral-400">
          No routines yet
        </div>
        <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
          Ask {botName} to do something regularly — “every weekday at 7, check
          the error tracker” — and it will save the routine itself.
        </div>
      </div>
    );
  }

  return (
    <ul aria-label="Routines" className="space-y-1.5">
      {routines.map((routine) => {
        const last = routine.runs[0];
        const isOpen = expanded === routine.id;
        return (
          <li
            key={routine.id}
            data-testid="routine-row"
            data-enabled={routine.enabled}
            className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                    {routine.name}
                  </span>
                  {routine.mode === "supervised" && (
                    <span
                      title="Still being validated — runs prefer to check with you"
                      className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                    >
                      supervised
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                  {describeSchedule(routine.schedule)} · {whenNext(routine, now)}
                  {last && (
                    <>
                      {" · last "}
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 rounded-full ${RUN_DOT[last.status]}`}
                      />{" "}
                      {relative(last.startedAt, now)}
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void runRoutineNow(routine.id, "user")}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-[#007aff] hover:bg-[#007aff]/10 dark:text-[#409cff]"
                >
                  Run now
                </button>
                <button
                  type="button"
                  aria-label={`${routine.enabled ? "Disable" : "Enable"} ${routine.name}`}
                  onClick={() =>
                    useRoutinesStore
                      .getState()
                      .updateRoutine(routine.id, { enabled: !routine.enabled })
                  }
                  className="rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  {routine.enabled ? "Pause" : "Enable"}
                </button>
                {routine.runs.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`Run history for ${routine.name}`}
                    onClick={() => setExpanded(isOpen ? null : routine.id)}
                    className="rounded-lg px-1.5 py-1 text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <ul
                data-testid="routine-history"
                className="space-y-1 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                {routine.runs.slice(0, HISTORY_SHOWN).map((run) => (
                  <li key={run.id} className="flex items-start gap-1.5 text-xs">
                    <span
                      aria-hidden="true"
                      className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${RUN_DOT[run.status]}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
                      {run.summary.split("\n")[0]}
                    </span>
                    <span className="shrink-0 text-neutral-400 dark:text-neutral-500">
                      {relative(run.startedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
              {confirming === routine.id ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-neutral-500 dark:text-neutral-400">
                    Delete this routine and its history?
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      useRoutinesStore.getState().deleteRoutine(routine.id);
                      setConfirming(null);
                    }}
                    className="rounded-full border border-red-300 px-2 py-0.5 font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-full border border-neutral-300 px-2 py-0.5 font-medium text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete ${routine.name}`}
                  onClick={() => setConfirming(routine.id)}
                  className="text-xs font-medium text-neutral-400 hover:text-red-500 dark:text-neutral-500"
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
