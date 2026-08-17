import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { chatStore } from "./features/chat";
import { DEFAULT_MODEL_CONFIG, useModelConfigStore, useUsageStore } from "./features/models";
import { botApprovals, useBotsStore, type PendingApproval } from "./lib/engine";
import { resetBootstrap } from "./app/bootstrap";
import { resetOnboardingForTest } from "./app/onboardingCompute";
import { chatStream } from "./lib/openrouter";

vi.mock("./lib/openrouter", () => ({
  listModels: vi.fn(async () => []),
  chatStream: vi.fn(
    async ({ onDelta }: { onDelta?: (d: string) => void }) => {
      onDelta?.("Hi there!");
      return {
        message: { role: "assistant" as const, content: "Hi there!" },
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cost: 0.0001 },
      };
    },
  ),
}));

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrap();
    chatStore.setState({
      threads: {},
      threadsById: {},
      unread: {},
      activeThreadId: null,
      activeBotId: null,
      hydrated: false,
    });
    useBotsStore.setState({ bots: [], hydrated: false });
    useModelConfigStore.setState({ byBot: {}, defaultConfig: DEFAULT_MODEL_CONFIG });
    useUsageStore.setState({ records: [] });
  });

  afterEach(() => {
    // Never leak parked approvals across tests.
    for (const p of botApprovals.listPending()) botApprovals.resolve(p.id, "deny");
  });

  it("renders the app shell with an empty state when no bots exist", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Bots" })).toBeInTheDocument();
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
    // One-click first bot (design pillar) with the full editor secondary.
    expect(
      screen.getByRole("button", { name: "Start with an Assistant" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Customize your own…" }),
    ).toBeInTheDocument();
  });

  it("creates a ready assistant in one click from the empty state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start with an Assistant" }),
    );
    // No modal, no typing: the bot exists and its thread is open.
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("creates a bot through the New Bot modal", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customize your own…" }));
    const dialog = await screen.findByRole("dialog", { name: "New Bot" });
    expect(dialog).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Scout");
    await user.type(screen.getByLabelText("Role description"), "Research accounts");
    await user.click(screen.getByRole("button", { name: "Create Bot" }));

    // Modal closes; bot appears in the sidebar and the thread header.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const sidebar = screen.getByRole("navigation", { name: "Bots" });
    expect(sidebar).toHaveTextContent("Scout");
    expect(useBotsStore.getState().listBots()).toHaveLength(1);
    expect(screen.getByRole("log", { name: "Messages" })).toBeInTheDocument();
  });

  it("sends a message and streams the bot reply end-to-end", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Customize your own…" }));
    await user.type(await screen.findByLabelText("Name"), "Scout");
    await user.click(screen.getByRole("button", { name: "Create Bot" }));

    await user.type(screen.getByRole("textbox", { name: "Message" }), "Hello{Enter}");

    // Scoped to the log; "Hello" also appears in the intro card's receipt
    // (free text answers the starter card), so allow multiple matches.
    const log = screen.getByRole("log", { name: "Messages" });
    expect((await within(log).findAllByText("Hello")).length).toBeGreaterThan(0);
    expect(await within(log).findByText("Hi there!")).toBeInTheDocument();

    const botId = useBotsStore.getState().listBots()[0].id;
    const thread = chatStore.getState().threads[botId];
    // thread[0] is the seeded introduction (bot-management spec).
    expect(thread[0]).toMatchObject({ role: "bot", status: "delivered" });
    expect(thread[0].choices).toBeDefined();
    expect(thread[1]).toMatchObject({ role: "user", status: "delivered" });
    expect(thread[2]).toMatchObject({ role: "bot", status: "delivered" });
    expect(useUsageStore.getState().records).toHaveLength(1);
  });

  it("surfaces pending approvals in the thread and the Waiting-on-you inbox", async () => {
    const user = userEvent.setup();
    const bot = useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research",
    });
    render(<App />);
    await screen.findByRole("log", { name: "Messages" });

    // Park a gated tool call, as the run loop would.
    const approval: PendingApproval = {
      id: "ap-test-1",
      botId: bot.id,
      threadId: bot.id,
      toolName: "send_email",
      args: { to: "dana@example.com", subject: "Q3", body: "Hi Dana" },
      summary: "send_email(...)",
      createdAt: Date.now(),
    };
    let resolution: unknown;
    const parked = botApprovals.request(approval).then((r) => {
      resolution = r;
    });

    // Approval card renders in the open thread…
    expect(await screen.findAllByTestId("approval-card")).toHaveLength(1);
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();

    // …and the sidebar badge counts it.
    expect(screen.getByLabelText("1 pending approval")).toBeInTheDocument();

    // The inbox lists it; allowing resumes the parked request.
    await user.click(screen.getByRole("button", { name: /Waiting on you/ }));
    expect(screen.getByRole("heading", { name: "Waiting on you" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await parked;
    expect(resolution).toEqual({ decision: "allow" });
    expect(await screen.findByText("Nothing is waiting on you.")).toBeInTheDocument();
  });

  it("toggles the detail panel from the chat header", async () => {
    const user = userEvent.setup();
    useBotsStore.getState().createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research",
    });
    render(<App />);
    await screen.findByRole("log", { name: "Messages" });

    // Collapsed by default; the header toggle opens it.
    expect(screen.queryByTestId("detail-panel")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Toggle details" }));
    const panel = await screen.findByTestId("detail-panel");
    expect(within(panel).getByText("Routines")).toBeInTheDocument();
    expect(within(panel).getByTestId("detail-session-status")).toBeInTheDocument();
    expect(
      await within(panel).findByTestId("capability-card-current"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle details" }));
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });

  it("creates a team through the New Team modal and chats in the group thread", async () => {
    const user = userEvent.setup();
    const store = useBotsStore.getState();
    store.createBot({
      name: "EA",
      color: "#0ea5e9",
      roleDescription: "Coordinate the team",
      isCoordinator: true,
    });
    store.createBot({
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "Research things",
    });
    render(<App />);
    await screen.findByRole("log", { name: "Messages" });

    await user.click(screen.getByRole("button", { name: "New Team" }));
    const dialog = await screen.findByRole("dialog", { name: "New Team" });
    // With exactly two bots both members are preselected and the name is
    // suggested (design pillar) — typing a name overrides the suggestion.
    expect(within(dialog).getByRole("checkbox", { name: "EA" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Scout" })).toBeChecked();
    const nameField = within(dialog).getByLabelText("Team name");
    await user.clear(nameField);
    await user.type(nameField, "Q3 Push");
    await user.click(within(dialog).getByRole("button", { name: "Create Team" }));

    // The team opens (header) and shows under a "Teams" section in the sidebar.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Q3 Push" })).toBeInTheDocument();
    const sidebar = screen.getByRole("navigation", { name: "Bots" });
    expect(sidebar).toHaveTextContent("Teams");
    expect(sidebar).toHaveTextContent("Q3 Push");

    // Messaging the team routes to the coordinator, whose reply is attributed.
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Team, go{Enter}");
    const log = screen.getByRole("log", { name: "Messages" });
    expect(await within(log).findByText("Hi there!")).toBeInTheDocument();
    expect(await screen.findByTestId("message-author")).toHaveTextContent("EA");
  });

  it("shows the avatar gallery behind the developer menu", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Developer menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Avatar gallery" }));

    expect(screen.getByRole("heading", { name: "Avatar gallery" })).toBeInTheDocument();
    // All 11 states are rendered as labeled avatars.
    expect(screen.getByRole("img", { name: /— celebrating/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /— connection lost/ })).toBeInTheDocument();
  });
});

describe("sidebar gaze (bot-avatars spec, ambient eye life)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrap();
    chatStore.setState({
      threads: {},
      threadsById: {},
      unread: {},
      activeThreadId: null,
      activeBotId: null,
      hydrated: false,
    });
    useBotsStore.setState({ bots: [], hydrated: false });
  });

  it("the open conversation's row watches the cursor, harder than ambient", async () => {
    // rAF inline so the gaze applies synchronously with the pointer move.
    // Inline, but not re-entrant: the pose tween re-schedules itself every
    // frame and would recurse forever otherwise. This test reads the target
    // the eyes are aiming at, which the tween does not change.
    let inCallback = false;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (inCallback) return 0;
      inCallback = true;
      try {
        cb(0);
      } finally {
        inCallback = false;
      }
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      render(<App />);
      // Let bootstrap finish hydrating before seeding — its hydrate() reads
      // storage and would otherwise replace bots created beforehand.
      await screen.findByText("No bots yet");
      const store = useBotsStore.getState();
      let scoutId = "";
      act(() => {
        scoutId = store.createBot({
          name: "Scout",
          color: "#14b8a6",
          roleDescription: "Research",
        }).id;
        store.createBot({ name: "EA", color: "#a78bfa", roleDescription: "Admin" });
        chatStore.getState().setActiveBot(scoutId);
      });

      const nav = await screen.findByRole("navigation", { name: "Bots" });
      await vi.waitFor(() =>
        expect(nav.querySelectorAll(".av-eyes").length).toBeGreaterThan(1),
      );

      // jsdom rects are all zeros, so the avatar centre is (0,0) and the
      // pointer position IS the direction. 500px out is past full range at
      // intensity 2.4, so the gaze pins to its widened radius: 4.5 * 2.4.
      act(() => {
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 0 }));
      });

      const deflections = [...nav.querySelectorAll<SVGGElement>(".av-eyes")].map(
        (r) => Number((r.getAttribute("data-gaze") ?? "0,0").split(",")[0]),
      );
      // One row is locked on at the widened radius: 4.5 * 3.2.
      expect(Math.max(...deflections)).toBeCloseTo(14.4, 5);
      // …and only one: ambient wander is capped at ±4, and even a normal
      // cursor follow tops out at 4.5, so nothing else can be out there.
      expect(deflections.filter((x) => x > 4.5)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("bot introductions (bot-management spec)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrap();
    resetOnboardingForTest();
    chatStore.setState({
      threads: {},
      threadsById: {},
      unread: {},
      activeThreadId: null,
      activeBotId: null,
      hydrated: false,
    });
    useBotsStore.setState({ bots: [], hydrated: false });
    vi.mocked(chatStream).mockClear();
  });

  /** Quick-create the first bot and settle its compute question locally. */
  async function firstBotOnThisMac(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole("button", { name: "Start with an Assistant" }),
    );
    const log = screen.getByRole("log", { name: "Messages" });
    await user.click(await within(log).findByRole("button", { name: /^This computer —/ }));
    return log;
  }

  it("leads the FIRST bot's introduction with the compute-location question", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start with an Assistant" }),
    );
    const log = screen.getByRole("log", { name: "Messages" });
    expect(await within(log).findByText(/Hi — I'm Assistant\./)).toBeInTheDocument();
    expect(within(log).getByText("Where should I run commands?")).toBeInTheDocument();
    // Every location is one click, plus an explicit way to skip.
    expect(within(log).getByRole("button", { name: /^This computer —/ })).toBeInTheDocument();
    expect(
      within(log).getByRole("button", { name: /^A machine I own —/ }),
    ).toBeInTheDocument();
    expect(within(log).getByRole("button", { name: /^A cloud VM —/ })).toBeInTheDocument();
    expect(within(log).getByRole("button", { name: /^Decide later/ })).toBeInTheDocument();
    // Starter tasks wait until the location is settled.
    expect(within(log).queryByText("What should I take on first?")).toBeNull();
    // The composer never blocks on the card.
    expect(screen.getByRole("textbox", { name: /Message/ })).toBeEnabled();
  });

  it("answers the compute question locally, with no model call, then offers starter tasks", async () => {
    const user = userEvent.setup();
    render(<App />);
    const log = await firstBotOnThisMac(user);
    // The answer posted as a user message and the card collapsed…
    expect((await within(log).findAllByText(/^This computer —/)).length).toBeGreaterThan(0);
    expect(within(log).getAllByTestId("choice-chips")[0]).toHaveAttribute(
      "data-answered",
      "true",
    );
    // …the bot replied locally — onboarding works with no API key…
    expect(await within(log).findByText(/Right here it is/)).toBeInTheDocument();
    expect(chatStream).not.toHaveBeenCalled();
    // …and the starter-task card follows.
    expect(
      await within(log).findByText("What should I take on first?"),
    ).toBeInTheDocument();
  });

  it("asks the compute question only for the first bot", async () => {
    const user = userEvent.setup();
    render(<App />);
    await firstBotOnThisMac(user);
    // A second bot, created from the full editor.
    await user.click(screen.getByRole("button", { name: "New Bot" }));
    await user.type(screen.getByLabelText("Name"), "Scout");
    await user.click(screen.getByRole("button", { name: "Create Bot" }));
    const log = screen.getByRole("log", { name: "Messages" });
    expect(await within(log).findByText(/Hi — I'm Scout\./)).toBeInTheDocument();
    expect(
      await within(log).findByText("What should I take on first?"),
    ).toBeInTheDocument();
    expect(within(log).queryByText("Where should I run commands?")).toBeNull();
  });

  it("seeds a greeting with a starter-options card, and a click sends", async () => {
    const user = userEvent.setup();
    render(<App />);
    // The introduction is local and instant: greeting + question card
    // (scoped to the log — the sidebar preview repeats the greeting).
    const log = await firstBotOnThisMac(user);
    expect(
      await within(log).findByText("What should I take on first?"),
    ).toBeInTheDocument();
    const option = within(log).getByRole("button", { name: /Help me plan my day/ });
    await user.click(option);
    // The answer flows through the normal send path (user message appears)
    // and the card collapses to a receipt.
    expect(
      (await within(log).findAllByText("Help me plan my day")).length,
    ).toBeGreaterThan(0);
    const cards = within(log).getAllByTestId("choice-chips");
    expect(cards[cards.length - 1]).toHaveAttribute("data-answered", "true");
  });
});
