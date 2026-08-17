import { beforeEach, describe, expect, it } from "vitest";
import {
  selectUsageByBot,
  selectUsageByModel,
  useUsageStore,
} from "./usageStore";

beforeEach(() => {
  localStorage.clear();
  useUsageStore.setState({ records: [] });
});

describe("usage store", () => {
  it("records per-call usage with a timestamp", () => {
    useUsageStore.getState().recordUsage({
      botId: "bot-1",
      modelId: "m/a",
      promptTokens: 10,
      completionTokens: 5,
      cost: 0.001,
    });
    const records = useUsageStore.getState().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ botId: "bot-1", modelId: "m/a" });
    expect(typeof records[0]!.at).toBe("number");
  });

  it("aggregates by bot and by model (missing cost counts as 0)", () => {
    const record = useUsageStore.getState().recordUsage;
    record({ botId: "bot-1", modelId: "m/a", promptTokens: 10, completionTokens: 5, cost: 0.001 });
    record({ botId: "bot-1", modelId: "m/b", promptTokens: 100, completionTokens: 50 });
    record({ botId: "bot-2", modelId: "m/a", promptTokens: 1, completionTokens: 2, cost: 0.0005 });

    const state = useUsageStore.getState();
    const byBot = selectUsageByBot(state);
    expect(byBot["bot-1"]).toEqual({
      calls: 2,
      promptTokens: 110,
      completionTokens: 55,
      totalTokens: 165,
      cost: 0.001,
    });
    expect(byBot["bot-2"]).toEqual({
      calls: 1,
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cost: 0.0005,
    });

    const byModel = selectUsageByModel(state);
    expect(byModel["m/a"]).toEqual({
      calls: 2,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      cost: 0.0015,
    });
    expect(byModel["m/b"]!.calls).toBe(1);
  });

  it("persists usage to localStorage and clears on demand", () => {
    useUsageStore.getState().recordUsage({
      botId: "bot-1",
      modelId: "m/a",
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(localStorage.getItem("bots.model-usage")).toContain("bot-1");

    useUsageStore.getState().clearUsage();
    expect(useUsageStore.getState().records).toEqual([]);
  });
});
