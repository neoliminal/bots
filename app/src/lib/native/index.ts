// Typed bindings to the Tauri native layer: per-bot workspace filesystem,
// web_fetch, notifications, tray (menu bar extra), and dock badge.
//
// Every function degrades to a safe no-op when the app is not running inside
// Tauri (vitest / Playwright browser runs), detected via __TAURI_INTERNALS__.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** One entry in a bot's workspace listing (path is workspace-relative). */
export interface WorkspaceEntry {
  path: string;
  isDir: boolean;
  size: number;
}

/** Result of the narrow GET-only https fetch performed by the Rust side. */
export interface WebFetchResult {
  status: number;
  contentType: string;
  text: string;
}

/** One line in the tray menu; `title` is preformatted, e.g. "Scout — running". */
export interface TrayBotItem {
  id: string;
  title: string;
}

/** Event emitted when "Pause All Bots" is clicked in the tray menu. */
export const TRAY_PAUSE_ALL_EVENT = "tray://pause-all";
/** Event emitted when "Open Bots" is clicked in the tray menu. */
export const TRAY_OPEN_EVENT = "tray://open";

/** True when running inside a Tauri webview (native commands available). */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
  );
}

/** Recursively list a bot's workspace. Outside Tauri: resolves to []. */
export async function workspaceList(botId: string): Promise<WorkspaceEntry[]> {
  return (await workspaceListDetailed(botId)).entries;
}

/**
 * Workspace listing with the truncation flag. The Rust walker stops at a
 * depth/entry cap (a deep or wide tree used to exhaust the stack and crash
 * the app), so callers that show the listing must say when it is partial
 * rather than implying the workspace is small.
 */
export async function workspaceListDetailed(
  botId: string,
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  if (!isTauri()) return { entries: [], truncated: false };
  return invoke<{ entries: WorkspaceEntry[]; truncated: boolean }>("workspace_list", {
    botId,
  });
}

/** Read a UTF-8 file (max 5MB) from a bot's workspace. Outside Tauri: "". */
export async function workspaceRead(
  botId: string,
  relPath: string,
): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("workspace_read", { botId, relPath });
}

/** Write a file (max 5MB) into a bot's workspace, creating parent dirs. */
export async function workspaceWrite(
  botId: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("workspace_write", { botId, relPath, content });
}

/** Delete a file or directory (recursively) from a bot's workspace. */
export async function workspaceDelete(
  botId: string,
  relPath: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("workspace_delete", { botId, relPath });
}

/**
 * GET an https URL through the Rust SSRF-guarded fetcher (10s timeout, 1MB
 * cap, max 3 redirects, HTML stripped to text).
 * Outside Tauri: resolves to { status: 0, contentType: "", text: "" }.
 */
export async function webFetch(url: string): Promise<WebFetchResult> {
  if (!isTauri()) return { status: 0, contentType: "", text: "" };
  return invoke<WebFetchResult>("web_fetch", { url });
}

/**
 * Show a native notification, requesting permission on first use.
 * Resolves true when the notification was dispatched, false when permission
 * was denied or the app is not running inside Tauri.
 */
export async function notify(title: string, body: string): Promise<boolean> {
  if (!isTauri()) return false;
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  if (!granted) return false;
  sendNotification({ title, body });
  return true;
}

/** Replace the tray menu's per-bot status lines. */
export async function trayUpdate(items: TrayBotItem[]): Promise<void> {
  if (!isTauri()) return;
  await invoke("tray_update", { items });
}

/** Set the dock badge count (macOS; best-effort elsewhere); null clears it. */
export async function setBadgeCount(count: number | null): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_badge_count", { count });
}

/**
 * Save UTF-8 text into the user's Downloads folder via the Rust host
 * (WKWebView ignores anchor `download` clicks, so in-app file exports must
 * go native). Never overwrites — an existing name gets a numbered suffix.
 * Resolves to the absolute path written, or null outside Tauri (callers
 * fall back to a browser download).
 */
export async function saveTextFile(
  fileName: string,
  contents: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("save_text_file", { fileName, contents });
}

// ---------------------------------------------------------------------------
// Compute sessions (agent-computer spec): local sandboxed exec + Fly Machines.
// ---------------------------------------------------------------------------

/** Result of a local session command (session_local_exec). */
export interface LocalExecResult {
  /** Exit code, or null when the process was killed (timeout/output cap). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when combined output hit the 256KB cap (process was killed). */
  truncated: boolean;
  /** True when the timeout (default 30s, max 300s) expired. */
  timedOut: boolean;
  durationMs: number;
}

/** Result of provisioning a Fly session machine. */
export interface FlyProvisionResult {
  /** The Fly machine id, used as the session id. */
  sessionId: string;
  state: string;
}

/** Result of a Fly session command. */
export interface FlyExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const UNAVAILABLE_EXEC: LocalExecResult = {
  exitCode: null,
  stdout: "",
  stderr: "compute sessions are unavailable outside the desktop app",
  truncated: false,
  timedOut: false,
  durationMs: 0,
};

/**
 * Run a shell command via /bin/sh -c inside the bot's LOCAL workspace
 * (cwd locked there, sanitized env, 256KB output cap, 30s default / 300s max
 * timeout with process-group kill). Outside Tauri: resolves to a stub result.
 */
export async function sessionLocalExec(
  botId: string,
  cmd: string,
  timeoutMs?: number,
): Promise<LocalExecResult> {
  if (!isTauri()) return UNAVAILABLE_EXEC;
  return invoke<LocalExecResult>("session_local_exec", {
    botId,
    cmd,
    timeoutMs: timeoutMs ?? null,
  });
}

