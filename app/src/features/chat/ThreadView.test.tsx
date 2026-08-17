import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingApproval } from "../../lib/engine";
import { ThreadView } from "./ThreadView";
import type { ChatMessage, Thread } from "./store";

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "user",
    threadId: "bot-1",
    text: "hello",
    status: "delivered",
    createdAt: 1,
    ...overrides,
  };
}

const groupThread: Thread = {
  id: "g1",
  kind: "group",
  participantBotIds: ["bot-1", "bot-2"],
  title: "Team",
  createdAt: 1,
};

const directThread: Thread = {
  id: "bot-1",
  kind: "direct",
  participantBotIds: ["bot-1"],
  createdAt: 1,
};

describe("ThreadView", () => {
  it("shows an empty state without messages", () => {
    render(<ThreadView messages={[]} />);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("renders user messages right-aligned and bot messages left, without per-bubble avatars in direct threads", () => {
    const { container } = render(
      <ThreadView
        messages={[
          msg({ id: "u1", role: "user", text: "hi bot" }),
          msg({ id: "b1", role: "bot", text: "hi human" }),
        ]}
        renderBotAvatar={() => <span data-testid="avatar">o.o</span>}
      />,
    );
    const userRow = container.querySelector('[data-message-id="u1"]');
    const botRow = container.querySelector('[data-message-id="b1"]');
    expect(userRow).toHaveAttribute("data-message-role", "user");
    expect(userRow?.className).toContain("justify-end");
    expect(botRow).toHaveAttribute("data-message-role", "bot");
    expect(botRow?.className).toContain("justify-start");
    // Direct threads show no avatar next to bubbles — the header identifies
    // the bot (docs/design/visual-style.md).
    expect(container.querySelector('[data-testid="avatar"]')).toBeNull();
    expect(screen.getByText("hi bot")).toBeInTheDocument();
    expect(screen.getByText("hi human")).toBeInTheDocument();
  });

  it("passes the author botId and caption size to renderBotAvatar in group threads", () => {
    const renderBotAvatar = vi.fn((botId: string, size: number) => (
      <span data-testid="avatar">{`${botId}@${size}`}</span>
    ));
    render(
      <ThreadView
        thread={groupThread}
        messages={[
          msg({ id: "b1", role: "bot", threadId: "g1", authorBotId: "bot-2", text: "hi" }),
        ]}
        renderBotAvatar={renderBotAvatar}
      />,
    );
    expect(renderBotAvatar).toHaveBeenCalledWith("bot-2", 20);
    expect(screen.getByTestId("avatar")).toHaveTextContent("bot-2@20");
  });

  it("defaults the caption author to the thread's first participant", () => {
    const renderBotAvatar = vi.fn(() => <span data-testid="avatar" />);
    render(
      <ThreadView
        thread={groupThread}
        messages={[msg({ id: "b1", role: "bot", threadId: "g1", text: "hi" })]}
        renderBotAvatar={renderBotAvatar}
      />,
    );
    expect(renderBotAvatar).toHaveBeenCalledWith("bot-1", 20);
  });

  it("clusters consecutive same-author messages with one tail and shows a timestamp separator", () => {
    render(
      <ThreadView
        messages={[
          msg({ id: "u1", role: "user", text: "one", createdAt: 1000 }),
          msg({ id: "u2", role: "user", text: "two", createdAt: 2000 }),
          msg({ id: "b1", role: "bot", text: "three", createdAt: 3000 }),
        ]}
      />,
    );
    // One separator at the top of the thread (createdAt gaps are small).
    expect(screen.getAllByTestId("timestamp-separator")).toHaveLength(1);
    // Only the last bubble of the user cluster gets the tail corner.
    const bubble = (text: string) =>
      screen.getByText(text).closest('[class*="rounded-2xl"]')!;
    expect(bubble("one").className).not.toContain("rounded-br-[6px]");
    expect(bubble("two").className).toContain("rounded-br-[6px]");
    expect(bubble("three").className).toContain("rounded-bl-[6px]");
  });

  it("shows author names on bot messages in group threads", () => {
    render(
      <ThreadView
        thread={groupThread}
        botNames={{ "bot-1": "Research Bot", "bot-2": "Sales Bot" }}
        messages={[
          msg({ id: "u1", role: "user", threadId: "g1", text: "go" }),
          msg({ id: "b1", role: "bot", threadId: "g1", authorBotId: "bot-1", text: "scored" }),
          msg({ id: "b2", role: "bot", threadId: "g1", authorBotId: "bot-2", text: "drafted" }),
        ]}
      />,
    );
    const authors = screen.getAllByTestId("message-author");
    expect(authors.map((a) => a.textContent)).toEqual(["Research Bot", "Sales Bot"]);
  });

  it("falls back to the bot id when no name is known for a group author", () => {
    render(
      <ThreadView
        thread={groupThread}
        messages={[msg({ id: "b1", role: "bot", threadId: "g1", authorBotId: "bot-9", text: "hi" })]}
      />,
    );
    expect(screen.getByTestId("message-author")).toHaveTextContent("bot-9");
  });

  it("renders delegation messages as cards and badges report messages", () => {
    render(
      <ThreadView
        thread={groupThread}
        botNames={{ "bot-1": "EA", "bot-2": "Sales Bot" }}
        messages={[
          msg({
            id: "d1",
            role: "bot",
            threadId: "g1",
            authorBotId: "bot-1",
            text: "Please draft outreach",
            meta: { kind: "delegation", targetBotId: "bot-2", status: "in-progress" },
          }),
          msg({
            id: "r1",
            role: "bot",
            threadId: "g1",
            authorBotId: "bot-2",
            text: "Drafts ready",
            meta: { kind: "report" },
          }),
          msg({
            id: "n1",
            role: "bot",
            threadId: "g1",
            authorBotId: "bot-1",
            text: "All done",
          }),
        ]}
      />,
    );
    // The delegation renders as an inline card with target + live status.
    const card = screen.getByTestId("delegation-card");
    expect(card).toHaveAttribute("data-status", "in-progress");
    expect(card).toHaveTextContent("asked Sales Bot");
    expect(card).toHaveTextContent("Please draft outreach");
    expect(screen.getByTestId("delegation-status")).toHaveTextContent("in progress");
    // Report messages keep their badge.
    const badges = screen.getAllByTestId("message-meta");
    expect(badges.map((b) => b.textContent)).toEqual(["Report"]);
    expect(badges[0]).toHaveAttribute("data-meta-kind", "report");
  });

  it("expands a delegation card to the full brief and report (multi-bot spec)", async () => {
    const user = userEvent.setup();
    const renderBotAvatar = vi.fn((botId: string, size: number) => (
      <span data-testid="card-avatar">{`${botId}@${size}`}</span>
    ));
    render(
      <ThreadView
        thread={directThread}
        botNames={{ "bot-1": "EA", "bot-2": "Scout" }}
        renderBotAvatar={renderBotAvatar}
        messages={[
          msg({
            id: "d1",
            role: "bot",
            threadId: "bot-1",
            authorBotId: "bot-1",
            text: "Research the account",
            meta: {
              kind: "delegation",
              targetBotId: "bot-2",
              status: "done",
              brief: "Research the account and list buying signals.",
              report: "Found 3 buying signals.",
            },
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("delegation-detail")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Delegation to Scout: done/ }),
    );
    const detail = screen.getByTestId("delegation-detail");
    expect(detail).toHaveTextContent("Research the account and list buying signals.");
    expect(detail).toHaveTextContent("Found 3 buying signals.");
    // The card's avatar is the TARGET bot's.
    expect(renderBotAvatar).toHaveBeenCalledWith("bot-2", 24);
  });

  // F3 regression: an interrupted delegation card (persisted in-progress,
  // normalized on load) shows the interrupted state with a Retry affordance.
  it("renders interrupted delegation cards with a Retry affordance", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ThreadView
        thread={directThread}
        botNames={{ "bot-1": "EA", "bot-2": "Scout" }}
        onRetry={onRetry}
        messages={[
          msg({
            id: "d1",
            role: "bot",
            threadId: "bot-1",
            authorBotId: "bot-1",
            text: "Research the account",
            meta: {
              kind: "delegation",
              targetBotId: "bot-2",
              status: "interrupted",
              brief: "Research the account.",
            },
          }),
        ]}
      />,
    );
    const card = screen.getByTestId("delegation-card");
    expect(card).toHaveAttribute("data-status", "interrupted");
    expect(screen.getByTestId("delegation-status")).toHaveTextContent("interrupted");
    const notice = screen.getByTestId("delegation-interrupted");
    expect(notice).toHaveTextContent(/app restarted before Scout reported back/);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("d1");
  });

  it("marks instance runs with a copy badge on delegation cards and reports", () => {
    render(
      <ThreadView
        thread={groupThread}
        botNames={{ "bot-1": "EA", "bot-2": "Scout" }}
        messages={[
          msg({
            id: "d1",
            role: "bot",
            threadId: "g1",
            authorBotId: "bot-1",
            text: "Go",
            meta: {
              kind: "delegation",
              targetBotId: "bot-2",
              status: "in-progress",
              instance: true,
              instanceId: "inst-1",
            },
          }),
          msg({
            id: "r1",
            role: "bot",
            threadId: "g1",
            authorBotId: "bot-2",
            text: "Done",
            meta: { kind: "report", instance: true },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("instance-badge")).toBeInTheDocument();
    // The report's author label carries the copy marker ("Scout · copy").
    const authors = screen.getAllByTestId("message-author");
    expect(authors.some((a) => a.textContent === "Scout · copy")).toBe(true);
  });

  it("does not show author names in direct threads", () => {
    render(
      <ThreadView
        thread={directThread}
        botNames={{ "bot-1": "Research Bot" }}
        messages={[msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "hi" })]}
      />,
    );
    expect(screen.queryByTestId("message-author")).toBeNull();
  });

  it("renders bot text as markdown but user text as plain text", () => {
    const { container } = render(
      <ThreadView
        messages={[
          msg({ id: "u1", role: "user", text: "**not bold**" }),
          msg({ id: "b1", role: "bot", text: "**bold**" }),
        ]}
      />,
    );
    const strongs = container.querySelectorAll("strong");
    expect(strongs).toHaveLength(1);
    expect(strongs[0]).toHaveTextContent("bold");
    expect(screen.getByText("**not bold**")).toBeInTheDocument();
  });

  it("shows a streaming indicator on streaming messages only", () => {
    render(
      <ThreadView
        messages={[
          msg({ id: "b1", role: "bot", text: "done", streaming: false }),
          msg({ id: "b2", role: "bot", text: "typing", status: "pending", streaming: true }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("streaming-indicator")).toHaveLength(1);
  });

  it("shows a pending state for outgoing user messages", () => {
    render(<ThreadView messages={[msg({ status: "pending" })]} />);
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  it("shows an error state with a working retry button", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ThreadView messages={[msg({ id: "u9", status: "error" })]} onRetry={onRetry} />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("u9");
  });

  it("does not show retry for delivered messages", () => {
    render(<ThreadView messages={[msg({ status: "delivered" })]} onRetry={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders session lifecycle events as subtle indicators, not bubbles (agent-computer spec)", () => {
    render(
      <ThreadView
        messages={[
          msg({
            id: "s1",
            role: "bot",
            authorBotId: "bot-1",
            text: "Compute session provisioned (local)",
            meta: { kind: "session", sessionEvent: "provisioned", sessionKind: "local" },
          }),
        ]}
        thread={directThread}
      />,
    );
    const event = screen.getByTestId("session-event");
    expect(event).toHaveAttribute("data-session-event", "provisioned");
    expect(event).toHaveTextContent("Compute session provisioned (local)");
    // Not rendered as a normal bot message: no avatar slot.
    expect(screen.queryByTestId("bot-avatar-slot")).toBeNull();
  });

  it("renders a routine run as a card with its outcome behind a toggle", async () => {
    const user = userEvent.setup();
    render(
      <ThreadView
        messages={[
          msg({
            id: "r1",
            role: "bot",
            authorBotId: "bot-1",
            text: 'Running "Morning briefing"',
            meta: {
              kind: "routine-run",
              status: "done",
              routineName: "Morning briefing",
              invokedBy: "schedule",
              report: "Checked the tracker: 2 new errors.",
            },
          }),
        ]}
        thread={directThread}
      />,
    );
    const card = screen.getByTestId("routine-card");
    expect(card).toHaveAttribute("data-status", "done");
    expect(card).toHaveTextContent("Morning briefing");
    // Why it ran is visible without expanding; the report is not.
    expect(card).toHaveTextContent("on schedule");
    expect(screen.queryByTestId("routine-detail")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Routine Morning briefing/ }));
    expect(screen.getByTestId("routine-detail")).toHaveTextContent("2 new errors");
  });

  it("shows the failure reason on a failed routine run", async () => {
    const user = userEvent.setup();
    render(
      <ThreadView
        messages={[
          msg({
            id: "r2",
            role: "bot",
            authorBotId: "bot-1",
            text: 'Running "Nightly sync"',
            meta: {
              kind: "routine-run",
              status: "failed",
              routineName: "Nightly sync",
              invokedBy: "schedule",
              error: "the host was unreachable",
            },
          }),
        ]}
        thread={directThread}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Routine Nightly sync/ }));
    expect(screen.getByTestId("routine-detail")).toHaveTextContent("host was unreachable");
  });

  it("renders sync-back warnings in the timeline (actionable, unlike commands)", () => {
    render(
      <ThreadView
        messages={[
          msg({
            id: "s2",
            role: "bot",
            authorBotId: "bot-1",
            text: "Warning: sync-back skipped 1 file: notes.md (permission denied)",
            meta: {
              kind: "session",
              sessionEvent: "sync-warning",
              sessionKind: "host",
            },
          }),
        ]}
        thread={directThread}
      />,
    );
    const event = screen.getByTestId("session-event");
    expect(event).toHaveAttribute("data-session-event", "sync-warning");
    expect(event).toHaveTextContent("notes.md (permission denied)");
  });

  describe("choice chips (messaging spec, 'Structured choice prompts')", () => {
    it("renders live chips as real buttons and reports the selection", async () => {
      const user = userEvent.setup();
      const onChoiceSelect = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onChoiceSelect={onChoiceSelect}
          messages={[
            msg({
              id: "b1",
              role: "bot",
              text: "How should I handle replies?",
              choices: { options: ["Auto-reply", "Draft only", "Ignore"] },
            }),
          ]}
        />,
      );
      const group = screen.getByRole("group", { name: "Choices" });
      expect(group).toHaveAttribute("data-answered", "false");
      await user.click(screen.getByRole("button", { name: /Draft only/ }));
      expect(onChoiceSelect).toHaveBeenCalledWith("b1", "Draft only");
      // All three option rows plus the inline own-answer submit button.
      expect(screen.getAllByRole("button")).toHaveLength(4);
    });

    it("posts an inline own answer through the same path as a click", async () => {
      const user = userEvent.setup();
      const onChoiceSelect = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onChoiceSelect={onChoiceSelect}
          messages={[
            msg({
              id: "b1",
              role: "bot",
              text: "How should I handle replies?",
              choices: { options: ["Auto-reply", "Ignore"] },
            }),
          ]}
        />,
      );
      const field = screen.getByLabelText("Type your own answer");
      await user.type(field, "Only reply to my boss");
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onChoiceSelect).toHaveBeenCalledWith("b1", "Only reply to my boss");
      // Whitespace-only answers never send.
      expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    });

    it("shows the prompt when it differs from the message text", () => {
      render(
        <ThreadView
          messages={[
            msg({
              id: "b1",
              role: "bot",
              text: "Long analysis…",
              choices: { prompt: "Which option?", options: ["A", "B"] },
            }),
          ]}
        />,
      );
      expect(screen.getByTestId("choice-prompt")).toHaveTextContent("Which option?");
    });

    it("collapses answered blocks to a receipt: chosen answer only, options gone", () => {
      render(
        <ThreadView
          messages={[
            msg({
              id: "b1",
              role: "bot",
              text: "Pick",
              choices: {
                prompt: "Where should updates go?",
                options: ["Email", "Slack"],
                answeredWith: "Slack",
              },
            }),
          ]}
        />,
      );
      const group = screen.getByTestId("choice-chips");
      expect(group).toHaveAttribute("data-answered", "true");
      // Receipt: the prompt and the chosen answer with a check — no buttons,
      // no unchosen options, no own-answer field (messaging spec, "Receipt
      // after answering").
      const receipt = screen.getByTestId("choice-receipt");
      expect(receipt).toHaveTextContent("Slack");
      expect(screen.getByTestId("choice-prompt")).toHaveTextContent(
        "Where should updates go?",
      );
      expect(screen.queryByText("Email")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Email|Slack/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Type your own answer")).not.toBeInTheDocument();
    });

    it("never renders chips on user messages", () => {
      render(
        <ThreadView
          messages={[
            msg({ id: "u1", role: "user", text: "hi", choices: { options: ["A"] } }),
          ]}
        />,
      );
      expect(screen.queryByTestId("choice-chips")).toBeNull();
    });
  });

  describe("inline draft actions (messaging spec, 'Inline draft actions')", () => {
    function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
      return {
        id: "a1",
        botId: "bot-1",
        threadId: "bot-1",
        toolName: "send_email",
        args: { to: "lead@example.com", subject: "Hi", body: "Draft body text" },
        summary: "Send an email to lead@example.com",
        createdAt: 1,
        ...overrides,
      };
    }

    it("renders approve/edit/discard on the requesting bot's latest message and approves through the shared resolver", async () => {
      const user = userEvent.setup();
      const onResolveApproval = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onResolveApproval={onResolveApproval}
          pendingApprovals={[approval()]}
          messages={[
            msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "First reply", createdAt: 1 }),
            msg({ id: "b2", role: "bot", authorBotId: "bot-1", text: "Here's the draft.", createdAt: 2 }),
          ]}
        />,
      );
      // Exactly one action row, attached to the LATEST message from the bot.
      const rows = screen.getAllByTestId("draft-actions");
      expect(rows).toHaveLength(1);
      expect(
        rows[0].closest('[data-message-id="b2"]'),
      ).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Approve" }));
      expect(onResolveApproval).toHaveBeenCalledWith("a1", "allow");
    });

    it("discard denies through the same resolver", async () => {
      const user = userEvent.setup();
      const onResolveApproval = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onResolveApproval={onResolveApproval}
          pendingApprovals={[approval()]}
          messages={[msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "Draft." })]}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Discard" }));
      expect(onResolveApproval).toHaveBeenCalledWith(
        "a1",
        "deny",
        expect.stringMatching(/discard/i),
      );
    });

    it("edit opens the draft prefilled and sends the revision through the same resolver", async () => {
      const user = userEvent.setup();
      const onResolveApproval = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onResolveApproval={onResolveApproval}
          pendingApprovals={[approval()]}
          messages={[msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "Draft." })]}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const editor = screen.getByRole("textbox", { name: "Edit draft" });
      expect(editor).toHaveValue("Draft body text");
      await user.clear(editor);
      await user.type(editor, "Better body");
      await user.click(screen.getByRole("button", { name: "Send revision" }));
      expect(onResolveApproval).toHaveBeenCalledWith(
        "a1",
        "deny",
        expect.stringContaining("Better body"),
      );
    });

    it("cancel closes the editor without resolving", async () => {
      const user = userEvent.setup();
      const onResolveApproval = vi.fn();
      render(
        <ThreadView
          thread={directThread}
          onResolveApproval={onResolveApproval}
          pendingApprovals={[approval()]}
          messages={[msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "Draft." })]}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("textbox", { name: "Edit draft" })).toBeNull();
      expect(onResolveApproval).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    });

    it("renders no draft actions when the thread has no message from the requesting bot", () => {
      render(
        <ThreadView
          thread={directThread}
          pendingApprovals={[approval({ botId: "bot-9" })]}
          messages={[msg({ id: "b1", role: "bot", authorBotId: "bot-1", text: "Hi" })]}
        />,
      );
      expect(screen.queryByTestId("draft-actions")).toBeNull();
    });
  });
});
