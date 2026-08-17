// Run-tree tracking for delegation chains.
// Spec: openspec/specs/multi-bot-collaboration/spec.md — "Delegation chain
// safeguards": "the entire delegation tree SHALL cancel when the originating
// request is stopped" and fan-out per request is capped.
//
// The engine owns the tree (runId -> descendants) and per-run fan-out
// counters; integration (chatGlue) registers each enqueued run with its
// parentRunId and an abort callback (its RunHandle's controller.abort), and
// calls abortTree(runId) from Stop so every descendant halts.

/** Delegations allowed per run before contact_bot refuses (fan-out cap). */
export const DELEGATION_MAX_FAN_OUT = 3;

interface RunNode {
  runId: string;
  parentRunId?: string;
  abort?: () => void;
  children: Set<string>;
  active: boolean;
  fanOut: number;
}

export interface RegisterRunOptions {
  /** The run that delegated this run (DelegationRequest.parentRunId). */
  parentRunId?: string;
  /** Called by abortTree to cancel this run (e.g. controller.abort). */
  abort?: () => void;
}

export interface RunTracker {
  /** Track a run (idempotent per runId; later options fill missing fields). */
  register(runId: string, options?: RegisterRunOptions): void;
  /** Mark a run finished; fully-settled subtrees are garbage-collected. */
  complete(runId: string): void;
  /** True while the run is registered and not completed/aborted. */
  isActive(runId: string): boolean;
  /** Transitive descendant run ids of a run (children first, oldest first). */
  descendants(runId: string): string[];
  /**
   * Abort a run and every descendant (deepest first): each node's abort
   * callback fires once and the subtree is marked inactive. Returns the run
   * ids aborted, deepest first.
   */
  abortTree(runId: string): string[];
  /** Increment a run's delegation fan-out counter; returns the new count. */
  noteFanOut(runId: string): number;
  /** Delegations this run has already made. */
  fanOutOf(runId: string): number;
  /** Drop all tracked state (tests). */
  reset(): void;
}

export function createRunTracker(): RunTracker {
  const nodes = new Map<string, RunNode>();

  const ensure = (runId: string): RunNode => {
    let node = nodes.get(runId);
    if (!node) {
      node = { runId, children: new Set(), active: true, fanOut: 0 };
      nodes.set(runId, node);
    }
    return node;
  };

  /** Remove settled leaf nodes upward so the map stays bounded. */
  const gc = (runId: string): void => {
    const node = nodes.get(runId);
    if (!node || node.active || node.children.size > 0) return;
    nodes.delete(runId);
    if (node.parentRunId !== undefined) {
      const parent = nodes.get(node.parentRunId);
      if (parent) {
        parent.children.delete(runId);
        gc(node.parentRunId);
      }
    }
  };

  const collectDescendants = (runId: string, out: string[]): void => {
    const node = nodes.get(runId);
    if (!node) return;
    for (const childId of node.children) {
      out.push(childId);
      collectDescendants(childId, out);
    }
  };

  return {
    register: (runId, options = {}) => {
      const node = ensure(runId);
      if (options.abort !== undefined) node.abort = options.abort;
      if (options.parentRunId !== undefined && node.parentRunId === undefined) {
        node.parentRunId = options.parentRunId;
        ensure(options.parentRunId).children.add(runId);
      }
    },

    complete: (runId) => {
      const node = nodes.get(runId);
      if (!node) return;
      node.active = false;
      gc(runId);
    },

    isActive: (runId) => nodes.get(runId)?.active === true,

    descendants: (runId) => {
      const out: string[] = [];
      collectDescendants(runId, out);
      return out;
    },

    abortTree: (runId) => {
      const node = nodes.get(runId);
      if (!node) return [];
      const ordered = [runId, ...(() => {
        const out: string[] = [];
        collectDescendants(runId, out);
        return out;
      })()].reverse(); // deepest first: children halt before their parents
      for (const id of ordered) {
        const n = nodes.get(id);
        if (!n || !n.active) continue;
        n.active = false;
        try {
          n.abort?.();
        } catch {
          // an abort callback must never break tree cancellation
        }
      }
      for (const id of ordered) gc(id);
      return ordered;
    },

    noteFanOut: (runId) => {
      const node = ensure(runId);
      node.fanOut += 1;
      return node.fanOut;
    },

    fanOutOf: (runId) => nodes.get(runId)?.fanOut ?? 0,

    reset: () => {
      nodes.clear();
    },
  };
}

/** App-wide run tracker shared by the delegation tool and chatGlue's Stop. */
export const botRuns: RunTracker = createRunTracker();
