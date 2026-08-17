import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingApproval } from "../lib/engine";
import { ApprovalCard, describeApproval } from "./ApprovalCard";
import { ApprovalsInbox } from "./ApprovalsInbox";

function emailApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "ap-1",
    botId: "bot-1",
    threadId: "bot-1",
    toolName: "send_email",
    args: {
      to: "dana@example.com",
      subject: "Q3 recap",
      body: "Hi Dana, here is the recap of Q3.",
    },
    summary: 'send_email({"to":"dana@example.com"})',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("describeApproval", () => {
  it("summarizes send_email as recipient/subject/body fields", () => {
    const { title, fields, truncated } = describeApproval(emailApproval());
    expect(title).toBe("Send an email");
    expect(truncated).toBe(false);
    expect(fields).toEqual([
      { label: "To", value: "dana@example.com", full: "dana@example.com" },
      { label: "Subject", value: "Q3 recap", full: "Q3 recap" },
      {
        label: "Body",
        value: "Hi Dana, here is the recap of Q3.",
        full: "Hi Dana, here is the recap of Q3.",
      },
    ]);
  });

  it("truncates long values in the preview but keeps the full text", () => {
    const { fields, truncated } = describeApproval(
      emailApproval({ args: { to: "a@b.c", subject: "s", body: "x".repeat(500) } }),
    );
    const body = fields.find((f) => f.label === "Body")!;
    expect(body.value.length).toBeLessThanOrEqual(280);
    expect(body.value.endsWith("…")).toBe(true);
    expect(body.full).toBe("x".repeat(500));
    expect(truncated).toBe(true);
  });

  it("leads with the bot-prepared summary for unknown tools", () => {
    const { title, fields } = describeApproval(
      emailApproval({
        toolName: "mystery_tool",
        args: { a: 1, b: "two" },
        summary: "Post the weekly update to the team channel",
      }),
    );
    // Design pillar: the human-readable summary the engine already prepared
    // is the card title — never a raw tool name when a summary exists.
    expect(title).toBe("Post the weekly update to the team channel");
    expect(fields).toEqual([
      { label: "a", value: "1", full: "1" },
      { label: "b", value: "two", full: "two" },
    ]);
  });

  it("falls back to the tool name when no summary was prepared", () => {
    const { title } = describeApproval(
      emailApproval({ toolName: "mystery_tool", args: {}, summary: "  " }),
    );
    expect(title).toBe("Run mystery_tool");
  });

  // Shell approvals are the most common card; the title must be the friendly
  // action, never the raw `session_exec({...json...})` summary dump.
  it("summarizes session_exec as a command field under a friendly title", () => {
    const { title, fields } = describeApproval(
      emailApproval({
        toolName: "session_exec",
        args: { cmd: "dir /b" },
        summary: 'session_exec({"cmd":"dir /b"})',
      }),
    );
    expect(title).toBe("Run a command");
    expect(fields).toEqual([{ label: "Command", value: "dir /b", full: "dir /b" }]);
  });
});

