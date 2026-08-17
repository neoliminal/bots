// Glue between MCP servers (Rust host, src-tauri/src/mcp.rs) and the app
// tool registry: wraps each remote tool as an EngineTool named
// mcp__<server>__<tool>, persists server configs, and reconnects them at
// bootstrap. Spec: openspec/specs/tool-extensibility/spec.md ("MCP server
// integration"); design D4 (adapter), D6 (CLI-first steering line).
//
// Containment: a failed call returns an error result (never throws) and
// marks the server unhealthy — its tools' available() probes then hide
// them from every bot until a reconnect succeeds.

import {
  classifyConnectorTool,
  recordGrant,
  revokeGrantsForServer,
  type EngineTool,
  type ToolRegistry,
} from "../lib/engine";
import {
  mcpCall,
  mcpConnect,
  mcpDisconnect,
  type McpToolInfo,
} from "../lib/native";
import { createLocalStorage, type KeyValueStorage } from "../lib/storage";
import { appToolRegistry } from "./tools";

/** Storage key holding the registered MCP server configs. */
export const MCP_SERVERS_KEY = "mcp.servers";

/** Provider tool-name budget (design D6 risk note). */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Steering line prefixed to every MCP tool description (task 4.2 / D6). */
export const MCP_CLI_STEERING =
  "Prefer an equivalent CLI in your compute session if one exists. ";

/** What it takes to (re)connect a server. Env VALUES never appear here —
 * envKeys names keys/.env entries resolved on the Rust side. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  /**
   * Integration/service this server authorizes (multi-account support:
   * "slack" for both the "slack" and "slack-work" servers). Defaults to the
   * server name.
   */
  integration?: string;
  /** User-visible account label for the grant ("default" when omitted). */
  accountLabel?: string;
}

/** Server row for the settings UI. */
export interface McpServerView extends McpServerConfig {
  healthy: boolean;
  toolNames: string[];
}

let registry: ToolRegistry = appToolRegistry;
let storage: KeyValueStorage = createLocalStorage();
let configs: McpServerConfig[] = [];
const health = new Map<string, boolean>();
const registeredTools = new Map<string, string[]>();
let initialized = false;

