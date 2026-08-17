import { describe, expect, it } from "vitest";
import { decide, ToolRegistry, type Bot, type ToolContext } from "../lib/engine";
import { appToolRegistry, registerAppTools } from "./tools";

const makeBot = (): Bot => ({
  id: "bot-1",
  name: "Scout",
  color: "#14b8a6",
  roleDescription: "Research",
  createdAt: 0,
  paused: false,
});

const ctx: ToolContext = {
  bot: makeBot(),
  threadId: "bot-1",
};

describe("app tool registry", () => {
  it("registers the full tool set", () => {
    const names = appToolRegistry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "workspace_list",
        "workspace_read",
        "workspace_write",
        "workspace_delete",
        "web_fetch",
        "send_email",
        "remember_memory",
        "forget_memory",
      ]),
    );
  });

  it("gates only the sensitive tools (send_email, workspace_delete) via categories", () => {
    const approveGated = appToolRegistry
      .list()
      .filter((t) => decide(makeBot(), t) === "approve")
      .map((t) => t.name)
      .sort();
    expect(approveGated).toEqual(["send_email", "workspace_delete"]);
    expect(appToolRegistry.get("workspace_delete")?.category).toBe("bulk-delete");
    expect(appToolRegistry.get("send_email")?.category).toBe("external-comms");
  });

  it("gives every tool a model-facing description with usage guidance", () => {
    for (const tool of appToolRegistry.list()) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("send_email pretends to send and reports success without a real send", async () => {
    const tool = appToolRegistry.get("send_email")!;
    const result = await tool.run(
      { to: "dana@example.com", subject: "Q3 recap", body: "Hi Dana" },
      ctx,
    );
    expect(result).toContain("dana@example.com");
    expect(result).toContain("Q3 recap");
    expect(result).toContain("no real email");
  });

  it("send_email requires a recipient", async () => {
    const tool = appToolRegistry.get("send_email")!;
    await expect(
      Promise.resolve(tool.run({ subject: "x", body: "y" }, ctx)),
    ).resolves.toMatch(/^Error:/);
  });

  it("workspace tools degrade gracefully outside Tauri", async () => {
    await expect(appToolRegistry.get("workspace_list")!.run({}, ctx)).resolves.toBe(
      "Workspace is empty.",
    );
    await expect(
      appToolRegistry.get("workspace_read")!.run({ path: "notes.md" }, ctx),
    ).resolves.toContain("notes.md");
    await expect(
      appToolRegistry.get("workspace_write")!.run({ path: "a.md", content: "hi" }, ctx),
    ).resolves.toContain("a.md");
    await expect(
      appToolRegistry.get("workspace_delete")!.run({ path: "a.md" }, ctx),
    ).resolves.toContain("a.md");
  });

  it("workspace path arguments are required", async () => {
    await expect(
      appToolRegistry.get("workspace_read")!.run({}, ctx),
    ).resolves.toMatch(/^Error:/);
    await expect(
      appToolRegistry.get("workspace_write")!.run({ content: "x" }, ctx),
    ).resolves.toMatch(/^Error:/);
    await expect(
      appToolRegistry.get("workspace_delete")!.run({}, ctx),
    ).resolves.toMatch(/^Error:/);
  });

  it("web_fetch rejects non-https URLs and reports unavailability outside Tauri", async () => {
    const tool = appToolRegistry.get("web_fetch")!;
    await expect(tool.run({ url: "http://example.com" }, ctx)).resolves.toMatch(
      /^Error: web_fetch only supports/,
    );
    await expect(tool.run({ url: "https://example.com" }, ctx)).resolves.toContain(
      "unavailable outside the desktop app",
    );
  });

  it("registerAppTools is idempotent on a fresh registry", () => {
    const registry = new ToolRegistry();
    registerAppTools(registry);
    const count = registry.list().length;
    registerAppTools(registry);
    expect(registry.list().length).toBe(count);
  });
});

describe("tool categories after the security review", () => {
  it("treats a web fetch as egress, not a plain read", () => {
    // A fetch carries whatever the bot put in the URL, so it is the
    // exfiltration leg of any harvest chain. external-read runs freely in a
    // clean run and needs approval once untrusted content is in context.
    const registry = new ToolRegistry();
    registerAppTools(registry);
    expect(registry.get("web_fetch")?.category).toBe("external-read");
    expect(registry.get("web_fetch")?.untrustedOutput).toBe(true);
    // Local reads stay ungated and untainted-by-default.
    expect(registry.get("workspace_list")?.category).toBe("read");
    expect(registry.get("workspace_read")?.category).toBe("read");
    // File contents are still third-party data.
    expect(registry.get("workspace_read")?.untrustedOutput).toBe(true);
  });

  it("classifies a write under skills/ as self-modify", () => {
    const registry = new ToolRegistry();
    registerAppTools(registry);
    const write = registry.get("workspace_write");
    expect(write?.category).toBe("workspace-mutate");
    expect(write?.classify?.({ path: "notes/plan.md" })).toBeUndefined();
    expect(write?.classify?.({ path: "skills/helper/SKILL.md" })).toBe("self-modify");
    // Near-misses land on the safe side of the boundary.
    expect(write?.classify?.({ path: "./Skills/x/SKILL.md" })).toBe("self-modify");
    expect(write?.classify?.({ path: "skills" })).toBe("self-modify");
    expect(write?.classify?.({ path: "skillsets/notes.md" })).toBeUndefined();
  });
});
