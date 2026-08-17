// Compute-session layer: provider-agnostic types.
// Spec: openspec/specs/agent-computer/spec.md — on-demand sessions, local
// source of truth, ephemeral by default.

/** Which backend runs the session. */
export type SessionKind = "local" | "fly" | "host";

/**
 * Session status vocabulary shared by providers, the lifecycle store, and
 * the UI. "unconfigured" means the provider cannot run at all (e.g. no
 * FLY_API_TOKEN); "none" means no session exists for the bot yet.
 */
export type SessionStatus =
  | "none"
  | "unconfigured"
  | "provisioning"
  | "running"
  | "stopped"
  | "destroyed"
  | "error";

export interface SessionExecOpts {
  /** Command timeout; provider default 30s, hard max 300s. */
  timeoutMs?: number;
}

/** Result of running a command in a session. */
export interface SessionExecResult {
  /** Exit code, or null when the process was killed (timeout/output cap). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when output hit the provider's cap (local: 256KB). */
  truncated: boolean;
  /** True when the timeout expired and the process (group) was killed. */
  timedOut: boolean;
}

/** One file in a session workspace listing. */
export interface SessionFileEntry {
  /** Workspace-relative path (unix separators). */
  path: string;
  size: number;
  /** Modification time (epoch ms) when the provider can report it. */
  mtimeMs?: number;
  /**
   * Content checksum when the provider can report one (fly: cksum CRC from
   * the listing command). Lets the sync-back diff catch modifications that
   * keep the same mtime second and size (see sync.ts).
   */
  contentHash?: string;
}

export interface SessionProvisionResult {
  sessionId: string;
  status: SessionStatus;
}

export interface SessionStopOpts {
  /**
   * Destroy the underlying compute entirely instead of stopping it.
   * Default false: a stopped image is retained for warm restarts
   * (agent-computer spec, "Ephemeral by default").
   */
  destroy?: boolean;
}

/**
 * A compute-session backend. All file paths are session-workspace-relative
 * and subject to the same validation as the local workspace (no absolute
 * paths, no traversal, 5MB per-file cap).
 */
export interface SessionProvider {
  readonly kind: SessionKind;
  /** Provision (or reuse) the bot's session; blocks until it is usable. */
  provision(botId: string): Promise<SessionProvisionResult>;
  /** Run a shell command with cwd at the session workspace root. */
  exec(
    sessionId: string,
    cmd: string,
    opts?: SessionExecOpts,
  ): Promise<SessionExecResult>;
  /** Read a UTF-8 file from the session workspace. */
  readFile(sessionId: string, relPath: string): Promise<string>;
  /** Write a UTF-8 file into the session workspace, creating parent dirs. */
  writeFile(sessionId: string, relPath: string, content: string): Promise<void>;
  /** List all files (not directories) in the session workspace. */
  listFiles(sessionId: string): Promise<SessionFileEntry[]>;
  /** Stop the session (destroying it only when opts.destroy is true). */
  stop(sessionId: string, opts?: SessionStopOpts): Promise<void>;
  /** Current status of the session. */
  status(sessionId: string): Promise<SessionStatus>;
}

/** Status event emitted by the session lifecycle store for the UI. */
export interface SessionStatusEvent {
  botId: string;
  /** Null while provisioning fails or before a session exists. */
  sessionId: string | null;
  status: SessionStatus;
  kind: SessionKind;
}
