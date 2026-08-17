// Thread sidebar: direct threads under "Bots", group threads under "Teams",
// selection by threadId, unread indicators, per-row avatar slot, "New Bot" and
// optional "New Team" buttons. Avatar rendering is injected so this feature
// does not depend on the avatars feature directly.
//
// Visual language (docs/design/visual-style.md): white surface, pill search
// field, 40px-avatar rows with name / last-message preview / relative
// timestamp, an 8px #007aff unread dot, and a soft rounded selection fill.
//
// Backward compatibility: the original bot-roster props (`bots`,
// `selectedBotId`, `onSelectBot`, botId-keyed `unreadCounts`) still work —
// a direct thread's id equals its bot's id.

import { useState, type ReactNode } from "react";
import type { ThreadKind } from "./store";

export type BotState = "idle" | "thinking" | "working" | "waiting" | "sleeping";

export interface SidebarBot {
  id: string;
  name: string;
  color: string;
  state: BotState;
  currentTaskTitle?: string;
}

/** A row in the sidebar thread list. Direct rows mirror SidebarBot fields. */
export interface SidebarThreadItem {
  /** threadId (for direct threads this equals the botId). */
  id: string;
  kind: ThreadKind;
  title: string;
  /** Direct rows: bot accent color. */
  color?: string;
  /** Direct rows: runtime state (shown when no preview/currentTaskTitle). */
  state?: BotState;
  currentTaskTitle?: string;
  /** Group rows: member bots. */
  participantBotIds?: string[];
  /** Last-message preview line (falls back to task title / state). */
  preview?: string;
  /** Last-activity time (ms) shown as a relative timestamp on the row. */
  timestamp?: number;
}

export interface SidebarProps {
  /** Preferred API: full thread list, rendered in sections (direct → "Bots",
   * group → "Teams"). When omitted, `bots` renders the Bots section. */
  threads?: SidebarThreadItem[];
  /** Compat: bot roster rendered as direct threads when `threads` is omitted. */
  bots?: SidebarBot[];
  /** Preferred: selection by threadId. Takes precedence over selectedBotId. */
  selectedThreadId?: string | null;
  /** Compat: selection by botId (direct threadId === botId). */
  selectedBotId?: string | null;
  /** Unread message counts keyed by threadId (dot hidden at 0 / missing). */
  unreadCounts?: Record<string, number>;
  /** Preferred: row click reports the threadId (direct rows report the botId). */
  onSelectThread?: (threadId: string) => void;
  /** Compat: called for direct rows when onSelectThread is not given. */
  onSelectBot?: (botId: string) => void;
  onNewBot: () => void;
  /** Renders a "New Team" button and receives clicks on it. */
  onCreateGroup?: () => void;
  /** Avatar slot per direct row. Falls back to a colored dot. */
  renderAvatar?: (bot: SidebarBot) => ReactNode;
  /** Avatar slot per group row. Falls back to a member-count badge. */
  renderGroupAvatar?: (thread: SidebarThreadItem) => ReactNode;
}