/**
 * Run a shell command on the user's personal host over SSH (BatchMode, 10s
 * connect timeout, same 256KB output cap and 30s/300s timeout semantics as
 * local exec). `target` must be `user@host`. Outside Tauri: rejects — a
 * remote host cannot be faked safely.
 */
export async function hostExec(
  target: string,
  cmd: string,
  timeoutMs?: number,
): Promise<LocalExecResult> {
  if (!isTauri()) {
    throw new Error("Personal-host sessions are unavailable outside the desktop app");
  }
  return invoke<LocalExecResult>("host_exec", {
    target,
    cmd,
    timeoutMs: timeoutMs ?? null,
  });
}

/**
 * Pin the SSH target `host_exec` is allowed to reach. The Rust side refuses
 * every other target, so a bot (or anything else driving the webview) cannot
 * point the user's SSH agent at an arbitrary machine on the LAN or at
 * loopback. Pass "" to clear the pin. Must be called at bootstrap from the
 * persisted setting AND whenever the user saves a new target.
 * Outside Tauri: no-op.
 */
export async function hostSetTarget(target: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("host_set_target", { target });
}

/**
 * Discover SSH services on the local network (bounded mDNS browse, ~2.5s,
 * user-initiated). Returns best-effort `<host>.local` candidates for the
 * personal-host target field. Outside Tauri: resolves to an empty list.
 */
export async function hostDiscover(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("host_discover");
}

/**
 * Provision (find/create/start) the bot's Fly session machine.
 * Outside Tauri: rejects — a remote session cannot be faked safely.
 */
export async function flyProvision(botId: string): Promise<FlyProvisionResult> {
  if (!isTauri()) {
    throw new Error("Fly sessions are unavailable outside the desktop app");
  }
  return invoke<FlyProvisionResult>("fly_provision", { botId });
}

/** Run a shell command in a Fly session machine (cwd /workspace). */
export async function flyExec(
  botId: string,
  sessionId: string,
  cmd: string,
  timeoutMs?: number,
): Promise<FlyExecResult> {
  if (!isTauri()) {
    return { exitCode: UNAVAILABLE_EXEC.exitCode, stdout: "", stderr: UNAVAILABLE_EXEC.stderr };
  }
  return invoke<FlyExecResult>("fly_exec", {
    botId,
    sessionId,
    cmd,
    timeoutMs: timeoutMs ?? null,
  });
}

/** Read a UTF-8 file (max 5MB) from a Fly session workspace. Outside Tauri: "". */
export async function flyReadFile(
  botId: string,
  sessionId: string,
  relPath: string,
): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("fly_read_file", { botId, sessionId, relPath });
}

/** Write a file (max 5MB) into a Fly session workspace, creating parent dirs. */
export async function flyWriteFile(
  botId: string,
  sessionId: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("fly_write_file", { botId, sessionId, relPath, content });
}

/**
 * Stop a Fly session machine. `destroy: true` also deletes it; the default
 * (false) retains the stopped image for ≤5s warm restarts.
 */
export async function flyStop(
  botId: string,
  sessionId: string,
  destroy?: boolean,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("fly_stop", { botId, sessionId, destroy: destroy ?? null });
}

/**
 * Fly provider/machine status. Without a FLY_API_TOKEN in keys/.env this is
 * "unconfigured"; with a token and no sessionId it is "ready"; with a
 * sessionId it is the machine state ("provisioning" | "running" | "stopped" |
 * "destroyed"). Outside Tauri: "unconfigured".
 */
export async function flyStatus(
  botId?: string,
  sessionId?: string,
): Promise<string> {
  if (!isTauri()) return "unconfigured";
  const result = await invoke<{ state: string }>("fly_status", {
    botId: botId ?? null,
    sessionId: sessionId ?? null,
  });
  return result.state;
}

// ---------------------------------------------------------------------------
// MCP servers (tool-extensibility "MCP server integration")
// ---------------------------------------------------------------------------

/** One tool exposed by a connected MCP server. */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
}

/** A connected server and its tools. */
export interface McpServerStatus {
  name: string;
  tools: McpToolInfo[];
}

/**
 * Connect (register + spawn + handshake) an MCP stdio server. `envKeys`
 * names keys/.env entries to inject as env vars — the VALUES are resolved
 * on the Rust side and never cross into the webview. User-initiated only.
 * Outside Tauri: rejects (a server process cannot be faked safely).
 */
export async function mcpConnect(
  name: string,
  command: string,
  args: string[],
  envKeys: string[] = [],
): Promise<McpToolInfo[]> {
  if (!isTauri()) {
    throw new Error("MCP servers are unavailable outside the desktop app");
  }
  return invoke<McpToolInfo[]>("mcp_connect", { name, command, args, envKeys });
}

/** Call one tool on a connected server; resolves to model-readable text. */
export async function mcpCall(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("MCP servers are unavailable outside the desktop app");
  }
  return invoke<string>("mcp_call", { server, tool, args });
}

/** Disconnect and forget a server. Outside Tauri: no-op. */
export async function mcpDisconnect(name: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_disconnect", { name });
}

/** Connected servers with their tools. Outside Tauri: []. */
export async function mcpServers(): Promise<McpServerStatus[]> {
  if (!isTauri()) return [];
  return invoke<McpServerStatus[]>("mcp_servers");
}

const NOOP_UNLISTEN: UnlistenFn = () => {};

/** Listen for the tray "Pause All Bots" action. Outside Tauri: no-op. */
export async function onTrayPauseAll(
  handler: () => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return NOOP_UNLISTEN;
  return listen(TRAY_PAUSE_ALL_EVENT, () => handler());
}

/** Listen for the tray "Open Bots" action. Outside Tauri: no-op. */
export async function onTrayOpen(handler: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return NOOP_UNLISTEN;
  return listen(TRAY_OPEN_EVENT, () => handler());
}
