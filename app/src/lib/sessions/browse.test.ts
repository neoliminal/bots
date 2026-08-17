import { describe, expect, it } from "vitest";
import {
  BROWSE_TOOL_NAMES,
  clearBrowsingState,
  createBrowseTools,
  formatBrowseResponse,
} from "./browse";
import { HostSessionProvider, type HostExecFn } from "./host";
import { SessionManager } from "./store";
import type { ToolContext } from "../engine/tools";

const OK = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
  durationMs: 1,
};

const ctx = { bot: { id: "b1" }, threadId: "t1" } as unknown as ToolContext;

/** Host-provider stack whose ssh transport answers browse invocations. */
function stack(
  respond: (request: Record<string, unknown>) => unknown,
  transport: Partial<typeof OK> = {},
) {
  const requests: Record<string, unknown>[] = [];
  const exec: HostExecFn = async (_target, cmd) => {
    if (cmd.includes("browse.mjs")) {
      const b64 = /browse\.mjs '([A-Za-z0-9+/=]+)'/.exec(cmd)![1];
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const request = JSON.parse(new TextDecoder().decode(bytes));
      requests.push(request);
      return {
        ...OK,
        stdout: `${JSON.stringify(respond(request))}\n`,
        ...transport,
      };
    }
    // provision/mkdir etc.
    return { ...OK, stdout: "ready\n" };
  };
  const provider = new HostSessionProvider("john@minipc.local", { exec });
  const manager = new SessionManager(provider);
  const tools = createBrowseTools({ provider, manager });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { requests, tools, tool, provider };
}

describe("tool surface", () => {
  it("exposes exactly the four DOM-driven tools with spec categories", () => {
    const { tools } = stack(() => ({ ok: true }));
    expect(tools.map((t) => t.name)).toEqual([...BROWSE_TOOL_NAMES]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.category]));
    // goto/read are external-read, NOT plain read: navigating a logged-in
    // browser acts on arrival (confirm/unsubscribe links are GETs) and the
    // URL is an egress channel. click/fill stay external-comms, and both
    // additionally classify per call onto the credential/payment floors.
    expect(byName.browse_goto).toBe("external-read");
    expect(byName.browse_read).toBe("external-read");
    expect(byName.browse_click).toBe("external-comms");
    expect(byName.browse_fill).toBe("external-comms");
  });

  it("steers the model away from credentials in the tool descriptions", () => {
    const { tool } = stack(() => ({ ok: true }));
    expect(tool("browse_goto").description).toMatch(/never attempt to enter credentials/i);
    expect(tool("browse_fill").description).toMatch(/NEVER use this for.*passwords/is);
  });
});

describe("request encoding and responses", () => {
  it("goto sends the url and reports the resulting page", async () => {
    const { requests, tool } = stack(() => ({
      ok: true,
      url: "https://example.com/",
      title: "Example",
    }));
    const result = await tool("browse_goto").run(
      { url: "https://example.com" },
      ctx,
    );
    expect(requests[0]).toEqual({ action: "goto", url: "https://example.com" });
    expect(result).toBe('Now at https://example.com/ — "Example"');
  });

  it("read renders text and interactive elements", async () => {
    const { tool } = stack(() => ({
      ok: true,
      url: "https://example.com/",
      title: "Example",
      text: "Welcome to the page",
      elements: [{ role: "link", name: "Sign out" }],
    }));
    const result = await tool("browse_read").run({}, ctx);
    expect(result).toContain("Page text:\nWelcome to the page");
    expect(result).toContain("Interactive elements:\n  - link: Sign out");
  });

  it("click passes role/name/nth through", async () => {
    const { requests, tool } = stack(() => ({ ok: true, url: "u", title: "t" }));
    await tool("browse_click").run({ role: "button", name: "Save", nth: 1 }, ctx);
    expect(requests[0]).toEqual({
      action: "click",
      role: "button",
      name: "Save",
      nth: 1,
    });
  });

  it("miss returns an error listing candidates, never a blind click", async () => {
    const { tool } = stack(() => ({
      ok: false,
      error: 'no button named "Sav" found',
      candidates: [{ role: "button", name: "Save" }],
    }));
    const result = await tool("browse_click").run(
      { role: "button", name: "Sav" },
      ctx,
    );
    expect(result).toContain('Error: no button named "Sav" found');
    expect(result).toContain("  - button: Save");
  });
});

