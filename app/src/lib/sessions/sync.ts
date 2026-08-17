// Sync-back engine for remote session providers.
// Spec: openspec/specs/agent-computer/spec.md — "Local source of truth with
// continuous sync-back": every file a session modifies is copied back to
// the local workspace AFTER each completed modifying tool call and at
// CHECKPOINTS (every 60s) during long-running execs, so a dying session
// never loses more than the work in flight.
//
// Modified files are detected by before/after listings of file signatures:
// mtime + size + (when the provider reports one) a content hash. The hash
// closes the same-second/same-size blind spot of a pure mtime+size diff.
// RESIDUAL WINDOW: for providers that report neither a content hash nor
// sub-second mtimes, a file rewritten within the same second at exactly the
// same size is still indistinguishable from an unchanged file and will be
// missed until its next change. The Fly provider reports a cksum-based hash
// (see fly.ts LIST_FILES_CMD), so it has no such window.
//
// Per-file failure tolerance: a file that cannot be copied back (e.g. the
// provider rejects non-UTF-8 content or a >5MB file) is SKIPPED with a
// recorded failure while the remaining files still sync, and an exec that
// succeeded is still reported as succeeded — the sync result carries the
// partial-failure detail separately so the UI can warn visibly.
//
// For the LOCAL provider everything here is a no-op: the session filesystem
// already IS the local workspace.
import { isSkillPath } from "../engine/skills";
import { workspaceWrite } from "../native";
import type {
  SessionExecOpts,
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
} from "./types";

/** Checkpoint poll interval during long-running execs. */
export const CHECKPOINT_INTERVAL_MS = 60_000;

/** Copies a file into the bot's LOCAL workspace (defaults to native workspace_write). */
export type LocalWriteFn = (
  botId: string,
  relPath: string,
  content: string,
) => Promise<void>;

/**
 * Change-detection signature for one file: mtime + size, plus the provider's
 * content hash when reported (fly's listing includes a cksum CRC). See the
 * module header for the residual window when no hash is available.
 */
export function signatureOf(entry: SessionFileEntry): string {
  const base = `${entry.mtimeMs ?? "?"}:${entry.size}`;
  return entry.contentHash !== undefined ? `${base}:${entry.contentHash}` : base;
}

/** One file the sync-back had to skip, with the reason. */
export interface SyncFailure {
  path: string;
  error: string;
}

/** Result of one syncChanged pass. */
export interface SyncChangedResult {
  /** Workspace-relative paths copied back to the local workspace. */
  synced: string[];
  /** Files that changed but could not be copied back (skipped, not fatal). */
  failed: SyncFailure[];
}

export interface ExecWithSyncResult {
  result: SessionExecResult;
  /** Workspace-relative paths copied back to the local workspace. */
  synced: string[];
  /** Files that changed but could not be copied back (partial sync). */
  failed: SyncFailure[];
}

export class SyncEngine {
  private readonly writeLocal: LocalWriteFn;

  constructor(
    private readonly provider: SessionProvider,
    writeLocal?: LocalWriteFn,
  ) {
    this.writeLocal =
      writeLocal ??
      ((botId, relPath, content) => workspaceWrite(botId, relPath, content));
  }

  /** False for the local provider: files are already local. */
  get active(): boolean {
    return this.provider.kind !== "local";
  }

  /** Snapshot the session workspace as path → signature. */
  async snapshot(sessionId: string): Promise<Map<string, string>> {
    if (!this.active) return new Map();
    const entries = await this.provider.listFiles(sessionId);
    return new Map(entries.map((entry) => [entry.path, signatureOf(entry)]));
  }

