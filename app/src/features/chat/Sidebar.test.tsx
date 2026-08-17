import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar, type SidebarBot, type SidebarThreadItem } from "./Sidebar";

const bots: SidebarBot[] = [
  { id: "b1", name: "Research Bot", color: "#0ea5e9", state: "idle" },
  { id: "b2", name: "Sales Bot", color: "#f97316", state: "working", currentTaskTitle: "Drafting outreach" },
];

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    bots,
    selectedBotId: "b1",
    onSelectBot: vi.fn(),
    onNewBot: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe("waiting-state visibility (messaging spec delta)", () => {
  const waitingThread: SidebarThreadItem = {
    id: "b9",
    kind: "direct",
    title: "LinkedIn Bot",
    color: "#8b5cf6",
    state: "waiting",
    preview: "Sign in to your account",
  };

  it("flags a waiting bot with an amber status line and dot", () => {
    render(
      <Sidebar
        threads={[waitingThread]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewBot={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Waiting for you: Sign in to your account"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("waiting for you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LinkedIn Bot/ })).toHaveAttribute(
      "data-waiting",
      "true",
    );
  });

  it("falls back to a generic waiting line without a preview", () => {
    render(
      <Sidebar
        threads={[{ ...waitingThread, preview: undefined }]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewBot={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for you…")).toBeInTheDocument();
  });

  it("lets the unread blue dot win over the amber waiting dot", () => {
    render(
      <Sidebar
        threads={[waitingThread]}
        unreadCounts={{ b9: 2 }}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewBot={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("2 unread")).toBeInTheDocument();
    expect(screen.queryByLabelText("waiting for you")).not.toBeInTheDocument();
  });

  it("shows no waiting treatment for non-waiting states", () => {
    render(
      <Sidebar
        threads={[{ ...waitingThread, state: "working", preview: "On it" }]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewBot={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Waiting for you/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("waiting for you")).not.toBeInTheDocument();
  });
});

describe("Sidebar", () => {
  it("renders each bot with name and state or current task", () => {
    renderSidebar();
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("Drafting outreach")).toBeInTheDocument();
  });

  it("marks the selected bot and reports clicks", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();
    const selected = screen.getByRole("button", { name: /Research Bot/ });
    expect(selected).toHaveAttribute("aria-current", "true");
    const other = screen.getByRole("button", { name: /Sales Bot/ });
    expect(other).not.toHaveAttribute("aria-current");
    await user.click(other);
    expect(props.onSelectBot).toHaveBeenCalledWith("b2");
  });

  it("shows an unread dot only for bots with unread messages", () => {
    renderSidebar({ unreadCounts: { b2: 3 } });
    expect(screen.getByLabelText("3 unread")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/unread/)).toHaveLength(1);
  });

  it("uses the renderAvatar slot per row", () => {
    renderSidebar({
      renderAvatar: (bot) => <span data-testid={`ball-${bot.id}`}>{bot.color}</span>,
    });
    expect(screen.getByTestId("ball-b1")).toHaveTextContent("#0ea5e9");
    expect(screen.getByTestId("ball-b2")).toHaveTextContent("#f97316");
  });

  it("renders the last-message preview and a relative timestamp when provided", () => {
    render(
      <Sidebar
        threads={[
          {
            id: "b1",
            kind: "direct",
            title: "Scout",
            color: "#0ea5e9",
            state: "idle",
            preview: "See you tomorrow!",
            timestamp: Date.now(),
          },
        ]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewBot={vi.fn()}
      />,
    );
    // The preview wins over the state fallback.
    expect(screen.getByText("See you tomorrow!")).toBeInTheDocument();
    expect(screen.queryByText("idle")).toBeNull();
  });

  it("filters rows by title through the search field", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "sales");
    expect(screen.queryByText("Research Bot")).toBeNull();
    expect(screen.getByText("Sales Bot")).toBeInTheDocument();
  });

  it("calls onNewBot from the New Bot button", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();
    await user.click(screen.getByRole("button", { name: "New Bot" }));
    expect(props.onNewBot).toHaveBeenCalledTimes(1);
  });

  describe("thread sections", () => {
    const threads: SidebarThreadItem[] = [
      { id: "b1", kind: "direct", title: "Research Bot", color: "#0ea5e9", state: "idle" },
      { id: "b2", kind: "direct", title: "Sales Bot", color: "#f97316", state: "working" },
      { id: "g1", kind: "group", title: "Renewal Push", participantBotIds: ["b1", "b2"] },
    ];

    it("renders direct threads under Bots and group threads under Teams", () => {
      render(
        <Sidebar
          threads={threads}
          selectedThreadId={null}
          onSelectThread={vi.fn()}
          onNewBot={vi.fn()}
        />,
      );
      expect(screen.getByText("Bots")).toBeInTheDocument();
      expect(screen.getByText("Teams")).toBeInTheDocument();
      expect(screen.getByText("Renewal Push")).toBeInTheDocument();
      expect(screen.getByText("2 bots")).toBeInTheDocument();
      const groupRow = screen.getByRole("button", { name: /Renewal Push/ });
      expect(groupRow).toHaveAttribute("data-thread-kind", "group");
    });

    it("hides section headings for a plain bot roster (backward compat)", () => {
      renderSidebar();
      expect(screen.queryByText("Teams")).toBeNull();
    });

    it("selects by threadId and reports clicks through onSelectThread", async () => {
      const user = userEvent.setup();
      const onSelectThread = vi.fn();
      render(
        <Sidebar
          threads={threads}
          selectedThreadId="g1"
          onSelectThread={onSelectThread}
          onNewBot={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: /Renewal Push/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      await user.click(screen.getByRole("button", { name: /Research Bot/ }));
      expect(onSelectThread).toHaveBeenCalledWith("b1");
      await user.click(screen.getByRole("button", { name: /Renewal Push/ }));
      expect(onSelectThread).toHaveBeenCalledWith("g1");
    });

    it("shows unread dots for group threads", () => {
      render(
        <Sidebar
          threads={threads}
          selectedThreadId={null}
          unreadCounts={{ g1: 4 }}
          onSelectThread={vi.fn()}
          onNewBot={vi.fn()}
        />,
      );
      expect(screen.getByLabelText("4 unread")).toBeInTheDocument();
    });

    it("renders a New Team button when onCreateGroup is provided", async () => {
      const user = userEvent.setup();
      const onCreateGroup = vi.fn();
      renderSidebar({ onCreateGroup });
      await user.click(screen.getByRole("button", { name: "New Team" }));
      expect(onCreateGroup).toHaveBeenCalledTimes(1);
    });

    it("hides the New Team button without onCreateGroup", () => {
      renderSidebar();
      expect(screen.queryByRole("button", { name: "New Team" })).toBeNull();
    });
  });
});

describe("search breadth (design pillar: match what the user remembers)", () => {
  const threads: SidebarThreadItem[] = [
    { id: "t1", kind: "direct", title: "Scout", preview: "Finished the quarterly report" },
    { id: "t2", kind: "direct", title: "Rex", currentTaskTitle: "Booking travel" },
  ];

  it("matches last-message previews and current task titles, not just names", async () => {
    const user = userEvent.setup();
    render(
      <Sidebar threads={threads} selectedThreadId={null} onSelectThread={vi.fn()} onNewBot={vi.fn()} />,
    );
    await user.type(screen.getByRole("searchbox"), "quarterly");
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.queryByText("Rex")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "travel");
    expect(screen.getByText("Rex")).toBeInTheDocument();
    expect(screen.queryByText("Scout")).not.toBeInTheDocument();
  });
});
