// MCP glue tests (tool-extensibility spec: "MCP server integration" —
// namespacing, containment, health-driven visibility; task 4.2 steering).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage as createEngineMemoryStorage,
  getGrantsStore,
  resetGrantsStore,
  ToolRegistry,
  type Bot,
} from "../lib/engine";
import { createMemoryStorage } from "../lib/storage";
import {
  connectMcpServer,
  initMcp,
  listMcpServers,
  MCP_CLI_STEERING,
  MCP_SERVERS_KEY,
  mcpToolName,
  MAX_TOOL_NAME_LENGTH,
  reconnectMcpServer,
  removeMcpServer,
  resetMcpForTest,
} from "./mcpGlue";
import { mcpCall, mcpConnect, mcpDisconnect } from "../lib/native";

vi.mock("../lib/native", () => ({
  mcpConnect: vi.fn(),
  mcpCall: vi.fn(),
  mcpDisconnect: vi.fn(async () => {}),
  mcpServers: vi.fn(async () => []),
}));

const mockedConnect = vi.mocked(mcpConnect);
const mockedCall = vi.mocked(mcpCall);
const mockedDisconnect = vi.mocked(mcpDisconnect);

const ECHO_TOOL = {
  name: "echo",
  description: "Echo text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function makeBot(): Bot {
  return {
    id: "bot-1",
    name: "Scout",
    color: "#123",
    roleDescription: "r",
    createdAt: 0,
    paused: false,
  };
}

function storageWith(value?: unknown) {
  const storage = createMemoryStorage();
  if (value !== undefined) void storage.set(MCP_SERVERS_KEY, value);
  return storage;
}

afterEach(() => {
  resetMcpForTest();
  resetGrantsStore();
  vi.clearAllMocks();
});

describe("mcpToolName", () => {
  it("namespaces as mcp__<server>__<tool>", () => {
    expect(mcpToolName("helpdesk", "create_ticket")).toBe("mcp__helpdesk__create_ticket");
  });

  it("clamps names over the provider budget, keeping a distinguishing suffix", () => {
    const long = mcpToolName("very-long-server-name-here", "a".repeat(80));
    const long2 = mcpToolName("very-long-server-name-here", "a".repeat(80) + "b");
    expect(long.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(long2.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(long).not.toBe(long2);
    expect(long.startsWith("mcp__very-long-server-name-here__")).toBe(true);
  });
});

describe("connectMcpServer", () => {
  it("registers namespaced tools with the CLI steering prefix and external-comms category", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    const registry = new ToolRegistry();
    await initMcp({ registry, storage: storageWith() });
    await connectMcpServer({ name: "helpdesk", command: "hd", args: [], envKeys: [] });

    const tool = registry.get("mcp__helpdesk__echo");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("external-comms");
    expect(tool?.description.startsWith(MCP_CLI_STEERING)).toBe(true);
    expect(tool?.description).toContain("Echo text back");
    expect(tool?.parameters).toEqual(ECHO_TOOL.inputSchema);
    // Healthy server: visible to a default bot.
    expect(registry.listFor(makeBot()).map((t) => t.name)).toContain("mcp__helpdesk__echo");
  });

  it("persists the config (names of env keys only) for bootstrap reconnects", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    const storage = storageWith();
    await initMcp({ registry: new ToolRegistry(), storage });
    await connectMcpServer({
      name: "helpdesk",
      command: "hd",
      args: ["--stdio"],
      envKeys: ["HELPDESK_API_KEY"],
    });
    expect(await storage.get(MCP_SERVERS_KEY)).toEqual([
      { name: "helpdesk", command: "hd", args: ["--stdio"], envKeys: ["HELPDESK_API_KEY"] },
    ]);
  });
});

