// Capability card panel (multi-bot-collaboration spec, "Capability cards" —
// "User visibility and control"): shows the bot's current card (role +
// platform-derived experience summary + live availability + version), its
// versioned change history, and lets the user pin/edit the experience text
// or revert to the auto-compiled summary — taking effect for the next
// delegation decision (contact_bot reads the same stores).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildCapabilityCard,
  clearPin,
  compileExperience,
  deriveAvailability,
  getCardHistory,
  getCardStore,
  getWorklogStore,
  hydrateWorklog,
  pinExperience,
  useBotsStore,
  type CardSnapshot,
  type WorkRecord,
} from "../lib/engine";
import { useBotRuntimeState } from "./runtimeHooks";

export interface CapabilityCardPanelProps {
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

/** Publish the bot's current card so the version history stays fresh. */
async function publishCurrentCard(botId: string): Promise<void> {
  const bot = useBotsStore.getState().getBot(botId);
  if (!bot || bot.deletedAt) return;
  const worklog = await hydrateWorklog(botId);
  const availability = deriveAvailability("idle", bot.paused);
  await buildCapabilityCard(
    { id: bot.id, name: bot.name, roleDescription: bot.roleDescription },
    worklog.list(),
    availability,
  );
}

export function CapabilityCardPanel({ botId }: CapabilityCardPanelProps) {
  const bot = useBotsStore((s) => s.bots.find((b) => b.id === botId));
  const runtimeState = useBotRuntimeState(botId);
  const [worklog, setWorklog] = useState<WorkRecord[]>(() =>
    getWorklogStore(botId).list(),
  );
  const [history, setHistory] = useState<CardSnapshot[]>([]);
  const [pin, setPin] = useState<string | null>(() => getCardStore(botId).getPin());
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(async () => {
    setHistory(await getCardHistory(botId));
    setPin(getCardStore(botId).getPin());
  }, [botId]);

  useEffect(() => {
    const store = getWorklogStore(botId);
    const unsubscribe = store.subscribe(setWorklog);
    // Publish on open so the history reflects the latest name/role/summary,
    // then load it.
    void publishCurrentCard(botId).then(refresh);
    return unsubscribe;
  }, [botId, refresh]);

  const compiled = useMemo(() => compileExperience(worklog), [worklog]);
  const experience = pin ?? compiled;
  const availability = deriveAvailability(runtimeState, bot?.paused === true);
  const current = history[history.length - 1];

  const startEdit = () => {
    setDraft(experience);
    setEditing(true);
  };

  const savePin = async () => {
    const text = draft.trim();
    if (text === "") return;
    await pinExperience(botId, text);
    await publishCurrentCard(botId);
    await refresh();
    setEditing(false);
  };

  const revertToAuto = async () => {
    await clearPin(botId);
    await publishCurrentCard(botId);
    await refresh();
    setEditing(false);
  };

  return (
    <div className="space-y-2">
      <div
        data-testid="capability-card-current"
        className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {bot?.name ?? botId}
          </span>
          <span
            data-testid="capability-card-availability"
            className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {availability}
          </span>
          {current !== undefined && (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
              v{current.version}
            </span>
          )}
          {pin !== null && (
            <span
              data-testid="capability-card-pinned"
              className="rounded-full bg-[#007aff]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#007aff] dark:bg-sky-950/60 dark:text-sky-300"
            >
              pinned
            </span>
          )}
        </div>
        {bot !== undefined && bot.roleDescription.trim() !== "" && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {bot.roleDescription}
          </p>
        )}
        {editing ? (
          <div className="mt-2 space-y-1.5">
            <textarea
              aria-label="Edit experience summary"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm outline-none focus:border-[#007aff] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void savePin()}
                className="rounded-full bg-[#007aff] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0a66d0]"
              >
                Pin summary
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p
            data-testid="capability-card-experience"
            className="mt-1.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-200"
          >
            {experience}
          </p>
        )}
        {!editing && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startEdit}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {pin !== null ? "Edit pinned summary" : "Pin / edit summary"}
            </button>
            {pin !== null && (
              <button
                type="button"
                onClick={() => void revertToAuto()}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Revert to auto-summary
              </button>
            )}
            <button
              type="button"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
              className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {showHistory ? "Hide history" : `History (${history.length})`}
            </button>
          </div>
        )}
      </div>

      {showHistory && (
        <ul
          data-testid="capability-card-history"
          aria-label="Card version history"
          className="space-y-1"
        >
          {history.length === 0 && (
            <li className="rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
              No card versions yet.
            </li>
          )}
          {[...history].reverse().map((snapshot) => (
            <li
              key={snapshot.version}
              className="rounded-xl border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                <span className="font-semibold">v{snapshot.version}</span>
                <span>{formatWhen(snapshot.at)}</span>
                {snapshot.pinned && <span>pinned</span>}
                {snapshot.version !== current?.version && (
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        await pinExperience(botId, snapshot.experience);
                        await publishCurrentCard(botId);
                        await refresh();
                      })()
                    }
                    className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#007aff] hover:bg-[#007aff]/10 dark:text-sky-400 dark:hover:bg-sky-950/40"
                  >
                    Restore
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-300">
                {snapshot.experience}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