describe("failure modes", () => {
  it("reports runner timeouts plainly", async () => {
    const { tool } = stack(() => ({ ok: true }), { timedOut: true });
    expect(await tool("browse_read").run({}, ctx)).toMatch(/timed out on the host/);
  });

  it("reports unreachable hosts as tool errors (fail plain, per spec)", async () => {
    const exec: HostExecFn = async () => ({
      ...OK,
      exitCode: 255,
      stderr: "Connection refused",
    });
    const provider = new HostSessionProvider("john@minipc.local", { exec });
    const manager = new SessionManager(provider);
    const tools = createBrowseTools({ provider, manager });
    const result = await tools[0].run({ url: "https://x.example" }, ctx);
    expect(result).toMatch(/^Error: .*unreachable over ssh/);
  });

  it("reports unparseable runner output without throwing", async () => {
    const { tool } = stack(() => ({ ok: true }), { stdout: "not json" });
    expect(await tool("browse_read").run({}, ctx)).toMatch(/unparseable output/);
  });
});

describe("formatBrowseResponse", () => {
  it("handles the no-text page", () => {
    expect(formatBrowseResponse("read", { ok: true, url: "u", title: "" }))
      .toContain("(page has no readable text)");
  });
});

describe("credential and payment enforcement (not just prose)", () => {
  it("classifies password and one-time-code fills onto the credential floor", () => {
    const fill = stack(() => ({ ok: true })).tools.find((t) => t.name === "browse_fill");
    expect(fill?.classify?.({ label: "Password", value: "x" })).toBe("credential");
    expect(fill?.classify?.({ label: "One-time code", value: "123456" })).toBe(
      "credential",
    );
    expect(fill?.classify?.({ label: "Search", value: "boots" })).toBeUndefined();
  });

  it("classifies card details onto the payment floor", () => {
    const fill = stack(() => ({ ok: true })).tools.find((t) => t.name === "browse_fill");
    expect(fill?.classify?.({ label: "Card number", value: "x" })).toBe("payment");
    expect(fill?.classify?.({ label: "CVV", value: "123" })).toBe("payment");
    // Even when the label gives nothing away.
    expect(fill?.classify?.({ label: "Reference", value: "4111111111111111" })).toBe(
      "payment",
    );
  });

  it("classifies a payment confirmation click onto the payment floor", () => {
    const click = stack(() => ({ ok: true })).tools.find((t) => t.name === "browse_click");
    expect(click?.classify?.({ role: "button", name: "Pay now" })).toBe("payment");
    expect(click?.classify?.({ role: "button", name: "Place order" })).toBe("payment");
    expect(click?.classify?.({ role: "link", name: "Back to basket" })).toBeUndefined();
  });

  it("marks page content as untrusted", () => {
    const byName = Object.fromEntries(
      stack(() => ({ ok: true })).tools.map((t) => [t.name, t]),
    );
    expect(byName.browse_read?.untrustedOutput).toBe(true);
    expect(byName.browse_goto?.untrustedOutput).toBe(true);
  });
});

describe("clearBrowsingState (user-initiated sign-out)", () => {
  it("sends the clear action the daemon has always implemented", async () => {
    // The daemon supported `clear` and the README promised it, but nothing
    // in the app ever sent it — leaving no supported way to revoke the
    // shared logged-in profile every bot browses with.
    const { requests, provider } = stack(() => ({ ok: true, cleared: 12 }));
    const message = await clearBrowsingState(provider, "user-maintenance");
    expect(requests).toContainEqual({ action: "clear" });
    expect(message).toBeTruthy();
  });

  it("can clear a single site", async () => {
    const { requests, provider } = stack(() => ({ ok: true, cleared: 3 }));
    await clearBrowsingState(provider, "user-maintenance", "github.com");
    expect(requests).toContainEqual({ action: "clear", site: "github.com" });
  });

  it("surfaces a failure instead of reporting success", async () => {
    const { provider } = stack(() => ({ ok: false, error: "profile locked" }));
    await expect(
      clearBrowsingState(provider, "user-maintenance"),
    ).rejects.toThrow("profile locked");
  });
});