describe("grant recording (tool-extensibility: account-scoped authorization)", () => {
  it("records an account-scoped grant when a server connects (auth success event)", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    resetGrantsStore();
    const grants = getGrantsStore(createEngineMemoryStorage());
    expect(grants.isGranted("helpdesk")).toBe(false);

    await initMcp({ registry: new ToolRegistry(), storage: storageWith() });
    await connectMcpServer({ name: "helpdesk", command: "hd", args: [], envKeys: [] });

    expect(grants.isGranted("helpdesk")).toBe(true);
    expect(grants.coversTool("mcp__helpdesk__echo")).toBe(true);
  });

  it("bootstrap reconnect NEVER records grants — a revoked grant stays revoked across restarts", async () => {
    resetGrantsStore();
    const grants = getGrantsStore(createEngineMemoryStorage());
    mockedConnect.mockResolvedValue([ECHO_TOOL]);

    // Session 1: user authorizes slack from settings, then revokes it in the
    // grants view. The server config stays persisted.
    const storage = storageWith();
    await initMcp({ registry: new ToolRegistry(), storage });
    await connectMcpServer({ name: "slack", command: "sl", args: [], envKeys: [] });
    expect(grants.isGranted("slack")).toBe(true);
    grants.revoke("slack");
    expect(grants.isGranted("slack")).toBe(false);

    // Session 2 (app relaunch): bootstrap reconnects the persisted server —
    // the tools re-register, but the grant must NOT resurrect.
    resetMcpForTest();
    const registry = new ToolRegistry();
    await initMcp({ registry, storage });
    expect(registry.get("mcp__slack__echo")).toBeDefined();
    expect(grants.isGranted("slack")).toBe(false);
    expect(grants.coversTool("mcp__slack__echo")).toBe(false);
  });

  it("records one grant per account: a second server of the same integration gets its own label", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    resetGrantsStore();
    const grants = getGrantsStore(createEngineMemoryStorage());
    await initMcp({ registry: new ToolRegistry(), storage: storageWith() });

    await connectMcpServer({ name: "slack", command: "sl", args: [], envKeys: [] });
    await connectMcpServer({
      name: "slack-work",
      command: "sl",
      args: [],
      envKeys: [],
      integration: "slack",
      accountLabel: "work",
    });

    expect(grants.labelsFor("slack")).toEqual(["default", "work"]);
    // Each grant covers exactly its own server's tool namespace.
    expect(grants.grantForTool?.("mcp__slack__echo")?.accountLabel).toBe("default");
    expect(grants.grantForTool?.("mcp__slack-work__echo")?.accountLabel).toBe("work");

    // Independent revocation: revoking "work" leaves "default" functioning.
    grants.revoke("slack", "work");
    expect(grants.coversTool("mcp__slack-work__echo")).toBe(false);
    expect(grants.coversTool("mcp__slack__echo")).toBe(true);
  });

  it("rejects server names containing the reserved __ separator", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    await initMcp({ registry: new ToolRegistry(), storage: storageWith() });
    await expect(
      connectMcpServer({ name: "a__b", command: "x", args: [], envKeys: [] }),
    ).rejects.toThrow(/__/);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("bootstrap never connects a persisted server whose name breaks the namespace", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    const registry = new ToolRegistry();
    await initMcp({
      registry,
      // Legacy config predating name validation: its tools would parse as
      // server "a"'s, so a grant for "a" would cover them. Fail closed.
      storage: storageWith([{ name: "a__b", command: "x", args: [], envKeys: [] }]),
    });
    expect(mockedConnect).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(listMcpServers()[0]?.healthy).toBe(false);
  });
});

