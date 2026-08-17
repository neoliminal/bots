// "Waiting on you" inbox: every pending approval across all bots in one
// list (human-handoff spec — pending requests remain actionable anywhere).
// Resolving here resumes the parked bot exactly like resolving in-thread.

import type { ReactNode } from "react";
import type { Bot, PendingApproval } from "../lib/engine";
import { ApprovalCard } from "./ApprovalCard";

export interface ApprovalsInboxProps {
  approvals: PendingApproval[];
  /** Roster used to label each request with its bot's name. */
  bots: Bot[];
  /** Open the thread the request came from (e.g. jump from inbox to chat). */
  onOpenThread?: (threadId: string) => void;
  /** Avatar slot per request row (bot may be undefined for deleted bots). */
  renderAvatar?: (botId: string) => ReactNode;
}

export function ApprovalsInbox({
  approvals,
  bots,
  onOpenThread,
  renderAvatar,
}: ApprovalsInboxProps) {
  if (approvals.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <span aria-hidden="true" className="text-2xl">✓</span>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Nothing is waiting on you.
        </p>
      </div>
    );
  }

  const botsById = new Map(bots.map((b) => [b.id, b]));
  const botNames = Object.fromEntries(bots.map((b) => [b.id, b.name]));

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-label="Pending approvals">
      {approvals.map((approval) => {
        const bot = botsById.get(approval.botId);
        return (
          <div key={approval.id} className="flex items-start gap-3">
            {renderAvatar && (
              <div className="w-8 shrink-0 pt-1">{renderAvatar(approval.botId)}</div>
            )}
            <div className="min-w-0 flex-1">
              <ApprovalCard approval={approval} botName={bot?.name} botNames={botNames} />
              {onOpenThread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(approval.threadId)}
                  className="mt-1 text-xs text-[#007aff] hover:underline dark:text-[#409cff]"
                >
                  Open thread
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