function djb2Hex(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Namespaced registry name for a remote tool, clamped to the provider name
 * budget: over-long names keep a distinguishing hash suffix.
 */
export function mcpToolName(server: string, tool: string): string {
  const full = `mcp__${server}__${tool}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  const hash = djb2Hex(full);
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function makeEngineTool(server: string, tool: McpToolInfo): EngineTool {
  return {
    name: mcpToolName(server, tool.name),
    description:
      MCP_CLI_STEERING +
      (tool.description !== "" ? tool.description : `${tool.name} on ${server} (MCP)`),
    parameters: tool.inputSchema,
    // External effect by default; per-server reclassification is a design
    // open question deferred until a real need appears.
    category: "external-comms",
    // A payments or vault connector must land on the hard floor, which a
    // user CAN otherwise loosen for "external-comms" as a whole. The server
    // supplies only the tool's name — the platform, never the server,
    // decides what that name means, so a connector cannot opt itself out.
    classify: () => classifyConnectorTool(tool.name),
    // Server responses are third-party text.
    untrustedOutput: true,
    available: () => health.get(server) !== false,
    run: async (args) => {
      try {
        return await mcpCall(server, tool.name, args);
      } catch (error) {
        // Contained failure: error result, server marked unhealthy so its
        // tools hide from the next request build.
        health.set(server, false);
        const message = error instanceof Error ? error.message : String(error);
        return `Error: MCP tool ${tool.name} on ${server} failed: ${message}`;
      }
    },
  };
}

function unregisterServerTools(server: string): void {
  for (const name of registeredTools.get(server) ?? []) {
    registry.unregister(name);
  }
  registeredTools.delete(server);
}

function registerServerTools(server: string, tools: McpToolInfo[]): void {
  unregisterServerTools(server);
  const names: string[] = [];
  for (const tool of tools) {
    const engineTool = makeEngineTool(server, tool);
    registry.register(engineTool);
    names.push(engineTool.name);
  }
  registeredTools.set(server, names);
}

async function persist(): Promise<void> {
  await storage.set(MCP_SERVERS_KEY, configs);
}

/**
 * Validate an MCP server name for registration. "__" is reserved as the
 * namespace separator in mcp__<server>__<tool>: a name containing it would
 * make grant coverage ambiguous (server "a__b" vs server "a" + tool "b__…"),
 * letting one integration's grant unlock another's tools.
 */
export function validateMcpServerName(name: string): string | null {
  if (name === "") return "A server name is required.";
  if (name.includes("__")) {
    return 'Server names may not contain "__" (reserved as the tool-name separator).';
  }
  return null;
}

/**
 * Connect a server (user-initiated from settings only), register its tools,
 * and persist the config for bootstrap reconnects.
 */
export async function connectMcpServer(config: McpServerConfig): Promise<McpServerView> {
  const nameError = validateMcpServerName(config.name);
  if (nameError !== null) throw new Error(nameError);
  const tools = await mcpConnect(config.name, config.command, config.args, config.envKeys);
  health.set(config.name, true);
  registerServerTools(config.name, tools);
  configs = [...configs.filter((c) => c.name !== config.name), config];
  await persist();
  // Successful USER-INITIATED authorization event: record the account-scoped
  // grant so the run loop offers this integration's tools to every bot
  // (tool-extensibility spec, "Account-scoped connector authorization").
  // The grant is keyed (integration, accountLabel) and carries the server
  // name so a second account of the same integration is independently
  // addressable and revocable ("Multiple accounts per integration").
  const integration = config.integration?.trim() || config.name;
  await recordGrant(integration, config.accountLabel, undefined, config.name);
  return {
    ...config,
    healthy: true,
    toolNames: registeredTools.get(config.name) ?? [],
  };
}

/**
 * Reconnect an unavailable server from its persisted config — one click,
 * nothing re-typed (design pillar). User-initiated from settings, so the
 * grant re-record inside connectMcpServer is a legitimate authorization.
 */
export async function reconnectMcpServer(name: string): Promise<McpServerView> {
  const config = configs.find((c) => c.name === name);
  if (config === undefined) {
    throw new Error(`no stored configuration for MCP server "${name}"`);
  }
  return connectMcpServer(config);
}

/**
 * Disconnect a server, drop its tools, forget its config, AND revoke the
 * grants covering it — a removed server must not leave a live authorization
 * behind that a later reconnect would silently reuse.
 */
export async function removeMcpServer(name: string): Promise<void> {
  await mcpDisconnect(name).catch(() => {
    // Disconnect is best-effort; forgetting the config is what matters.
  });
  unregisterServerTools(name);
  health.delete(name);
  configs = configs.filter((c) => c.name !== name);
  await persist();
  await revokeGrantsForServer(name);
}

/** Registered servers for the settings UI (config + live health). */
export function listMcpServers(): McpServerView[] {
  return configs.map((c) => ({
    ...c,
    healthy: health.get(c.name) !== false,
    toolNames: registeredTools.get(c.name) ?? [],
  }));
}

/**
 * Bootstrap: reconnect every persisted server, best-effort. A server that
 * fails to connect keeps its config but is marked unhealthy (its tools stay
 * unregistered/hidden until the user retries from settings).
 */
export async function initMcp(options?: {
  registry?: ToolRegistry;
  storage?: KeyValueStorage;
}): Promise<void> {
  if (options?.registry) registry = options.registry;
  if (options?.storage) storage = options.storage;
  if (initialized) return;
  initialized = true;
  configs = (await storage.get<McpServerConfig[]>(MCP_SERVERS_KEY)) ?? [];
  await Promise.all(
    configs.map(async (config) => {
      // A persisted name containing "__" (predating validation) would make
      // its tool names parse as another server's — fail closed: keep the
      // config visible in settings but never connect or register its tools.
      if (validateMcpServerName(config.name) !== null) {
        health.set(config.name, false);
        return;
      }
      try {
        const tools = await mcpConnect(
          config.name,
          config.command,
          config.args,
          config.envKeys,
        );
        health.set(config.name, true);
        registerServerTools(config.name, tools);
        // Deliberately NO recordGrant here: bootstrap cannot distinguish
        // "never granted" from "explicitly revoked", and re-recording would
        // resurrect revoked grants on every launch. The grants store is the
        // persisted source of truth — a reconnected server whose grant was
        // revoked keeps its tools registered but the run loop never offers
        // them until the user re-authorizes from settings (connectMcpServer).
      } catch {
        health.set(config.name, false);
      }
    }),
  );
}

/** Test helper: drop all MCP glue state (does not disconnect servers). */
export function resetMcpForTest(): void {
  for (const server of [...registeredTools.keys()]) unregisterServerTools(server);
  health.clear();
  configs = [];
  initialized = false;
  registry = appToolRegistry;
  storage = createLocalStorage();
}
