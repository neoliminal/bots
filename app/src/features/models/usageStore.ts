// Model usage log (spec: openspec/specs/model-configuration,
// "Usage and cost visibility"): per-call token/cost records with aggregate
// selectors by Bot and by model.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface UsageRecord {
  botId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported USD cost, when available. */
  cost?: number;
  /** Epoch milliseconds of the call. */
  at: number;
}

export interface UsageAggregate {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of provider-reported costs (records without cost contribute 0). */
  cost: number;
}

export interface UsageState {
  records: UsageRecord[];
  /** Append a usage record; `at` defaults to now. */
  recordUsage: (record: Omit<UsageRecord, "at"> & { at?: number }) => void;
  clearUsage: () => void;
}

export const useUsageStore = create<UsageState>()(
  persist(
    (set) => ({
      records: [],
      recordUsage: (record) =>
        set((state) => ({
          records: [...state.records, { ...record, at: record.at ?? Date.now() }],
        })),
      clearUsage: () => set({ records: [] }),
    }),
    {
      name: "bots.model-usage",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// ---------------------------------------------------------------------------
// Aggregate selectors
// ---------------------------------------------------------------------------

function aggregate(
  records: UsageRecord[],
  keyOf: (record: UsageRecord) => string,
): Record<string, UsageAggregate> {
  const out: Record<string, UsageAggregate> = {};
  for (const record of records) {
    const key = keyOf(record);
    const agg = (out[key] ??= {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
    });
    agg.calls += 1;
    agg.promptTokens += record.promptTokens;
    agg.completionTokens += record.completionTokens;
    agg.totalTokens += record.promptTokens + record.completionTokens;
    agg.cost += record.cost ?? 0;
  }
  return out;
}

/** Token/cost totals keyed by botId. */
export function selectUsageByBot(
  state: Pick<UsageState, "records">,
): Record<string, UsageAggregate> {
  return aggregate(state.records, (r) => r.botId);
}

/** Token/cost totals keyed by modelId. */
export function selectUsageByModel(
  state: Pick<UsageState, "records">,
): Record<string, UsageAggregate> {
  return aggregate(state.records, (r) => r.modelId);
}
