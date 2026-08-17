// React hook over the engine's shared pending-approval manager.

import { useEffect, useState } from "react";
import { botApprovals, type ApprovalManager, type PendingApproval } from "../lib/engine";

/**
 * Subscribe to the pending-approval list (all bots). Fires immediately with
 * the current list, then on every request/resolution/withdrawal.
 */
export function usePendingApprovals(
  manager: ApprovalManager = botApprovals,
): PendingApproval[] {
  const [pending, setPending] = useState<PendingApproval[]>(() => manager.listPending());
  useEffect(() => manager.subscribe(setPending), [manager]);
  return pending;
}
