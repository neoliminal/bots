// Session tool definitions for the engine tool registry.
// Specs: openspec/specs/agent-computer/spec.md (OS tool surface),
//        openspec/specs/task-execution/spec.md (safe-action boundaries).
//
// Gating (tool-extensibility policy) turns on ONE question: does this shell
// run on a machine the USER owns, or on a disposable one the platform owns?
//
//   local  — the user's Mac                     -> "shell-local"  (approve)
//   host   — the user's own personal machine    -> "shell-local"  (approve)
//   fly    — disposable isolated micro-VM       -> "shell-session" (allow)
//
// The personal host must NOT be treated like a cloud session: it is
// persistent, holds the user's SSH keys and their logged-in browser profile,
// and a shell there is a superset of every gated category (it can delete,
// send mail, and read credentials without ever touching those tools). It is
// the user's computer, so it gets the user's computer's gate.
// File read/write tools are workspace-scoped (path-validated, 5MB cap):
// "read" / "workspace-mutate".
import { isSkillPath } from "../engine/skills";
import type { EngineTool, ToolContext } from "../engine/tools";
import type { SessionExecResult, SessionProvider } from "./types";
import { SessionManager } from "./store";
import { SyncEngine, type SyncFailure } from "./sync";

export interface SessionToolsDeps {
  provider: SessionProvider;
  manager: SessionManager;
  sync: SyncEngine;
  /**
   * Called when an exec's sync-back had to skip files (partial sync) so the
   * integration can surface a visible warning on the task timeline. The exec
   * result itself stays truthful either way.
   */
  onSyncFailures?: (
    botId: string,
    threadId: string,
    failures: SyncFailure[],
  ) => void;
  /**
   * Environment availability probe applied to every session tool (engine
   * `EngineTool.available`): when it reports false — e.g. the Fly provider
   * has no token configured — the tools are hidden from all bots instead of
   * failing at call time. Absent means always available.
   */
  available?: () => boolean;
}

