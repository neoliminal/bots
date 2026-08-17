// FLY session provider: disposable Fly Machines micro-VMs reached through
// the Rust `fly_*` commands (src-tauri/src/fly.rs). The FLY_API_TOKEN never
// reaches this layer — all API calls happen Rust-side.
//
// File listing runs over exec (`find` + `stat` + `cksum`) so the SyncEngine
// can diff mtime+size+content-hash signatures for sync-back after each
// modifying call — the cksum CRC catches modifications that land in the
// same second with the same size, which mtime+size alone would miss.
import {
  flyExec,
  flyProvision,
  flyReadFile,
  flyStatus,
  flyStop,
  flyWriteFile,
} from "../native";
import type {
  SessionExecOpts,
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
  SessionProvisionResult,
  SessionStatus,
  SessionStopOpts,
} from "./types";

/**
 * Shell command producing one `mtime|size|cksum|path` line per workspace
 * file. The cksum CRC gives the sync signature content sensitivity, so a
 * same-second same-size rewrite is still detected.
 */
export const LIST_FILES_CMD =
  'find . -type f -exec sh -c \'for f in "$@"; do ' +
  'printf "%s|%s|%s\\n" "$(stat -c "%Y|%s" -- "$f")" "$(cksum < "$f" | cut -d" " -f1)" "$f"; ' +
  "done' sh {} +";

/** Parse the LIST_FILES_CMD output into file entries. Lines in the legacy
 * `mtime|size|path` shape (no cksum field) still parse, without a hash. */
export function parseListOutput(stdout: string): SessionFileEntry[] {
  const entries: SessionFileEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf("|");
    const second = trimmed.indexOf("|", first + 1);
    if (first < 0 || second < 0) continue;
    const mtime = Number(trimmed.slice(0, first));
    const size = Number(trimmed.slice(first + 1, second));
    let rest = trimmed.slice(second + 1);
    // Current format carries a decimal CRC before the path; a third field
    // that is not purely digits is a legacy path (paths may contain "|").
    let contentHash: string | undefined;
    const third = rest.indexOf("|");
    if (third > 0) {
      const candidate = rest.slice(0, third);
      if (/^\d+$/.test(candidate)) {
        contentHash = candidate;
        rest = rest.slice(third + 1);
      }
    }
    let path = rest;
    if (path.startsWith("./")) path = path.slice(2);
    if (!path || Number.isNaN(mtime) || Number.isNaN(size)) continue;
    entries.push({
      path,
      size,
      mtimeMs: mtime * 1000,
      ...(contentHash !== undefined ? { contentHash } : {}),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

const STATUSES: readonly SessionStatus[] = [
  "none",
  "unconfigured",
  "provisioning",
  "running",
  "stopped",
  "destroyed",
  "error",
];

function toStatus(state: string): SessionStatus {
  return (STATUSES as readonly string[]).includes(state)
    ? (state as SessionStatus)
    : "error";
}

export class FlySessionProvider implements SessionProvider {
  readonly kind = "fly" as const;

  /**
   * sessionId -> owning bot. The Rust layer refuses any machine command whose
   * bot does not own that machine, so one bot can no longer exec inside
   * another bot's session or destroy a machine it never provisioned. The
   * SessionProvider interface is keyed by sessionId alone, so the provider
   * remembers the owner it provisioned for.
   */
  private readonly owners = new Map<string, string>();

  /** Owner of a session, or a clear error naming the fix. */
  private ownerOf(sessionId: string): string {
    const botId = this.owners.get(sessionId);
    if (botId === undefined) {
      throw new Error(
        `unknown session "${sessionId}" — it was not provisioned in this ` +
          "app run; provision the session again",
      );
    }
    return botId;
  }

  async provision(botId: string): Promise<SessionProvisionResult> {
    const result = await flyProvision(botId);
    this.owners.set(result.sessionId, botId);
    return { sessionId: result.sessionId, status: toStatus(result.state) };
  }

  async exec(
    sessionId: string,
    cmd: string,
    opts?: SessionExecOpts,
  ): Promise<SessionExecResult> {
    const result = await flyExec(
      this.ownerOf(sessionId),
      sessionId,
      cmd,
      opts?.timeoutMs,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: false,
      timedOut: false,
    };
  }

  async readFile(sessionId: string, relPath: string): Promise<string> {
    return flyReadFile(this.ownerOf(sessionId), sessionId, relPath);
  }

  async writeFile(
    sessionId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    await flyWriteFile(this.ownerOf(sessionId), sessionId, relPath, content);
  }

  async listFiles(sessionId: string): Promise<SessionFileEntry[]> {
    const result = await this.exec(sessionId, LIST_FILES_CMD);
    if (result.exitCode !== 0) {
      throw new Error(
        `cannot list session files: ${result.stderr.trim() || "exec failed"}`,
      );
    }
    return parseListOutput(result.stdout);
  }

  async stop(sessionId: string, opts?: SessionStopOpts): Promise<void> {
    const botId = this.ownerOf(sessionId);
    await flyStop(botId, sessionId, opts?.destroy);
    if (opts?.destroy === true) this.owners.delete(sessionId);
  }

  async status(sessionId: string): Promise<SessionStatus> {
    return toStatus(await flyStatus(this.ownerOf(sessionId), sessionId));
  }

  /** Provider-level readiness: "unconfigured" without a FLY_API_TOKEN. */
  async providerStatus(): Promise<SessionStatus> {
    const state = await flyStatus();
    return state === "ready" ? "none" : toStatus(state);
  }
}
