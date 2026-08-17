import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatStore } from "../features/chat";
import {
  createApprovalManager,
  useBotsStore,
  type Bot,
  type PendingApproval,
} from "../lib/engine";
import {
  configureNotifications,
  initApprovalNotifications,
  notifyBotFinished,
  resetNotifications,
} from "./notifications";

const bot: Bot = {
  id: "bot-1",
  name: "Scout",
  color: "#14b8a6",
  roleDescription: "Research",
  createdAt: 1,
  paused: false,
};

function approval(id: string): PendingApproval {
  return {
    id,
    botId: "bot-1",
    threadId: "bot-1",
    toolName: "send_email",
    args: {},
    summary: "send_email(...)",
    createdAt: Date.now(),
  };
}

describe("notifications policy", () => {
  let sent: Array<{ title: string; body: string }>;

  beforeEach(() => {
    sent = [];
    chatStore.setState({ activeThreadId: null, activeBotId: null });
    useBotsStore.setState({ bots: [bot], hydrated: true });
    configureNotifications({
      notify: async (title, body) => {
        sent.push({ title, body });
        return true;
      },
      isFocused: () => false,
    });
  });

  afterEach(() => {
    resetNotifications();
  });

  it("notifies a finished task only while the window is unfocused", () => {
    notifyBotFinished(bot, "some-thread");
    expect(sent).toEqual([
      { title: "Task complete", body: "Scout finished a task." },
    ]);

    configureNotifications({ isFocused: () => true });
    notifyBotFinished(bot, "some-thread");
    expect(sent).toHaveLength(1);
  });

  it("stays quiet for the thread the user has open", () => {
    chatStore.setState({ activeThreadId: "thread-9" });
    notifyBotFinished(bot, "thread-9");
    expect(sent).toHaveLength(0);

    notifyBotFinished(bot, "other-thread");
    expect(sent).toHaveLength(1);
  });

  it("notifies newly parked approvals while unfocused", async () => {
    const manager = createApprovalManager();
    const dispose = initApprovalNotifications(manager);

    void manager.request(approval("ap-1")).catch(() => {});
    expect(sent).toEqual([
      {
        title: "Approval needed",
        body: "Scout is waiting on you: send_email(...)",
      },
    ]);

    manager.resolve("ap-1", "deny");
    // A second approval after resolution notifies again.
    void manager.request(approval("ap-2")).catch(() => {});
    expect(sent).toHaveLength(2);
    manager.resolve("ap-2", "deny");
    dispose();
  });

  it("does not notify approvals while the window is focused", () => {
    configureNotifications({ isFocused: () => true });
    const manager = createApprovalManager();
    const dispose = initApprovalNotifications(manager);
    void manager.request(approval("ap-3")).catch(() => {});
    expect(sent).toHaveLength(0);
    manager.resolve("ap-3", "deny");
    dispose();
  });

  it("does not replay approvals already parked when the watcher starts", () => {
    const manager = createApprovalManager();
    void manager.request(approval("ap-0")).catch(() => {});
    const dispose = initApprovalNotifications(manager);
    expect(sent).toHaveLength(0);
    manager.resolve("ap-0", "deny");
    dispose();
  });

  it("init is idempotent and disposable", () => {
    const manager = createApprovalManager();
    const dispose = initApprovalNotifications(manager);
    expect(initApprovalNotifications(manager)).toBe(dispose);
    dispose();
    void manager.request(approval("ap-4")).catch(() => {});
    expect(sent).toHaveLength(0);
    manager.resolve("ap-4", "deny");
  });
});