  /**
   * Copy every file that changed since `baseline` back to the local
   * workspace, updating `baseline` in place so repeated calls (checkpoint
   * polls) never re-copy stable files. A file whose copy fails is skipped
   * (recorded in `failed`) WITHOUT touching its baseline entry, so a later
   * pass retries it; the remaining files still sync.
   */
  async syncChanged(
    botId: string,
    sessionId: string,
    baseline: Map<string, string>,
  ): Promise<SyncChangedResult> {
    if (!this.active) return { synced: [], failed: [] };
    const entries = await this.provider.listFiles(sessionId);
    const changed = entries.filter(
      (entry) => baseline.get(entry.path) !== signatureOf(entry),
    );
    const synced: string[] = [];
    const failed: SyncFailure[] = [];
    const refused: string[] = [];
    for (const entry of changed) {
      // Sync-back is the one direction where REMOTE-chosen filenames land on
      // the user's machine. Paths under skills/ are auto-discovered into the
      // bot's system prompt, so syncing one back would let a compromised
      // session (or the bot itself, via an unapproved remote write) install
      // permanent instructions locally through a fully path-valid write.
      // Refuse them here; legitimate skills are authored locally.
      if (isSkillPath(entry.path)) {
        refused.push(entry.path);
        // Baseline it so the refusal is reported once, not on every poll.
        baseline.set(entry.path, signatureOf(entry));
        continue;
      }
      try {
        const content = await this.provider.readFile(sessionId, entry.path);
        await this.writeLocal(botId, entry.path, content);
        baseline.set(entry.path, signatureOf(entry));
        synced.push(entry.path);
      } catch (err) {
        failed.push({
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const path of refused) {
      failed.push({
        path,
        error:
          "refused: files under skills/ are not synced back, because they " +
          "become part of your system prompt. Ask the user to add a skill.",
      });
    }
    return { synced, failed };
  }

  /**
   * Run a command in the session with the full sync-back contract:
   * checkpoint syncs every `checkpointMs` (default 60s) while the command
   * runs, plus a final sync after it completes. Local provider: plain exec.
   *
   * The exec result stays truthful: per-file sync failures (and even a
   * failed final listing) never turn a successful exec into an error — they
   * are reported in `failed` for the caller to surface.
   */
  async execWithSync(
    botId: string,
    sessionId: string,
    cmd: string,
    opts?: SessionExecOpts,
    checkpointMs: number = CHECKPOINT_INTERVAL_MS,
  ): Promise<ExecWithSyncResult> {
    if (!this.active) {
      const result = await this.provider.exec(sessionId, cmd, opts);
      return { result, synced: [], failed: [] };
    }

    const baseline = await this.snapshot(sessionId);
    const synced = new Set<string>();
    const failures = new Map<string, SyncFailure>();
    const merge = (pass: SyncChangedResult): void => {
      for (const path of pass.synced) {
        synced.add(path);
        failures.delete(path); // a retry succeeded — the warning is stale
      }
      for (const failure of pass.failed) failures.set(failure.path, failure);
    };

    let checkpointInFlight = false;
    const timer = setInterval(() => {
      if (checkpointInFlight) return;
      checkpointInFlight = true;
      this.syncChanged(botId, sessionId, baseline)
        .then(merge)
        .catch(() => {
          // Checkpoint sync failures are non-fatal; the post-exec sync
          // (or the next checkpoint) retries.
        })
        .finally(() => {
          checkpointInFlight = false;
        });
    }, checkpointMs);

    let result: SessionExecResult;
    try {
      result = await this.provider.exec(sessionId, cmd, opts);
    } finally {
      clearInterval(timer);
    }
    try {
      merge(await this.syncChanged(botId, sessionId, baseline));
    } catch (err) {
      // The exec itself succeeded — a failed final listing is a (visible)
      // sync problem, not an exec failure.
      failures.set("(workspace listing)", {
        path: "(workspace listing)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { result, synced: [...synced], failed: [...failures.values()] };
  }

  /**
   * Write a file into the session AND (for remote providers) straight into
   * the local workspace — a writeFile is a modifying call, so its sync-back
   * is immediate and exact.
   */
  async writeThrough(
    botId: string,
    sessionId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    await this.provider.writeFile(sessionId, relPath, content);
    if (this.active) {
      await this.writeLocal(botId, relPath, content);
    }
  }
}
