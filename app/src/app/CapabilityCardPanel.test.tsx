import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  configureEngineStorage,
  createMemoryStorage,
  getCardStore,
  getWorklogStore,
  resetCardStores,
  resetWorklogStores,
  useBotsStore,
} from "../lib/engine";
import { CapabilityCardPanel } from "./CapabilityCardPanel";

// Multi-bot-collaboration spec, "Capability cards" — "User visibility and
// control": current card, versioned history, pin/edit/revert.
describe("CapabilityCardPanel", () => {
  beforeEach(() => {
    configureEngineStorage(createMemoryStorage());
    resetWorklogStores();
    resetCardStores();
    useBotsStore.setState({ bots: [], hydrated: true });
  });

  function seedBot() {
    const bot = useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research things",
    });
    getWorklogStore(bot.id).record({
      taskTitle: "Research the smart-glass market",
      threadId: bot.id,
      toolsUsed: ["web_fetch"],
      deliverables: [],
      at: Date.now(),
    });
    return bot;
  }

  it("shows the current card: compiled experience, availability, and version", async () => {
    const bot = seedBot();
    render(<CapabilityCardPanel botId={bot.id} />);
    expect(await screen.findByTestId("capability-card-experience")).toHaveTextContent(
      "researched topics",
    );
    expect(screen.getByTestId("capability-card-availability")).toHaveTextContent("idle");
    // Opening the panel published the current card as a version.
    expect(await screen.findByText("v1")).toBeInTheDocument();
  });

  it("pins an edited summary and reverts to the auto-compile", async () => {
    const bot = seedBot();
    const user = userEvent.setup();
    render(<CapabilityCardPanel botId={bot.id} />);

    await user.click(await screen.findByRole("button", { name: "Pin / edit summary" }));
    const textarea = screen.getByLabelText("Edit experience summary");
    await user.clear(textarea);
    await user.type(textarea, "Deep account research specialist");
    await user.click(screen.getByRole("button", { name: "Pin summary" }));

    // The pin wins over the compiled summary — teammates' next delegation
    // decision sees the pinned text (contact_bot reads the same store).
    expect(await screen.findByTestId("capability-card-pinned")).toBeInTheDocument();
    expect(screen.getByTestId("capability-card-experience")).toHaveTextContent(
      "Deep account research specialist",
    );
    expect(getCardStore(bot.id).getPin()).toBe("Deep account research specialist");

    await user.click(screen.getByRole("button", { name: "Revert to auto-summary" }));
    expect(
      await screen.findByText(/researched topics/, {
        selector: '[data-testid="capability-card-experience"]',
      }),
    ).toBeInTheDocument();
    expect(getCardStore(bot.id).getPin()).toBeNull();
  });

  it("lists the version history with the experience text of each version", async () => {
    const bot = seedBot();
    const user = userEvent.setup();
    render(<CapabilityCardPanel botId={bot.id} />);
    await screen.findByText("v1");

    await user.click(screen.getByRole("button", { name: /History/ }));
    const history = screen.getByTestId("capability-card-history");
    expect(history).toHaveTextContent("v1");
    expect(history).toHaveTextContent("researched topics");
  });
});
