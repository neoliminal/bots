// LOCAL session provider (default): commands run sandboxed on the user's
// computer inside the bot's existing workspace directory. The Rust side locks
// cwd to the workspace, sanitizes the environment, caps output at 256KB and
// kills the process group on timeout (src-tauri/src/session.rs).
//
// Because the session filesystem IS the local workspace, sync-back is
// inherent — the SyncEngine treats this provider as a no-op.
import {
  sessionLocalExec,
  workspaceList,
  workspaceRead,
  workspaceWrite,
} from "../native";
import type {
  SessionExecOpts,
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
  SessionProvisionResult,
  SessionStatus,
} from "./types";

/** Local session ids are `local:<botId>` — no remote resource to track. */
export const LOCAL_SESSION_PREFIX = "local:";

/** Extract the bot id from a local session id. */
export function localSessionBotId(sessionId: string): string {
  if (!sessionId.startsWith(LOCAL_SESSION_PREFIX)) {
    throw new Error(`not a local session id: ${sessionId}`);
  }
  return sessionId.slice(LOCAL_SESSION_PREFIX.length);
}

export class LocalSessionProvider implements SessionProvider {
  readonly kind = "local" as const;

  async provision(botId: string): Promise<SessionProvisionResult> {
    // Nothing to spin up: the workspace directory is created on demand by
    // the native layer. A local session is instantly "running".
    return { sessionId: `${LOCAL_SESSION_PREFIX}${botId}`, status: "running" };
  }

  async exec(
    sessionId: string,
    cmd: string,
    opts?: SessionExecOpts,
  ): Promise<SessionExecResult> {
    const botId = localSessionBotId(sessionId);
    const result = await sessionLocalExec(botId, cmd, opts?.timeoutMs);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  }

  async readFile(sessionId: string, relPath: string): Promise<string> {
    return workspaceRead(localSessionBotId(sessionId), relPath);
  }

  async writeFile(
    sessionId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    await workspaceWrite(localSessionBotId(sessionId), relPath, content);
  }

  async listFiles(sessionId: string): Promise<SessionFileEntry[]> {
    const entries = await workspaceList(localSessionBotId(sessionId));
    return entries
      .filter((entry) => !entry.isDir)
      .map((entry) => ({ path: entry.path, size: entry.size }));
  }

  async stop(): Promise<void> {
    // Nothing to stop: there is no separate compute resource.
  }

  async status(): Promise<SessionStatus> {
    // The local machine is always available.
    return "running";
  }
}
