// Durable run log.
// Spec: openspec/specs/task-execution/spec.md — "Durable, resumable
// execution" and "Model-visible means logged".
//
// A run's model context has three sources: the system prompt (recomposed
// deterministically), the thread history (derived from the persisted chat
// store), and the run's own tool steps. The first two survive a restart on
// their own; this store is what makes the third survive, so an interrupted
// run can re-enter with everything it already did and repeat only the step
// that was in flight.
//
// Deliberately NOT the audit log: that one is a user-facing, summary-only,
// secret-free, capped record of what bots did. This one holds verbatim tool
// output — the actual bytes the model saw — and is dropped the moment its
// run completes. Different lifetimes, different readers; merging them would
// either pollute the user's activity view with payloads or truncate the
// model's context.

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import type { ChatMessage, StorageLike, ThreadMessage } from "./types";

export const RUN_LOG_STORAGE_KEY = "engine.runLog";

/** Resume attempts allowed before a run is left alone (poison-run guard). */
export const MAX_RESUME_ATTEMPTS = 2;

/**
 * Stands in for the result of a call that was in flight when the app died.
 * Factual, not invented: the model is told the step did not finish and
 * decides whether to retry it.
 */
export const INTERRUPTED_CALL_OUTPUT =
  "This call did not finish — the app was interrupted while it was running. " +
  "Its effect is unknown; check before assuming it succeeded or failed.";

/** A completed step of a run, in the order it completed. */
export type RunLogEntry =
  | {
      id: string;
      runId: string;
      botId: string;
      threadId: string;
      at: number;
      kind: "assistant-calls";
      /** The assistant's text alongside its tool calls (may be empty). */
      text: string;
      calls: Array<{ id: string; name: string; argumentsJson: string }>;
    }
  | {
      id: string;
      runId: string;
      botId: string;
      threadId: string;
      at: number;
      kind: "tool-result";
      toolCallId: string;
      /** Verbatim tool output, exactly as the model received it. */
      output: string;
    };

/**
 * An entry as callers supply it (the store mints the id). Distributive so
 * the union's variants keep their own fields — a plain `Omit` over a union
 * collapses to the keys they share.
 */
export type NewRunLogEntry = RunLogEntry extends infer T
  ? T extends RunLogEntry
    ? Omit<T, "id">
    : never
  : never;

/** A run with entries but no completion — i.e. one that was interrupted. */
export interface OpenRun {
  runId: string;
  botId: string;
  threadId: string;
  /** When its most recent step completed. */
  at: number;
  /** How many times resumption has already been attempted. */
  attempts: number;
  entries: RunLogEntry[];
}

interface PersistedRunLog {
  entries: RunLogEntry[];
  attempts: Record<string, number>;
}

export interface RunLogState {
  entries: RunLogEntry[];
  /** Resume attempts per runId; survives restarts so a poison run stops. */
  attempts: Record<string, number>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Append one completed step. Returns the stored entry. */
  record: (entry: NewRunLogEntry) => RunLogEntry;
  /** A run's steps in completion order. */
  entriesFor: (runId: string) => RunLogEntry[];
  /** Interrupted runs, most recently active first. */
  openRuns: () => OpenRun[];
  /** Drop a finished run's steps — the log's value ends with the run. */
  complete: (runId: string) => void;
  /** Count a resumption attempt against a run. Returns the new count. */
  countAttempt: (runId: string) => number;
}

export type RunLogStore = UseBoundStore<StoreApi<RunLogState>>;

/** Minimal sink the run loop depends on (tests pass a fake). */
export interface RunLogSink {
  record: RunLogState["record"];
  complete: RunLogState["complete"];
}

