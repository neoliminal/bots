import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock only hostDiscover (network mDNS browse) — everything else in the
// native layer keeps its real outside-Tauri no-op behavior.
const hostDiscoverMock = vi.fn<() => Promise<string[]>>(async () => []);
vi.mock("../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native")>()),
  hostDiscover: () => hostDiscoverMock(),
}));
import { ToolRegistry } from "../lib/engine";
import { createMemoryStorage } from "../lib/storage";
import {
  getSessionProviderKind,
  initSessions,
  resetSessionsForTest,
} from "./sessionGlue";
import { SessionSettings } from "./SessionSettings";

// Agent-computer spec: provider selection lives in Settings — local is the
// default; Fly shows its unconfigured state with keys/.env instructions
// (outside Tauri the fly status probe reports "unconfigured").
describe("SessionSettings", () => {
  beforeEach(async () => {
    resetSessionsForTest();
    await initSessions({
      registry: new ToolRegistry(),
      storage: createMemoryStorage(),
    });
  });

  afterEach(() => {
    resetSessionsForTest();
  });

  it("offers local (default, selected) and Fly providers", async () => {
    render(<SessionSettings onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    const local = screen.getByRole("radio", { name: "Local (this computer)" });
    const fly = screen.getByRole("radio", { name: "Fly Machines (cloud)" });
    expect((local as HTMLInputElement).checked).toBe(true);
    expect((fly as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("shows the Fly unconfigured state with keys/.env instructions", async () => {
    render(<SessionSettings onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("fly-status").textContent).toBe(
        "not configured",
      );
    });
    const instructions = screen.getByTestId("fly-instructions");
    expect(instructions.textContent).toContain("FLY_API_TOKEN");
    expect(instructions.textContent).toContain("keys/.env");
  });

  it("selecting Fly switches the active session provider", async () => {
    const user = userEvent.setup();
    render(<SessionSettings onClose={() => {}} />);

    await user.click(screen.getByRole("radio", { name: "Fly Machines (cloud)" }));
    await waitFor(() => {
      expect(getSessionProviderKind()).toBe("fly");
    });
    expect(
      (screen.getByRole("radio", { name: "Fly Machines (cloud)" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});

describe("personal-host discovery (agent-computer spec delta)", () => {
  beforeEach(async () => {
    resetSessionsForTest();
    hostDiscoverMock.mockReset();
    hostDiscoverMock.mockResolvedValue([]);
    await initSessions({
      registry: new ToolRegistry(),
      storage: createMemoryStorage(),
    });
  });

  afterEach(() => {
    resetSessionsForTest();
  });

  it("offers discovered hosts as one-click choices that prefill the target", async () => {
    hostDiscoverMock.mockResolvedValue(["nucboxg3.local", "studio.local"]);
    const user = userEvent.setup();
    render(<SessionSettings onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Scan network" }));
    const candidates = await screen.findAllByTestId("discovered-host");
    expect(candidates.map((c) => c.textContent)).toEqual([
      "nucboxg3.local",
      "studio.local",
    ]);

    await user.click(candidates[0]);
    const field = screen.getByLabelText(
      "Personal host SSH target",
    ) as HTMLInputElement;
    // No target typed yet: a placeholder user is prefilled, still editable.
    expect(field.value).toBe("user@nucboxg3.local");
  });

  it("keeps the typed user when a discovered host is chosen", async () => {
    hostDiscoverMock.mockResolvedValue(["nucboxg3.local"]);
    const user = userEvent.setup();
    render(<SessionSettings onClose={() => {}} />);

    const field = screen.getByLabelText("Personal host SSH target");
    await user.type(field, "neo@oldhost.local");
    await user.click(screen.getByRole("button", { name: "Scan network" }));
    await user.click(await screen.findByTestId("discovered-host"));
    expect((field as HTMLInputElement).value).toBe("neo@nucboxg3.local");
  });

  it("says so plainly when nothing advertises", async () => {
    hostDiscoverMock.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<SessionSettings onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Scan network" }));
    expect(
      await screen.findByText(/No SSH services found/),
    ).toBeInTheDocument();
  });
});
