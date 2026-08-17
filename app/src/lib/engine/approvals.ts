// Pending-approval manager (human-handoff spec — "Approval requests").
// A gated tool call parks the run loop behind a PendingApproval; the UI
// presents it and calls resolveApproval(id, "allow" | "deny", reason?).

export type ApprovalDecision = "allow" | "deny";

/**
 * Where a gated request came from (multi-bot-collaboration spec —
 * "Provenance on delegated approvals"): the delegation chain of bot ids
 * ending with the bot performing the gated action, plus the ephemeral
 * instance id when the acting run is an instance.
 */
export interface ApprovalProvenance {
  /** Bot ids from the originating request to the acting bot, oldest first. */
  chain: string[];
  /** Present when the acting run is an ephemeral instance of the bot. */
  instanceId?: string;
}

export interface PendingApproval {
  id: string;
  botId: string;
  threadId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Human-readable one-liner of exactly what will happen. */
  summary: string;
  createdAt: number;
  /** Delegation provenance (who asked whom, ending in the gated action). */
  provenance?: ApprovalProvenance;
}

export interface ApprovalResolution {
  decision: ApprovalDecision;
  /** Optional denial reason the bot incorporates (human-handoff spec). */
  reason?: string;
}

export type ApprovalsListener = (pending: PendingApproval[]) => void;

export interface ApprovalManager {
  /**
   * Park an approval and wait for a human decision. Resolves when
   * resolve(id, ...) is called; rejects with an AbortError if the signal
   * aborts first (the approval is then withdrawn).
   */
  request(approval: PendingApproval, signal?: AbortSignal): Promise<ApprovalResolution>;
  /**
   * Resolve a pending approval. Returns false when the id is unknown
   * (already resolved, expired, or withdrawn).
   */
  resolve(id: string, decision: ApprovalDecision, reason?: string): boolean;
  get(id: string): PendingApproval | undefined;
  listPending(): PendingApproval[];
  /** Subscribe to the pending list. Fires immediately, then on every change. */
  subscribe(listener: ApprovalsListener): () => void;
}

interface Parked {
  approval: PendingApproval;
  settle: (resolution: ApprovalResolution) => void;
  abort: (err: unknown) => void;
}

export function createApprovalManager(): ApprovalManager {
  const parked = new Map<string, Parked>();
  const listeners = new Set<ApprovalsListener>();

  const listPending = (): PendingApproval[] =>
    [...parked.values()].map((p) => p.approval);

  const notify = (): void => {
    const pending = listPending();
    for (const cb of [...listeners]) cb(pending);
  };

  return {
    request: (approval, signal) =>
      new Promise<ApprovalResolution>((resolvePromise, rejectPromise) => {
        if (signal?.aborted) {
          rejectPromise(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const onAbort = (): void => {
          parked.delete(approval.id);
          notify();
          rejectPromise(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        parked.set(approval.id, {
          approval,
          settle: (resolution) => {
            signal?.removeEventListener("abort", onAbort);
            resolvePromise(resolution);
          },
          abort: (err) => {
            signal?.removeEventListener("abort", onAbort);
            rejectPromise(err);
          },
        });
        notify();
      }),

    resolve: (id, decision, reason) => {
      const entry = parked.get(id);
      if (!entry) return false;
      parked.delete(id);
      entry.settle({ decision, ...(reason !== undefined ? { reason } : {}) });
      notify();
      return true;
    },

    get: (id) => parked.get(id)?.approval,

    listPending,

    subscribe: (listener) => {
      listeners.add(listener);
      listener(listPending());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** App-wide approval manager shared by the engine loop and the approvals UI. */
export const botApprovals: ApprovalManager = createApprovalManager();

/** Convenience: resolve an approval on the shared manager. */
export function resolveApproval(
  id: string,
  decision: ApprovalDecision,
  reason?: string,
): boolean {
  return botApprovals.resolve(id, decision, reason);
}