function createRunLogStoreWith(getStorage: () => StorageLike): RunLogStore {
  const persist = (entries: RunLogEntry[], attempts: Record<string, number>): void => {
    void getStorage()
      .set<PersistedRunLog>(RUN_LOG_STORAGE_KEY, { entries, attempts })
      .catch((err: unknown) => {
        console.error("[engine] failed to persist the run log:", err);
      });
  };

  return create<RunLogState>()((set, get) => ({
    entries: [],
    attempts: {},
    hydrated: false,

    hydrate: async () => {
      const stored = await getStorage().get<PersistedRunLog>(RUN_LOG_STORAGE_KEY);
      set({
        entries: stored?.entries ?? [],
        attempts: stored?.attempts ?? {},
        hydrated: true,
      });
    },

    record: (entry) => {
      const stored = { ...entry, id: makeId("runlog") } as RunLogEntry;
      const entries = [...get().entries, stored];
      set({ entries });
      // Persisted on every append, not at run end: the whole point is to
      // survive a process that never reaches its end.
      persist(entries, get().attempts);
      return stored;
    },

    entriesFor: (runId) => get().entries.filter((e) => e.runId === runId),

    openRuns: () => {
      const byRun = new Map<string, OpenRun>();
      for (const entry of get().entries) {
        const existing = byRun.get(entry.runId);
        if (existing === undefined) {
          byRun.set(entry.runId, {
            runId: entry.runId,
            botId: entry.botId,
            threadId: entry.threadId,
            at: entry.at,
            attempts: get().attempts[entry.runId] ?? 0,
            entries: [entry],
          });
          continue;
        }
        existing.entries.push(entry);
        existing.at = Math.max(existing.at, entry.at);
      }
      return [...byRun.values()].sort((a, b) => b.at - a.at);
    },

    complete: (runId) => {
      const entries = get().entries.filter((e) => e.runId !== runId);
      if (entries.length === get().entries.length && get().attempts[runId] === undefined) {
        return; // Nothing recorded for this run; leave state identical.
      }
      const attempts = { ...get().attempts };
      delete attempts[runId];
      set({ entries, attempts });
      persist(entries, attempts);
    },

    countAttempt: (runId) => {
      const next = (get().attempts[runId] ?? 0) + 1;
      const attempts = { ...get().attempts, [runId]: next };
      set({ attempts });
      persist(get().entries, attempts);
      return next;
    },
  }));
}

/** Build an isolated run log bound to a specific adapter (tests). */
export function createRunLogStore(storage: StorageLike): RunLogStore {
  return createRunLogStoreWith(() => storage);
}

/** App-wide run log; uses whatever adapter configureEngineStorage set. */
export const runLog: RunLogStore = createRunLogStoreWith(() => getEngineStorage());

/**
 * Build a run's model messages from durable state alone (task-execution
 * spec, "Model-visible means logged").
 *
 * This is the ONE place messages are assembled, used by both the live loop
 * and resumption — if they had separate implementations, a resumed run could
 * silently see something different from the run it continues.
 */
export function reconstructMessages(
  systemContent: string,
  threadHistory: readonly ThreadMessage[],
  entries: readonly RunLogEntry[],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...threadHistory.map<ChatMessage>((m) => ({ role: m.role, content: m.content })),
  ];
  // A call whose result was never recorded — the app died mid-step. Its
  // assistant message still carries the tool_call, and a request with a
  // tool_call that no tool message answers is malformed, so the gap is
  // filled with what actually happened. Stating the interruption is honest
  // and lets the model decide whether to retry; inventing a plausible result
  // would not be.
  const answered = new Set(
    entries.filter((e) => e.kind === "tool-result").map((e) => e.toolCallId),
  );

  for (const entry of entries) {
    if (entry.kind === "assistant-calls") {
      messages.push({
        role: "assistant",
        content: entry.text,
        tool_calls: entry.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson },
        })),
      });
      for (const call of entry.calls) {
        if (answered.has(call.id)) continue;
        messages.push({
          role: "tool",
          content: INTERRUPTED_CALL_OUTPUT,
          tool_call_id: call.id,
        });
      }
    } else {
      messages.push({
        role: "tool",
        content: entry.output,
        tool_call_id: entry.toolCallId,
      });
    }
  }
  return messages;
}
