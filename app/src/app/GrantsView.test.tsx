// Grants view tests (tool-extensibility spec: single grants view listing
// every active authorization — service, date, which bots may use it;
// independent per-account revocation).
import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createGrantsStore,
  createMemoryStorage,
  ToolRegistry,
  useBotsStore,
  type Bot,
} from "../lib/engine";
import { GrantsView } from "./GrantsView";

function makeStore() {
  return createGrantsStore(createMemoryStorage());
}

function makeBot(overrides: Partial<Bot> & { id: string; name: string }): Bot {
  return {
    color: "#123",
    roleDescription: "r",
    createdAt: 0,
    paused: false,
    ...overrides,
  };
}

afterEach(() => {
  useBotsStore.setState({ bots: [], hydrated: true });
});

describe("GrantsView", () => {
  it("shows an empty state when nothing is authorized", () => {
    render(<GrantsView grants={makeStore()} />);
    expect(screen.getByText("No connectors authorized yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connector authorizations" })).toBeNull();
  });

  it("lists every grant with integration, account label, and granted date", () => {
    const store = makeStore();
    store.record("slack");
    store.record("slack", "work");
    store.record("calendar");

    render(<GrantsView grants={store} />);

    const list = screen.getByRole("list", { name: "Connector authorizations" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);

    // Multi-account integration: one row per account label.
    expect(within(list).getAllByText("slack")).toHaveLength(2);
    expect(within(list).getByText("work")).toBeTruthy();
    expect(within(list).getByText("calendar")).toBeTruthy();

    const year = new Date().getFullYear().toString();
    for (const item of items) {
      expect(within(item).getByText(new RegExp(`^Granted .*${year}`))).toBeTruthy();
    }
  });

  it("revokes only the clicked account and keeps the sibling grant (independent revocation)", async () => {
    const user = userEvent.setup();
    const store = makeStore();
    store.record("slack");
    store.record("slack", "work");

    render(<GrantsView grants={store} />);
    await user.click(screen.getByRole("button", { name: "Revoke slack (work)" }));

    // The store lost exactly the "work" account…
    expect(store.isGranted("slack", "work")).toBe(false);
    expect(store.isGranted("slack", "default")).toBe(true);

    // …and the view re-rendered from the subscription.
    expect(screen.queryByRole("button", { name: "Revoke slack (work)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke slack (default)" })).toBeTruthy();
  });

  it("lists which bots may use each grant (visibility + policy pipeline)", () => {
    const store = makeStore();
    store.record("calendar");
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp__calendar__create_event",
      description: "create an event",
      parameters: { type: "object", properties: {} },
      category: "external-comms",
      run: () => "ok",
    });
    useBotsStore.setState({
      bots: [
        makeBot({ id: "b1", name: "Scout" }),
        makeBot({
          id: "b2",
          name: "Clerk",
          toolPolicy: { categories: { "external-comms": "deny" } },
        }),
      ],
      hydrated: true,
    });

    render(<GrantsView grants={store} registry={registry} />);
    // Scout's default policy allows the tools; Clerk's denies them.
    expect(screen.getByText("Usable by: Scout")).toBeTruthy();
  });

  it("notes when a grant's server has no connected tools to probe", () => {
    const store = makeStore();
    store.record("calendar");
    render(<GrantsView grants={store} registry={new ToolRegistry()} />);
    expect(screen.getByText(/server not connected/)).toBeTruthy();
  });

  it("updates live when a grant is recorded elsewhere (authorization event)", () => {
    const store = makeStore();
    render(<GrantsView grants={store} />);
    expect(screen.getByText("No connectors authorized yet.")).toBeTruthy();

    // Simulates the auth flow calling recordGrant on the shared store.
    act(() => {
      store.record("calendar");
    });

    expect(screen.getByText("calendar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke calendar (default)" })).toBeTruthy();
  });
});
