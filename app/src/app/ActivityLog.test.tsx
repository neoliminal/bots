import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityLog } from "./ActivityLog";
import { createAuditStore, useBotsStore, type AuditStore } from "../lib/engine";
import { createMemoryStorage } from "../lib/storage";
import { saveTextFile } from "../lib/native";

vi.mock("../lib/native", () => ({
  saveTextFile: vi.fn(async () => "/Users/x/Downloads/bots-activity-log.txt"),
}));

/** A store seeded with a small, ordered history. */
function seeded(): AuditStore {
  const store = createAuditStore(createMemoryStorage());
  const record = store.getState().record;
  record({
    kind: "tool.allowed",
    botId: "b1",
    botName: "Scout",
    toolName: "session_exec",
    summary: "session_exec(cmd: ls -la)",
    at: 1_000,
  });
  record({
    kind: "tool.approved",
    botId: "b2",
    botName: "EA",
    toolName: "send_email",
    summary: "send_email(to: dana@example.com)",
    at: 2_000,
  });
  record({
    kind: "tool.refused",
    botId: "b1",
    botName: "Scout",
    toolName: "delete_all",
    summary: "delete_all(path: /)",
    detail: "bulk-delete is a hard floor",
    at: 3_000,
  });
  store.setState({ hydrated: true });
  return store;
}

describe("ActivityLog (security spec, 'Comprehensive audit log')", () => {
  beforeEach(() => {
    useBotsStore.setState({ bots: [], hydrated: true });
    vi.mocked(saveTextFile).mockClear();
  });

  it("lists every call newest first, including ones that needed no approval", () => {
    render(<ActivityLog store={seeded()} />);
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("delete_all");
    expect(rows[2]).toHaveTextContent("ls -la");
    // The autonomous call is present and labeled as such.
    expect(rows[2]).toHaveAttribute("data-kind", "tool.allowed");
    expect(rows[2]).toHaveTextContent("Ran on its own");
  });

  it("distinguishes approved, declined and blocked at a glance", () => {
    render(<ActivityLog store={seeded()} />);
    expect(screen.getByText("You approved")).toBeInTheDocument();
    expect(screen.getByText("Blocked by policy")).toBeInTheDocument();
  });

  it("filters to one bot in a click", async () => {
    const user = userEvent.setup();
    render(<ActivityLog store={seeded()} />);
    await user.click(screen.getByRole("button", { name: "EA" }));
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("send_email");

    await user.click(screen.getByRole("button", { name: "All bots" }));
    expect(screen.getAllByTestId("activity-row")).toHaveLength(3);
  });

  it("only offers bots that actually appear in the log", () => {
    render(<ActivityLog store={seeded()} />);
    const filters = screen.getByRole("group", { name: "Filter by bot" });
    expect(within(filters).getByRole("button", { name: "Scout" })).toBeInTheDocument();
    expect(within(filters).queryByRole("button", { name: "Ghost" })).toBeNull();
  });

  it("shows the delegation chain so 'who told it to' is answerable", () => {
    const store = createAuditStore(createMemoryStorage());
    store.getState().record({
      kind: "tool.allowed",
      botId: "b2",
      botName: "Scout",
      chain: ["EA", "Scout"],
      summary: "session_exec(cmd: pytest)",
      at: 1_000,
    });
    store.setState({ hydrated: true });
    render(<ActivityLog store={store} />);
    expect(screen.getByTestId("activity-row")).toHaveTextContent("EA → Scout");
  });

  it("exports the filtered view as text", async () => {
    const user = userEvent.setup();
    render(<ActivityLog store={seeded()} />);
    await user.click(screen.getByRole("button", { name: "EA" }));
    await user.click(screen.getByRole("button", { name: "Export as text" }));
    expect(saveTextFile).toHaveBeenCalledTimes(1);
    const [fileName, contents] = vi.mocked(saveTextFile).mock.calls[0];
    expect(fileName).toBe("bots-activity-log.txt");
    expect(contents).toContain("send_email");
    expect(contents).not.toContain("ls -la");
    expect(await screen.findByText(/Saved to/)).toBeInTheDocument();
  });

  it("states how many entries it is keeping, so a trimmed log is not mistaken for a full one", () => {
    render(<ActivityLog store={seeded()} />);
    expect(screen.getByText("3 entries kept.")).toBeInTheDocument();
  });

  it("has an empty state that does not look broken", () => {
    const store = createAuditStore(createMemoryStorage());
    store.setState({ hydrated: true });
    render(<ActivityLog store={store} />);
    expect(screen.getByTestId("activity-empty")).toHaveTextContent(
      "Nothing yet",
    );
    expect(screen.getByRole("button", { name: "Export as text" })).toBeDisabled();
  });
});