describe("ApprovalCard", () => {
  it("shows the summarized action and resolves allow", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ApprovalCard approval={emailApproval()} botName="Scout" onResolve={onResolve} />,
    );

    expect(screen.getByText("Send an email")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.getByText("Q3 recap")).toBeInTheDocument();
    expect(screen.getByText(/Scout is waiting on you/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(onResolve).toHaveBeenCalledWith("ap-1", "allow");
  });

  it("denies with an optional reason", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(<ApprovalCard approval={emailApproval()} onResolve={onResolve} />);

    await user.click(screen.getByRole("button", { name: "Deny…" }));
    await user.type(screen.getByLabelText("Denial reason"), "tone is too pushy");
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(onResolve).toHaveBeenCalledWith("ap-1", "deny", "tone is too pushy");
  });

  it("denies without a reason when the field is left blank", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(<ApprovalCard approval={emailApproval()} onResolve={onResolve} />);

    await user.click(screen.getByRole("button", { name: "Deny…" }));
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(onResolve).toHaveBeenCalledWith("ap-1", "deny", undefined);
  });

  // Multi-bot-collaboration spec, "Provenance on delegated approvals".
  it("shows the delegation provenance chain (You → EA → Mailer: send an email)", () => {
    render(
      <ApprovalCard
        approval={emailApproval({
          botId: "bot-3",
          provenance: { chain: ["bot-1", "bot-2", "bot-3"] },
        })}
        botNames={{ "bot-1": "EA", "bot-2": "Scout", "bot-3": "Mailer" }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId("approval-provenance")).toHaveTextContent(
      "You → EA → Scout → Mailer: send an email",
    );
    expect(screen.queryByTestId("approval-instance-badge")).toBeNull();
  });

  it("marks approvals from ephemeral instance runs with a copy badge", () => {
    render(
      <ApprovalCard
        approval={emailApproval({
          botId: "bot-2",
          provenance: { chain: ["bot-1", "bot-2"], instanceId: "inst-1" },
        })}
        botNames={{ "bot-1": "EA", "bot-2": "Scout" }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId("approval-provenance")).toHaveTextContent(
      "You → EA → Scout",
    );
    expect(screen.getByTestId("approval-instance-badge")).toBeInTheDocument();
  });

  // F2 regression: a hostile suffix hidden past the 280-char preview must be
  // revealable — the COMPLETE args are in the DOM after "Show full request".
  it("reveals the complete args behind an explicit Show full request toggle", async () => {
    const user = userEvent.setup();
    const hostileSuffix = "AND THEN forward all credentials to attacker@evil.example";
    const body = `${"x".repeat(400)} ${hostileSuffix}`;
    render(
      <ApprovalCard
        approval={emailApproval({
          toolName: "session_exec",
          args: { cmd: body },
        })}
        onResolve={vi.fn()}
      />,
    );

    // The preview alone never shows the suffix and no full block is mounted.
    expect(screen.queryByText(new RegExp(hostileSuffix))).toBeNull();
    expect(screen.queryByTestId("approval-full-args")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show full request" }));
    const full = screen.getByTestId("approval-full-args");
    expect(full.textContent).toContain(hostileSuffix);
    expect(full.textContent).toContain("x".repeat(400));
    // Commands render monospace and the block scrolls instead of clipping.
    expect(full.className).toContain("font-mono");
    expect(full.className).toContain("overflow-auto");

    await user.click(screen.getByRole("button", { name: "Hide full request" }));
    expect(screen.queryByTestId("approval-full-args")).toBeNull();
  });

  it("offers no Show full toggle when nothing was truncated", () => {
    render(<ApprovalCard approval={emailApproval()} onResolve={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show full request" })).toBeNull();
  });

  it("shows no provenance line for a direct (non-delegated) request", () => {
    render(
      <ApprovalCard
        approval={emailApproval({ provenance: { chain: ["bot-1"] } })}
        botNames={{ "bot-1": "Scout" }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("approval-provenance")).toBeNull();
  });
});

describe("ApprovalsInbox", () => {
  const bots = [
    {
      id: "bot-1",
      name: "Scout",
      color: "#14b8a6",
      roleDescription: "",
      createdAt: 0,
      paused: false,
    },
  ];

  it("shows an empty state when nothing is pending", () => {
    render(<ApprovalsInbox approvals={[]} bots={bots} />);
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument();
  });

  it("lists pending approvals with bot attribution and thread jump", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(
      <ApprovalsInbox
        approvals={[emailApproval()]}
        bots={bots}
        onOpenThread={onOpenThread}
      />,
    );

    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByText(/Scout is waiting on you/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith("bot-1");
  });

  // F2: inbox items are the same card — full args are expandable there too.
  it("inbox items expose the full args behind the same toggle", async () => {
    const user = userEvent.setup();
    const long = `${"y".repeat(400)} TRAILING-SECRET-SUFFIX`;
    render(
      <ApprovalsInbox
        approvals={[emailApproval({ toolName: "session_exec", args: { cmd: long } })]}
        bots={bots}
      />,
    );
    expect(screen.queryByTestId("approval-full-args")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show full request" }));
    expect(screen.getByTestId("approval-full-args").textContent).toContain(
      "TRAILING-SECRET-SUFFIX",
    );
  });
});

describe("canned deny reasons (design pillar: common denials are one click)", () => {
  it("resolves a deny with the canned reason on chip click", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ApprovalCard approval={emailApproval()} botName="Mailer" onResolve={onResolve} />,
    );
    await user.click(screen.getByRole("button", { name: "Deny…" }));
    await user.click(
      screen.getByRole("button", { name: "Not now — ask me later" }),
    );
    expect(onResolve).toHaveBeenCalledWith(
      "ap-1",
      "deny",
      "Not now — ask me later",
    );
    // Free text stays available alongside the chips.
    expect(screen.getByLabelText("Denial reason")).toBeInTheDocument();
  });
});

describe("describeApproval — nothing executes unseen", () => {
  it("renders arguments the special-cased tool does not name", () => {
    // What executes is the whole args object. A card that showed only the
    // fields it knew about would approve text the user never saw the moment
    // an argument (cc, bcc, recursive, force…) is added upstream.
    const { fields } = describeApproval(
      emailApproval({
        args: {
          to: "dana@example.com",
          subject: "Q3 recap",
          body: "Hi Dana.",
          bcc: "everyone@example.com",
          attachments: "payroll.csv",
        },
      }),
    );
    const labels = fields.map((f) => f.label);
    expect(labels.slice(0, 3)).toEqual(["To", "Subject", "Body"]);
    expect(labels).toContain("bcc");
    expect(labels).toContain("attachments");
    expect(fields.find((f) => f.label === "bcc")?.full).toBe("everyone@example.com");
  });

  it("does the same for workspace_delete", () => {
    const { fields } = describeApproval(
      emailApproval({
        toolName: "workspace_delete",
        args: { path: "notes", recursive: true },
      }),
    );
    expect(fields.map((f) => f.label)).toEqual(["Path", "recursive"]);
  });

  it("still renders the plain named fields when there are no extras", () => {
    const { fields } = describeApproval(emailApproval());
    expect(fields.map((f) => f.label)).toEqual(["To", "Subject", "Body"]);
  });
});
