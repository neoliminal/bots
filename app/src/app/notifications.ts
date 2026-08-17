// Native notification policy (notifications spec, native subset):
// notifications fire ONLY while the app window is unfocused, for
//   - blocking events: a pending approval parked by any bot, and
//   - notable events: a bot finished a task in a thread the user is not
//     looking at.
// Everything else stays in-app (thread, activity, badge). Clicking a
// notification is best-effort focus — macOS brings the app forward; no
// deep routing yet.

import {
  botApprovals,
  useBotsStore,
  type ApprovalManager,
  type Bot,
  type PendingApproval,
} from "../lib/engine";
import { chatStore } from "../features/chat";
import { notify } from "../lib/native";

export type NotifyFn = (title: string, body: string) => Promise<boolean>;

let notifyFn: NotifyFn = notify;
let focusedFn: () => boolean = () =>
  typeof document !== "undefined" && document.hasFocus();

/** Test seam: replace the native notify call and the focus check. */
export function configureNotifications(overrides: {
  notify?: NotifyFn;
  isFocused?: () => boolean;
}): void {
  if (overrides.notify) notifyFn = overrides.notify;
  if (overrides.isFocused) focusedFn = overrides.isFocused;
}

/** Reset test seams back to the real implementations. */
export function resetNotifications(): void {
  notifyFn = notify;
  focusedFn = () =>
    typeof document !== "undefined" && document.hasFocus();
}

/**
 * Notable event: a bot finished a task. Fires only when the window is
 * unfocused AND the thread is not the one currently open (progress the user
 * is watching stays quiet — notifications spec, "Progress stays quiet").
 */
export function notifyBotFinished(bot: Bot, threadId: string): void {
  if (focusedFn()) return;
  if (chatStore.getState().activeThreadId === threadId) return;
  void notifyFn("Task complete", `${bot.name} finished a task.`);
}

/** Blocking event: an approval is waiting on the user. */
function notifyApprovalPending(approval: PendingApproval): void {
  if (focusedFn()) return;
  const botName =
    useBotsStore.getState().getBot(approval.botId)?.name ?? "A bot";
  void notifyFn(
    "Approval needed",
    `${botName} is waiting on you: ${approval.summary}`,
  );
}

let disposeApprovalWatch: (() => void) | null = null;

/**
 * Watch the shared approvals manager and raise a native notification for
 * every newly parked approval (idempotent; returns a dispose function).
 */
export function initApprovalNotifications(
  manager: ApprovalManager = botApprovals,
): () => void {
  if (disposeApprovalWatch) return disposeApprovalWatch;
  const seen = new Set<string>();
  let first = true;
  const unsubscribe = manager.subscribe((pending) => {
    for (const approval of pending) {
      if (!seen.has(approval.id)) {
        seen.add(approval.id);
        // The initial callback replays already-parked approvals; only
        // genuinely new ones (parked after init) notify.
        if (!first) notifyApprovalPending(approval);
      }
    }
    const current = new Set(pending.map((p) => p.id));
    for (const id of [...seen]) {
      if (!current.has(id)) seen.delete(id);
    }
    first = false;
  });
  disposeApprovalWatch = () => {
    unsubscribe();
    disposeApprovalWatch = null;
  };
  return disposeApprovalWatch;
}
