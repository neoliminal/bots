import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botApprovals,
  botRuntime,
  useBotsStore,
  type PendingApproval,
} from "../lib/engine";
import type { TrayBotItem } from "../lib/native";
import { createShellIntegration, pauseAllBots, trayItems } from "./shell";

function approval(id: string, botId: string): PendingApproval {
  return {
    id,
    botId,
    threadId: botId,
    toolName: "send_email",
    args: {},
    summary: "send_email(...)",
    createdAt: Date.now(),
  };
}

describe("shell integration (tray + badge)", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    useBotsStore.setState({ bots: [], hydrated: true });
    for (const p of botApprovals.listPending()) botApprovals.resolve(p.id, "deny");
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    for (const p of botApprovals.listPending()) botApprovals.resolve(p.id, "deny");
    for (const b of useBotsStore.getState().bots) botRuntime.clear(b.id);
  });

  it("trayItems renders one '<name> — <status>' line per active bot", () => {
    const bot = useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "r",
    });
    botRuntime.setState(bot.id, "thinking");
    expect(trayItems()).toEqual([{ id: bot.id, title: "Scout — thinking" }]);

    useBotsStore.getState().softDeleteBot(bot.id);
    expect(trayItems()).toEqual([]);
    botRuntime.clear(bot.id);
  });

  it("updates the tray (debounced) when runtime states or the roster change", async () => {
    const updates: TrayBotItem[][] = [];
    dispose = createShellIntegration({
      trayUpdate: async (items) => {
        updates.push(items);
      },
      setBadgeCount: async () => {},
      onTrayPauseAll: async () => () => {},
      debounceMs: 0,
    });

    const bot = useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "r",
    });
    botRuntime.setState(bot.id, "working");
    await vi.waitFor(() => {
      const last = updates[updates.length - 1];
      expect(last).toEqual([{ id: bot.id, title: "Scout — working" }]);
    });

    botRuntime.setState(bot.id, "idle");
    await vi.waitFor(() => {
      const last = updates[updates.length - 1];
      expect(last).toEqual([{ id: bot.id, title: "Scout — idle" }]);
    });
  });

  it("mirrors the pending approval count onto the dock badge", async () => {
    const counts: Array<number | null> = [];
    dispose = createShellIntegration({
      trayUpdate: async () => {},
      setBadgeCount: async (count) => {
        counts.push(count);
      },
      onTrayPauseAll: async () => () => {},
      debounceMs: 0,
    });
    expect(counts).toEqual([null]); // initial state: no badge

    void botApprovals.request(approval("ap-b1", "bot-x")).catch(() => {});
    void botApprovals.request(approval("ap-b2", "bot-x")).catch(() => {});
    expect(counts[counts.length - 1]).toBe(2);

    botApprovals.resolve("ap-b1", "deny");
    botApprovals.resolve("ap-b2", "deny");
    expect(counts[counts.length - 1]).toBeNull();
  });

  it("tray Pause All pauses every active bot and puts it to sleep", async () => {
    let handler: (() => void) | undefined;
    dispose = createShellIntegration({
      trayUpdate: async () => {},
      setBadgeCount: async () => {},
      onTrayPauseAll: async (h) => {
        handler = h;
        return () => {};
      },
      debounceMs: 0,
    });
    const store = useBotsStore.getState();
    const a = store.createBot({ name: "A", color: "#111", roleDescription: "r" });
    const b = store.createBot({ name: "B", color: "#222", roleDescription: "r" });

    await vi.waitFor(() => expect(handler).toBeDefined());
    handler!();

    const bots = useBotsStore.getState().listBots();
    expect(bots.every((bot) => bot.paused)).toBe(true);
    expect(botRuntime.getState(a.id)).toBe("sleeping");
    expect(botRuntime.getState(b.id)).toBe("sleeping");
  });

  it("pauseAllBots pauses active bots and leaves paused ones untouched", () => {
    const store = useBotsStore.getState();
    const a = store.createBot({ name: "A", color: "#111", roleDescription: "r" });
    const b = store.createBot({ name: "B", color: "#222", roleDescription: "r" });
    store.updateBot(a.id, { paused: true });
    botRuntime.setState(a.id, "sleeping");

    pauseAllBots();

    const bots = useBotsStore.getState().listBots();
    expect(bots.every((bot) => bot.paused)).toBe(true);
    expect(botRuntime.getState(a.id)).toBe("sleeping");
    expect(botRuntime.getState(b.id)).toBe("sleeping");
  });
});