describe("tool calls", () => {
  it("returns the server's text result", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    mockedCall.mockResolvedValue("echo: hi");
    const registry = new ToolRegistry();
    await initMcp({ registry, storage: storageWith() });
    await connectMcpServer({ name: "helpdesk", command: "hd", args: [], envKeys: [] });

    const tool = registry.get("mcp__helpdesk__echo")!;
    const result = await tool.run({ text: "hi" }, { bot: makeBot(), threadId: "t" });
    expect(result).toBe("echo: hi");
    expect(mockedCall).toHaveBeenCalledWith("helpdesk", "echo", { text: "hi" });
  });

  it("contains failures: error result (never throws) and hides the server's tools", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    mockedCall.mockRejectedValue(new Error("server crashed"));
    const registry = new ToolRegistry();
    await initMcp({ registry, storage: storageWith() });
    await connectMcpServer({ name: "helpdesk", command: "hd", args: [], envKeys: [] });

    const tool = registry.get("mcp__helpdesk__echo")!;
    const result = await tool.run({ text: "hi" }, { bot: makeBot(), threadId: "t" });
    expect(result).toContain("Error:");
    expect(result).toContain("server crashed");
    // Unhealthy server: its tools disappear from every bot's visible list.
    expect(registry.listFor(makeBot()).map((t) => t.name)).not.toContain(
      "mcp__helpdesk__echo",
    );
    expect(listMcpServers()[0]?.healthy).toBe(false);
  });
});

describe("initMcp bootstrap reconnect", () => {
  it("reconnects persisted servers and registers their tools", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    const registry = new ToolRegistry();
    await initMcp({
      registry,
      storage: storageWith([{ name: "helpdesk", command: "hd", args: [], envKeys: [] }]),
    });
    expect(mockedConnect).toHaveBeenCalledWith("helpdesk", "hd", [], []);
    expect(registry.get("mcp__helpdesk__echo")).toBeDefined();
  });

  it("keeps a failing server's config but marks it unhealthy with no tools", async () => {
    mockedConnect.mockRejectedValue(new Error("spawn failed"));
    const registry = new ToolRegistry();
    await initMcp({
      registry,
      storage: storageWith([{ name: "helpdesk", command: "hd", args: [], envKeys: [] }]),
    });
    expect(registry.get("mcp__helpdesk__echo")).toBeUndefined();
    const [server] = listMcpServers();
    expect(server?.healthy).toBe(false);
    expect(server?.toolNames).toEqual([]);
  });
});

describe("removeMcpServer", () => {
  it("disconnects, unregisters tools, forgets the config, and revokes the grant", async () => {
    mockedConnect.mockResolvedValue([ECHO_TOOL]);
    resetGrantsStore();
    const grants = getGrantsStore(createEngineMemoryStorage());
    const storage = storageWith();
    const registry = new ToolRegistry();
    await initMcp({ registry, storage });
    await connectMcpServer({ name: "helpdesk", command: "hd", args: [], envKeys: [] });
    expect(grants.isGranted("helpdesk")).toBe(true);

    await removeMcpServer("helpdesk");
    expect(mockedDisconnect).toHaveBeenCalledWith("helpdesk");
    expect(registry.get("mcp__helpdesk__echo")).toBeUndefined();
    expect(listMcpServers()).toEqual([]);
    expect(await storage.get(MCP_SERVERS_KEY)).toEqual([]);
    // No orphaned authorization survives the removal.
    expect(grants.isGranted("helpdesk")).toBe(false);
  });
});

describe("reconnectMcpServer (design pillar: one click, nothing re-typed)", () => {
  it("reconnects from the persisted config", async () => {
    mockedConnect.mockResolvedValue([
      { name: "echo", description: "", inputSchema: { type: "object" } },
    ]);
    await connectMcpServer({ name: "helpdesk", command: "npx", args: ["hd"], envKeys: [] });
    mockedConnect.mockClear();
    mockedConnect.mockResolvedValue([
      { name: "echo", description: "", inputSchema: { type: "object" } },
    ]);
    const view = await reconnectMcpServer("helpdesk");
    expect(view.healthy).toBe(true);
    // Reused the STORED config — same command/args, no user re-entry.
    expect(mockedConnect).toHaveBeenCalledWith("helpdesk", "npx", ["hd"], []);
  });

  it("throws plainly when no config is stored", async () => {
    await expect(reconnectMcpServer("ghost")).rejects.toThrow(/no stored configuration/);
  });
});