/** Format an exec result into model-readable text. */
export function formatExecResult(
  result: SessionExecResult,
  synced: string[],
  failed: SyncFailure[] = [],
): string {
  const parts: string[] = [];
  const exit =
    result.exitCode === null
      ? "killed (no exit code)"
      : `exit code ${result.exitCode}`;
  const flags = [
    result.timedOut ? "TIMED OUT" : "",
    result.truncated ? "OUTPUT TRUNCATED at 256KB" : "",
  ]
    .filter(Boolean)
    .join(", ");
  parts.push(flags ? `${exit} — ${flags}` : exit);
  parts.push(`stdout:\n${result.stdout || "(empty)"}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (synced.length > 0) {
    parts.push(`Synced back to local workspace: ${synced.join(", ")}`);
  }
  if (failed.length > 0) {
    // Truthful partial-sync report: the command ran; these files did not
    // make it back to the local workspace.
    const detail = failed.map((f) => `${f.path} (${f.error})`).join("; ");
    parts.push(
      `Warning: sync-back skipped ${failed.length} file${
        failed.length === 1 ? "" : "s"
      } (the command itself still ran): ${detail}`,
    );
  }
  return parts.join("\n");
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}`;
}

/**
 * Build the session tools for the registry. Descriptions steer the model:
 * plain workspace tools (workspace_read/workspace_write) are for simple
 * file content work; session tools are for anything needing a real shell.
 */
export function createSessionTools(deps: SessionToolsDeps): EngineTool[] {
  const { manager, sync } = deps;
  const kind = deps.provider.kind;
  /** The shell runs on hardware the user owns (their Mac or their host). */
  const userOwnedMachine = kind === "local" || kind === "host";
  const local = kind === "local";
  const availability = deps.available !== undefined ? { available: deps.available } : {};

  const hostDescription =
    "Run a shell command (/bin/sh -c) in your workspace directory on the " +
    "user's OWN personal computer, reached over SSH. This machine is NOT " +
    "disposable: it is a real computer the user keeps, holding their files, " +
    "their SSH keys, and a browser signed in to their accounts. Anything you " +
    "do here is permanent and affects them directly, so treat it exactly as " +
    "carefully as their Mac — never install or delete broadly, never touch " +
    "credentials, and prefer the narrowest command that answers the " +
    "question. The command runs with its working directory set to your " +
    "workspace, a 256KB output cap and a timeout (default 30s, max 300s). " +
    "Because it executes on the user's own machine, each call requires the " +
    "user's approval.";

  const macDescription =
    "Run a shell command (/bin/sh -c) in your workspace directory on the " +
    "user's Mac. Use this only when a task genuinely needs a shell " +
    "(running scripts, converting files, inspecting data with CLI tools) — " +
    "for plain file reads/writes prefer session_read_file / " +
    "session_write_file or the workspace tools. The command runs with its " +
    "working directory locked to your workspace, a minimal environment, a " +
    "256KB output cap and a timeout (default 30s, max 300s). Because this " +
    "executes on the user's own machine, each call requires the user's " +
    "approval.";

  const cloudDescription =
    "Run a shell command (/bin/sh -c) in your disposable cloud compute " +
    "session (an isolated Linux micro-VM seeded from your workspace). Use " +
    "it when a task needs a real shell or tools not available locally — " +
    "you may install packages (apt-get) and run long processes. Files you " +
    "create or modify under the session workspace are automatically " +
    "synced back to the user's local workspace after each command and at " +
    "60s checkpoints during long runs; the session itself is ephemeral " +
    "and auto-stops when idle, so never rely on session state persisting " +
    "— rely on workspace files. For plain file reads/writes prefer " +
    "session_read_file / session_write_file or the workspace tools.";

  const execDescription =
    kind === "host"
      ? hostDescription
      : kind === "local"
        ? macDescription
        : cloudDescription;

  const sessionExec: EngineTool = {
    name: "session_exec",
    description: execDescription,
    category: userOwnedMachine ? "shell-local" : "shell-session",
    // Shell output is whatever the command printed — files, network
    // responses, other programs. Never the user speaking.
    untrustedOutput: true,
    ...availability,
    parameters: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "Shell command to run via /bin/sh -c.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Optional timeout in milliseconds (default 30000, max 300000).",
        },
      },
      required: ["cmd"],
    },
    async run(args, ctx: ToolContext) {
      const cmd = typeof args.cmd === "string" ? args.cmd : "";
      if (!cmd.trim()) return "Error: cmd is required";
      // Stop arrived while this call was queued behind an approval or an
      // earlier command in the same round: never start the process.
      if (ctx.signal?.aborted === true) {
        throw new DOMException("The run was stopped.", "AbortError");
      }
      const timeoutMs =
        typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
      try {
        const sessionId = await manager.acquire(ctx.bot.id);
        const { result, synced, failed } = await sync.execWithSync(
          ctx.bot.id,
          sessionId,
          cmd,
          { timeoutMs },
        );
        manager.touch(ctx.bot.id);
        if (failed.length > 0) {
          deps.onSyncFailures?.(ctx.bot.id, ctx.threadId, failed);
        }
        return formatExecResult(result, synced, failed);
      } catch (error) {
        return errorText(error);
      }
    },
  };

  const sessionReadFile: EngineTool = {
    name: "session_read_file",
    description:
      "Read a UTF-8 text file (max 5MB) from your compute session's " +
      "workspace by relative path. " +
      (local
        ? "On the local provider this is the same directory as your " +
          "workspace tools."
        : "Use it to inspect files produced by session_exec commands in the " +
          "cloud session before they matter to the user."),
    category: "read",
    // Session files are produced by commands, downloads and syncs — data.
    untrustedOutput: true,
    ...availability,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path (no '..', no leading /).",
        },
      },
      required: ["path"],
    },
    async run(args, ctx: ToolContext) {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path.trim()) return "Error: path is required";
      try {
        const sessionId = await manager.acquire(ctx.bot.id);
        const content = await deps.provider.readFile(sessionId, path);
        manager.touch(ctx.bot.id);
        return content;
      } catch (error) {
        return errorText(error);
      }
    },
  };

  const sessionWriteFile: EngineTool = {
    name: "session_write_file",
    description:
      "Write a UTF-8 text file (max 5MB) into your compute session's " +
      "workspace by relative path, creating parent directories. " +
      (local
        ? "On the local provider this writes directly into your workspace."
        : "The file is also written through to the user's local workspace " +
          "immediately (the local workspace is the source of truth)."),
    category: "workspace-mutate",
    // Writes here are mirrored into the local workspace, where skills/ is
    // auto-discovered into the system prompt — same self-modify concern as
    // workspace_write (see engine/skills.ts isSkillPath).
    classify: (args) =>
      isSkillPath(typeof args.path === "string" ? args.path : "")
        ? "self-modify"
        : undefined,
    ...availability,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path (no '..', no leading /).",
        },
        content: {
          type: "string",
          description: "Full file content to write.",
        },
      },
      required: ["path", "content"],
    },
    async run(args, ctx: ToolContext) {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!path.trim()) return "Error: path is required";
      try {
        const sessionId = await manager.acquire(ctx.bot.id);
        await sync.writeThrough(ctx.bot.id, sessionId, path, content);
        manager.touch(ctx.bot.id);
        return `Wrote ${content.length} bytes to ${path}`;
      } catch (error) {
        return errorText(error);
      }
    },
  };

  return [sessionExec, sessionReadFile, sessionWriteFile];
}
