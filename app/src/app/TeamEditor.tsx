// Modal for creating a team (group thread): name the team and pick 2+ bots
// as participants (messaging spec "Group threads", multi-bot-collaboration
// "Bot-to-bot messaging").

import { useState, type FormEvent } from "react";
import type { Bot } from "../lib/engine";

export interface TeamEditorProps {
  /** Active bots eligible to join the team. */
  bots: Bot[];
  onCreate: (name: string, botIds: string[]) => void;
  onCancel: () => void;
}

const MIN_MEMBERS = 2;

/** Suggested team name from its members ("Scout & Rex", "Scout, Rex & Ivy"). */
export function suggestedTeamName(members: Bot[]): string {
  if (members.length < MIN_MEMBERS) return "";
  const names = members.map((b) => b.name);
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function TeamEditor({ bots, onCreate, onCancel }: TeamEditorProps) {
  // Design pillar: with exactly two eligible bots the membership is a
  // foregone conclusion — preselect both; the name is suggested live from
  // the selection until the user edits it (typing never required).
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(bots.length === MIN_MEMBERS ? bots.map((b) => b.id) : []),
  );

  const members = bots.filter((b) => selected.has(b.id));
  const effectiveName = nameEdited ? name : suggestedTeamName(members);

  const toggle = (botId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(botId)) {
        next.delete(botId);
      } else {
        next.add(botId);
      }
      return next;
    });
  };

  const canSubmit = effectiveName.trim() !== "" && selected.size >= MIN_MEMBERS;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onCreate(
      effectiveName.trim(),
      members.map((b) => b.id),
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Team"
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            New Team
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <label
                htmlFor="team-name"
                className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400"
              >
                Team name
              </label>
              <input
                id="team-name"
                value={effectiveName}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
                placeholder="e.g. Q3 Renewal Push"
                autoFocus
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#007aff] focus:ring-2 focus:ring-[#007aff]/20 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Members (pick at least {MIN_MEMBERS})
              </span>
              <ul
                role="group"
                aria-label="Team members"
                className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
              >
                {bots.map((bot) => (
                  <li key={bot.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
                      <input
                        type="checkbox"
                        checked={selected.has(bot.id)}
                        onChange={() => toggle(bot.id)}
                        aria-label={bot.name}
                        className="h-4 w-4 accent-[#007aff]"
                      />
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 rounded-full"
                        style={{ backgroundColor: bot.color }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                          {bot.name}
                          {bot.isCoordinator === true && (
                            <span className="ml-1.5 rounded-full bg-[#007aff]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#007aff] dark:bg-sky-950/60 dark:text-sky-300">
                              Coordinator
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {bot.roleDescription || "No role description"}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <footer className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-full bg-[#007aff] px-4 py-2 text-sm font-medium text-white hover:bg-[#0a66d0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Team
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
