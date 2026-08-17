import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  configureEngineStorage,
  createMemoryStorage,
  resetCardStores,
  resetWorklogStores,
  useBotsStore,
  type PendingApproval,
} from "../lib/engine";
import { DetailPanel } from "./DetailPanel";

// Detail panel (docs/design/visual-style.md): session status, capability
// card, routines placeholder, and this bot's Waiting-on-you items.
describe("DetailPanel", () => {
  beforeEach(() => {
    configureEngineStorage(createMemoryStorage());
    resetWorklogStores();
    resetCardStores();
    useBotsStore.setState({ bots: [], hydrated: true });
  });

  function seedBot(overrides: { paused?: boolean } = {}) {
    const bot = useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research things",
    });
    if (overrides.paused) {
      useBotsStore.getState().updateBot(bot.id, { paused: true });
      return useBotsStore.getState().getBot(bot.id)!;
    }
    return bot;
  }

  it("shows session status, capability card, and the routines placeholder", async () => {
    const bot = seedBot();
    render(
      <DetailPanel bot={bot} statusLabel="thinking" approvals={[]} botNames={{}} />,
    );
    expect(screen.getByTestId("detail-session-status")).toHaveTextContent("thinking");
    expect(await screen.findByTestId("capability-card-current")).toBeInTheDocument();
    expect(screen.getByText("Routines")).toBeInTheDocument();
    expect(screen.getByText("No routines yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument();
  });

  it("shows paused instead of the runtime state for a paused bot", async () => {
    const bot = seedBot({ paused: true });
    render(
      <DetailPanel bot={bot} statusLabel="thinking" approvals={[]} botNames={{}} />,
    );
    expect(screen.getByTestId("detail-session-status")).toHaveTextContent("paused");
    await screen.findByTestId("capability-card-current");
  });

  it("lists the bot's pending approvals as actionable cards", async () => {
    const bot = seedBot();
    const user = userEvent.setup();
    const approval: PendingApproval = {
      id: "ap-1",
      botId: bot.id,
      threadId: bot.id,
      toolName: "send_email",
      args: { to: "dana@example.com", subject: "Q3", body: "Hi" },
      summary: "send_email(...)",
      createdAt: Date.now(),
    };
    render(
      <DetailPanel
        bot={bot}
        statusLabel="idle"
        approvals={[approval]}
        botNames={{ [bot.id]: bot.name }}
      />,
    );
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    // The card is the live component — its controls are present and wired.
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deny…" }));
    expect(screen.getByLabelText("Denial reason")).toBeInTheDocument();
    await screen.findByTestId("capability-card-current");
  });
});
