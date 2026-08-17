// Memory panel (bot-memory spec, "Memory transparency and control"):
// lists a bot's durable memory entries with content + last-updated time,
// each editable and deletable. Deletions apply immediately to future runs
// (the run loop reads the same shared store).
//
// Also renders the instance merge history (bot-memory spec, "Instance
// memory merge"): each ephemeral-instance merge-back with provenance, and
// flagged conflicts showing both versions with a Restore action for the
// discarded one.

import { useEffect, useMemo, useState } from "react";
import {
  botInstances,
  getMemoryStore,
  type MemoryEntry,
  type MergeConflict,
  type MergeRecord,
} from "../lib/engine";

export interface MemoryPanelProps {
  botId: string;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Summary line for one merge record ("+2 · ~1 updated · 1 conflict"). */
function mergeSummary(record: MergeRecord): string {
  const parts: string[] = [];
  if (record.added > 0) parts.push(`${record.added} added`);
  if (record.updated > 0) parts.push(`${record.updated} updated`);
  if (record.removed > 0) parts.push(`${record.removed} removed`);
  if (record.skippedDuplicates > 0) parts.push(`${record.skippedDuplicates} duplicates skipped`);
  if (record.conflicts.length > 0) {
    parts.push(`${record.conflicts.length} conflict${record.conflicts.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no changes";
}

export function MemoryPanel({ botId }: MemoryPanelProps) {
  const store = useMemo(() => getMemoryStore(botId), [botId]);
  const [entries, setEntries] = useState<MemoryEntry[]>(() => store.list());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [merges, setMerges] = useState<MergeRecord[]>([]);

  useEffect(() => {
    const unsubscribe = store.subscribe(setEntries);
    void store.hydrate();
    return unsubscribe;
  }, [store]);

  useEffect(() => {
    const unsubscribe = botInstances.subscribeMergeHistory(botId, setMerges);
    void botInstances.hydrateMergeHistory(botId);
    return unsubscribe;
  }, [botId]);

  // Restore the discarded side of a merge conflict: the entry (if it still
  // exists) takes the discarded text; a deleted entry is re-added.
  const restoreConflict = (conflict: MergeConflict) => {
    const exists = store.list().some((e) => e.id === conflict.entryId);
    if (exists) store.editEntry(conflict.entryId, conflict.discardedVersion.text);
    else store.remember(conflict.discardedVersion.text);
  };

  const mergeHistory =
    merges.length === 0 ? null : (
      <div className="mt-3">
        <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Instance merge history
        </span>
        <ul aria-label="Merge history" className="space-y-1.5">
          {[...merges].reverse().map((record) => (
            <li
              key={record.id}
              data-testid="merge-record"
              className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              <p className="text-xs text-neutral-600 dark:text-neutral-300">
                Merged from instance{" "}
                <span className="font-mono text-[11px]">{record.instanceId}</span>{" "}
                — {mergeSummary(record)}
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                {formatWhen(record.at)}
              </p>
              {record.conflicts.length > 0 && (
                <ul className="mt-1.5 space-y-1.5">
                  {record.conflicts.map((conflict, i) => (
                    <li
                      key={`${conflict.entryId}-${i}`}
                      data-testid="merge-conflict"
                      className="rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5 dark:border-amber-900/50 dark:bg-amber-950/20"
                    >
                      <p className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        Conflict — newest kept
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-700 dark:text-neutral-200">
                        <span className="font-medium">Kept:</span>{" "}
                        {conflict.keptVersion.text}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                        <span className="font-medium">Discarded:</span>{" "}
                        {conflict.discardedVersion.text}
                      </p>
                      <button
                        type="button"
                        aria-label={`Restore discarded version: ${conflict.discardedVersion.text}`}
                        onClick={() => restoreConflict(conflict)}
                        className="mt-1 rounded-md border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
                      >
                        Restore this version
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    );

  const startEdit = (entry: MemoryEntry) => {
    setEditingId(entry.id);
    setDraft(entry.text);
  };

  const saveEdit = () => {
    if (editingId === null) return;
    const text = draft.trim();
    if (text !== "") store.editEntry(editingId, text);
    setEditingId(null);
    setDraft("");
  };

  if (entries.length === 0) {
    return (
      <div>
        <p
          data-testid="memory-empty"
          className="rounded-lg border border-dashed border-neutral-300 px-3 py-2.5 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
        >
          No memories yet — this bot saves durable notes here as you work
          together (or ask it to “remember” something).
        </p>
        {mergeHistory}
      </div>
    );
  }

  return (
    <div>
    <ul aria-label="Memory entries" className="space-y-1.5">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          {editingId === entry.id ? (
            <div className="space-y-1.5">
              <textarea
                aria-label="Edit memory text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                className="w-full resize-none rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm outline-none focus:border-[#007aff] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveEdit}
                  className="rounded-full bg-[#007aff] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0a66d0]"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setDraft("");
                  }}
                  className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">
                  {entry.text}
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                  Updated {formatWhen(entry.updatedAt)}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Edit memory: ${entry.text}`}
                onClick={() => startEdit(entry)}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Delete memory: ${entry.text}`}
                onClick={() => store.deleteEntry(entry.id)}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Delete
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
    {mergeHistory}
    </div>
  );
}
