// Detail panel (docs/design/visual-style.md, "Window layout" column 3): a
// collapsible right-hand column on the off-white #f7f7f9 panel tint giving
// context for the selected bot — session status card, capability card
// summary (multi-bot-collaboration spec), a Routines placeholder section
// (routines spec is future work; the list style matches the brief), and the
// bot's pending "Waiting on you" approvals (human-handoff spec). Approval
// cards here are the SAME component as in-thread, so resolving from the
// panel resumes the parked run identically.

import type { ReactNode } from "react";
import type { Bot, PendingApproval } from "../lib/engine";
import { ApprovalCard } from "./ApprovalCard";
import { CapabilityCardPanel } from "./CapabilityCardPanel";
import { RoutinesPanel } from "./RoutinesPanel";

export interface DetailPanelProps {
  bot: Bot;
  /** Human-readable session/runtime status line (e.g. "thinking", "paused"). */
  statusLabel: string;
  /** Pending approvals for THIS bot only. */
  approvals: PendingApproval[];
  /** Bot display names by id, for approval provenance chains. */
  botNames?: Record<string, string>;
  /** Avatar slot for the session card header. */
  renderAvatar?: (botId: string, size: number) => ReactNode;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
      {children}
    </h3>
  );
}

export function DetailPanel({
  bot,
  statusLabel,
  approvals,
  botNames,
  renderAvatar,
}: DetailPanelProps) {
  return (
    <aside
      aria-label="Details"
      data-testid="detail-panel"
      className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-neutral-200 bg-[#f7f7f9] p-4 dark:border-neutral-800 dark:bg-neutral-900/60"
    >
      <section aria-label="Session">
        <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center gap-3">
            <span className="shrink-0">{renderAvatar?.(bot.id, 40)}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-[#1c1c1e] dark:text-neutral-100">
                {bot.name}
              </div>
              <div
                data-testid="detail-session-status"
                className="truncate text-xs text-neutral-500 dark:text-neutral-400"
              >
                {bot.paused ? "paused" : statusLabel}
              </div>
            </div>
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${
                bot.paused ? "bg-neutral-300" : "bg-[#34c759]"
              }`}
            />
          </div>
        </div>
      </section>

      <section aria-label="Capabilities">
        <SectionHeading>Capabilities</SectionHeading>
        <CapabilityCardPanel botId={bot.id} />
      </section>

      <section aria-label="Routines">
        <SectionHeading>Routines</SectionHeading>
        <RoutinesPanel botId={bot.id} botName={bot.name} />
      </section>

      <section aria-label="Waiting on you">
        <SectionHeading>Waiting on you</SectionHeading>
        {approvals.length === 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-xs text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
            Nothing is waiting on you.
          </div>
        ) : (
          <div className="space-y-2">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                botName={bot.name}
                botNames={botNames}
              />
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
