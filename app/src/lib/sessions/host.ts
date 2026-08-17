// PERSONAL HOST session provider: commands run on a user-owned machine
// (e.g. a mini-PC) over SSH. Spec: openspec/specs/agent-computer/spec.md —
// "Personal host sessions": persistent by design (the ephemeral-by-default
// rule applies to cloud sessions), per-bot workspaces under one root, local
// workspace stays the source of truth via the normal SyncEngine.
//
// Transport is a single native command (`hostExec` → ssh BatchMode); files
// move as base64 through exec, so the host needs nothing but sshd and the
// provisioned ~/.bots-host layout (see host/README.md at the repo root).
import { hostExec } from "../native";
import { LIST_FILES_CMD, parseListOutput } from "./fly";
import type {
  SessionExecOpts,
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
  SessionProvisionResult,
  SessionStatus,
  SessionStopOpts,
} from "./types";

/** Host session ids are `host:<botId>` — the machine itself is long-lived. */
export const HOST_SESSION_PREFIX = "host:";

/**
 * Host root on the remote machine. Deliberately unquoted in commands so the
 * remote shell expands `~`; everything appended after it is validated.
 */
export const HOST_ROOT = "~/.bots-host";

/** Per-file cap, matching the workspace layer. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Raw bytes per write chunk. Base64 expands 4/3 and the whole chunk rides
 * in one ssh command line, so stay far below common ARG_MAX limits.
 */
export const WRITE_CHUNK_BYTES = 96 * 1024;

/** ssh's own exit code for connection/authentication failure. */
const SSH_TRANSPORT_EXIT = 255;

export type HostExecFn = typeof hostExec;

export interface HostProviderDeps {
  /** Injected transport for tests; defaults to the native ssh binding. */
  exec?: HostExecFn;
}

/** Extract the bot id from a host session id. */
export function hostSessionBotId(sessionId: string): string {
  if (!sessionId.startsWith(HOST_SESSION_PREFIX)) {
    throw new Error(`not a host session id: ${sessionId}`);
  }
  return sessionId.slice(HOST_SESSION_PREFIX.length);
}

/** Single-quote a string for the remote POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Bot ids appear unquoted after HOST_ROOT — restrict them hard. */
function validateBotId(botId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) {
    throw new Error(`unsafe bot id for host session: ${botId}`);
  }
  return botId;
}

/** Same path rules as the workspace layer: relative, no traversal. */
export function validateRelPath(relPath: string): string {
  if (
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`invalid workspace-relative path: ${relPath}`);
  }
  return relPath;
}

/** The bot's workspace directory expression (remote-shell `~` expansion). */
export function workspaceDir(botId: string): string {
  return `${HOST_ROOT}/workspace/${validateBotId(botId)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class HostSessionProvider implements SessionProvider {
  readonly kind = "host" as const;
  private readonly exec_: HostExecFn;

  constructor(
    /** SSH target `user@host`; empty means not configured yet. */
    private readonly target: string,
    deps: HostProviderDeps = {},
  ) {
    this.exec_ = deps.exec ?? hostExec;
  }

  private requireTarget(): string {
    if (!this.target.trim()) {
      throw new Error(
        "Personal host is not configured — set the SSH target in Settings.",
      );
    }
    return this.target.trim();
  }

  private async ssh(
    cmd: string,
    timeoutMs?: number,
  ): Promise<SessionExecResult> {
    const result = await this.exec_(this.requireTarget(), cmd, timeoutMs);
    if (result.exitCode === SSH_TRANSPORT_EXIT) {
      throw new Error(
        `personal host unreachable over ssh: ${
          result.stderr.trim() || "connection failed"
        }`,
      );
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  }

  async provision(botId: string): Promise<SessionProvisionResult> {
    const dir = workspaceDir(botId);
    const sessionId = `${HOST_SESSION_PREFIX}${botId}`;
    const result = await this.ssh(`mkdir -p ${dir} && echo ready`);
    if (result.exitCode !== 0) {
      throw new Error(
        `cannot provision host workspace: ${result.stderr.trim() || "mkdir failed"}`,
      );
    }
    return { sessionId, status: "running" };
  }

  async exec(
    sessionId: string,
    cmd: string,
    opts?: SessionExecOpts,
  ): Promise<SessionExecResult> {
    const dir = workspaceDir(hostSessionBotId(sessionId));
    return this.ssh(`cd ${dir} && (${cmd})`, opts?.timeoutMs);
  }

  async readFile(sessionId: string, relPath: string): Promise<string> {
    const dir = workspaceDir(hostSessionBotId(sessionId));
    const q = shQuote(validateRelPath(relPath));
    const result = await this.ssh(`cd ${dir} && base64 < ${q}`);
    if (result.exitCode !== 0) {
      throw new Error(
        `cannot read ${relPath}: ${result.stderr.trim() || "read failed"}`,
      );
    }
    if (result.truncated) {
      // The transport caps combined output at 256KB; a bigger file must be
      // reduced on the host (session_exec) rather than silently clipped.
      throw new Error(
        `${relPath} is too large to read over the host transport (256KB output cap)`,
      );
    }
    return fromBase64(result.stdout);
  }

  async writeFile(
    sessionId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    const dir = workspaceDir(hostSessionBotId(sessionId));
    const path = validateRelPath(relPath);
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`file exceeds the 5MB cap: ${relPath}`);
    }
    const q = shQuote(path);
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    const mkdir = parent ? `mkdir -p ${shQuote(parent)} && ` : "";

    // Chunk the BYTES (never the string — a UTF-16 slice could split a
    // surrogate pair); each chunk is one ssh exec, `>` first then `>>`.
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      chunks.push(toBase64(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)));
    }
    if (chunks.length === 0) chunks.push(""); // empty file still truncates
    for (let i = 0; i < chunks.length; i++) {
      const redirect = i === 0 ? ">" : ">>";
      const result = await this.ssh(
        `cd ${dir} && ${i === 0 ? mkdir : ""}printf %s ${shQuote(chunks[i])} | base64 -d ${redirect} ${q}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `cannot write ${relPath}: ${result.stderr.trim() || "write failed"}`,
        );
      }
    }
  }

  async listFiles(sessionId: string): Promise<SessionFileEntry[]> {
    const dir = workspaceDir(hostSessionBotId(sessionId));
    const result = await this.ssh(`cd ${dir} && ${LIST_FILES_CMD}`);
    if (result.exitCode !== 0) {
      throw new Error(
        `cannot list host files: ${result.stderr.trim() || "list failed"}`,
      );
    }
    return parseListOutput(result.stdout);
  }

  async stop(_sessionId: string, _opts?: SessionStopOpts): Promise<void> {
    // A personal host is persistent by design (spec: Personal host
    // sessions) — there is no compute resource to stop or destroy, and the
    // workspace/profile intentionally survive.
  }

  async status(_sessionId: string): Promise<SessionStatus> {
    if (!this.target.trim()) return "unconfigured";
    try {
      const result = await this.ssh("echo ok");
      return result.exitCode === 0 ? "running" : "error";
    } catch {
      return "error";
    }
  }

  /** Settings-surface probe (mirrors FlySessionProvider.providerStatus). */
  async providerStatus(): Promise<SessionStatus> {
    return this.status("");
  }
}