/** Compact relative timestamp for a sidebar row (11px gray, iMessage-style). */
export function formatRowTimestamp(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const ref = new Date(now);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(ref) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function DefaultAvatar({ color }: { color?: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-10 w-10 rounded-full"
      style={{ backgroundColor: color ?? "#9ca3af" }}
    />
  );
}

function DefaultGroupAvatar({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 items-center justify-center rounded-full bg-[#e9e9eb] text-xs font-semibold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200"
    >
      {count}
    </span>
  );
}

function MagnifierIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <circle cx="6" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 13c.5-2 1.9-3 3.5-3s3 1 3.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="11.5" cy="6.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11 10.4c1.4.1 2.3 1 2.7 2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function toItem(bot: SidebarBot): SidebarThreadItem {
  return {
    id: bot.id,
    kind: "direct",
    title: bot.name,
    color: bot.color,
    state: bot.state,
    currentTaskTitle: bot.currentTaskTitle,
  };
}

function toBot(item: SidebarThreadItem): SidebarBot {
  return {
    id: item.id,
    name: item.title,
    color: item.color ?? "#9ca3af",
    state: item.state ?? "idle",
    currentTaskTitle: item.currentTaskTitle,
  };
}

function subtitleFor(item: SidebarThreadItem): string {
  // Waiting bots surface their need for the user on the row itself
  // (messaging spec, "Waiting-state visibility in the thread list").
  if (item.kind === "direct" && item.state === "waiting") {
    return item.preview ? `Waiting for you: ${item.preview}` : "Waiting for you…";
  }
  if (item.preview) return item.preview;
  if (item.currentTaskTitle) return item.currentTaskTitle;
  if (item.kind === "group") {
    const n = item.participantBotIds?.length ?? 0;
    return `${n} bot${n === 1 ? "" : "s"}`;
  }
  return item.state ?? "idle";
}

export function Sidebar({
  threads,
  bots,
  selectedThreadId,
  selectedBotId,
  unreadCounts = {},
  onSelectThread,
  onSelectBot,
  onNewBot,
  onCreateGroup,
  renderAvatar,
  renderGroupAvatar,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const items = threads ?? (bots ?? []).map(toItem);
  const q = query.trim().toLowerCase();
  // Search matches what the user remembers, not just the exact name:
  // title, last-message preview, and current task title.
  const visible =
    q === ""
      ? items
      : items.filter((t) =>
          [t.title, t.preview, t.currentTaskTitle].some(
            (text) => text !== undefined && text.toLowerCase().includes(q),
          ),
        );
  const directItems = visible.filter((t) => t.kind === "direct");
  const groupItems = visible.filter((t) => t.kind === "group");
  const selectedId = selectedThreadId !== undefined ? selectedThreadId : selectedBotId;
  const showSections =
    items.some((t) => t.kind === "group") || onCreateGroup !== undefined;

  const select = (item: SidebarThreadItem) => {
    if (onSelectThread) {
      onSelectThread(item.id);
    } else if (item.kind === "direct") {
      onSelectBot?.(item.id);
    }
  };

  const renderRow = (item: SidebarThreadItem) => {
    const selected = item.id === selectedId;
    const unread = unreadCounts[item.id] ?? 0;
    const waiting = item.kind === "direct" && item.state === "waiting";
    return (
      <li key={item.id} className="px-2">
        <button
          type="button"
          onClick={() => select(item)}
          aria-current={selected ? "true" : undefined}
          data-thread-kind={item.kind}
          data-waiting={waiting || undefined}
          className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left ${
            selected
              ? "bg-[#e9e9eb] dark:bg-neutral-800"
              : "hover:bg-[#f2f2f7] dark:hover:bg-neutral-800/60"
          }`}
        >
          <span
            className="flex w-2.5 shrink-0 justify-center"
            aria-hidden={unread === 0 && !waiting}
          >
            {unread > 0 ? (
              <span
                aria-label={`${unread} unread`}
                className="h-2 w-2 rounded-full bg-[#007aff]"
              />
            ) : waiting ? (
              <span
                aria-label="waiting for you"
                className="h-2 w-2 rounded-full bg-[#ff9f0a]"
              />
            ) : null}
          </span>
          <span className="shrink-0" data-testid={`avatar-slot-${item.id}`}>
            {item.kind === "group"
              ? (renderGroupAvatar?.(item) ?? (
                  <DefaultGroupAvatar count={item.participantBotIds?.length ?? 0} />
                ))
              : renderAvatar
                ? renderAvatar(toBot(item))
                : <DefaultAvatar color={item.color} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-semibold text-[#1c1c1e] dark:text-neutral-100">
                {item.title}
              </span>
              {item.timestamp !== undefined && (
                <span className="shrink-0 text-[11px] text-neutral-400">
                  {formatRowTimestamp(item.timestamp)}
                </span>
              )}
            </span>
            <span
              className={`block truncate text-[13px] ${
                item.kind === "direct" && item.state === "waiting"
                  ? "font-medium text-[#c47708] dark:text-amber-400"
                  : "text-neutral-500 dark:text-neutral-400"
              }`}
            >
              {subtitleFor(item)}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const sectionHeading = (label: string) => (
    <li aria-hidden="true">
      <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </div>
    </li>
  );

  return (
    <nav
      aria-label="Bots"
      className="flex h-full w-full flex-col bg-white dark:bg-neutral-950"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400">
            <MagnifierIcon />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
            placeholder="Search"
            className="w-full rounded-full bg-[#eeeef0] py-1.5 pl-8 pr-3 text-[13px] text-[#1c1c1e] outline-none placeholder:text-neutral-400 focus:bg-[#e9e9eb] dark:bg-neutral-800 dark:text-neutral-100 dark:focus:bg-neutral-700"
          />
        </div>
        <button
          type="button"
          onClick={onNewBot}
          aria-label="New Bot"
          title="New Bot"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#eeeef0] text-neutral-500 hover:bg-[#e2e2e6] hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
        >
          <PlusIcon />
        </button>
        {onCreateGroup && (
          <button
            type="button"
            onClick={onCreateGroup}
            aria-label="New Team"
            title="New Team"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#eeeef0] text-neutral-500 hover:bg-[#e2e2e6] hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
          >
            <PeopleIcon />
          </button>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto pb-2">
        {showSections && sectionHeading("Bots")}
        {directItems.map(renderRow)}
        {showSections && sectionHeading("Teams")}
        {groupItems.map(renderRow)}
      </ul>
    </nav>
  );
}
