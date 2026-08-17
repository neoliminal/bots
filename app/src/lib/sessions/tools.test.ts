import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTools, formatExecResult } from "./tools";
import { SessionManager } from "./store";
import { SyncEngine } from "./sync";
import type { ToolContext } from "../engine/tools";
import type { Bot } from "../engine/types";
import type {
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
} from "./types";

const OK: SessionExecResult = {
  exitCode: 0,
  stdout: "listing\n",
  stderr: "",
  truncated: false,
  timedOut: false,
};

function bot(id = "bot-1"): Bot {
  return {
    id,
    name: "Test",
    color: "#fff",
    roleDescription: "",
    createdAt: 0,
    paused: false,
  };
}

function ctx(id = "bot-1"): ToolContext {
  return { bot: bot(id), threadId: "t-1" };
}

interface FakeState {
  files: Map<string, { content: string; mtimeMs: number }>;
  execCalls: Array<[string, string]>;
  writeCalls: Array<[string, string, string]>;
  execResult: SessionExecResult;
  failProvision: boolean;
  /** Paths whose readFile rejects (message), simulating non-UTF-8/oversize. */
  failReads: Map<string, string>;
  /** Invoked while a command "runs" — lets tests simulate file mutations. */
  onExec?: () => void;
}

function makeProvider(kind: "local" | "fly" | "host"): {
  provider: SessionProvider;
  state: FakeState;
} {
  const state: FakeState = {
    files: new Map(),
    execCalls: [],
    writeCalls: [],
    execResult: OK,
    failProvision: false,
    failReads: new Map(),
  };
  const provider: SessionProvider = {
    kind,
    async provision(botId) {
      if (state.failProvision) throw new Error("provider outage");
      return { sessionId: `${kind}-${botId}`, status: "running" };
    },
    async exec(sessionId, cmd) {
      state.execCalls.push([sessionId, cmd]);
      state.onExec?.();
      return state.execResult;
    },
    async readFile(_sessionId, relPath) {
      const failure = state.failReads.get(relPath);
      if (failure !== undefined) throw new Error(failure);
      const file = state.files.get(relPath);
      if (!file) throw new Error(`file not found: ${relPath}`);
      return file.content;
    },
    async writeFile(sessionId, relPath, content) {
      state.writeCalls.push([sessionId, relPath, content]);
      state.files.set(relPath, { content, mtimeMs: Date.now() });
    },
    async listFiles(): Promise<SessionFileEntry[]> {
      return [...state.files.entries()].map(([path, file]) => ({
        path,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
      }));
    },
    async stop() {},
    async status() {
      return "running";
    },
  };
  return { provider, state };
}

function toolset(kind: "local" | "fly" | "host") {
  const { provider, state } = makeProvider(kind);
  const manager = new SessionManager(provider, { idleMs: 60_000 });
  const localWrites: Array<[string, string, string]> = [];
  const sync = new SyncEngine(provider, async (botId, relPath, content) => {
    localWrites.push([botId, relPath, content]);
  });
  const syncWarnings: Array<[string, string, string[]]> = [];
  const tools = createSessionTools({
    provider,
    manager,
    sync,
    onSyncFailures: (botId, threadId, failures) => {
      syncWarnings.push([botId, threadId, failures.map((f) => f.path)]);
    },
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { tools, byName, manager, state, localWrites, syncWarnings };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("tool surface", () => {
  it("exposes exactly session_exec, session_read_file, session_write_file", () => {
    const { tools } = toolset("local");
    expect(tools.map((tool) => tool.name)).toEqual([
      "session_exec",
      "session_read_file",
      "session_write_file",
    ]);
  });

  it("session_exec is shell-local (approve-gated) on the local provider (it is the user's Mac)", () => {
    const { byName } = toolset("local");
    expect(byName.session_exec.category).toBe("shell-local");
    expect(byName.session_exec.description).toContain("approval");
  });

  it("session_exec is shell-session (allowed) on the fly provider", () => {
    const { byName } = toolset("fly");
    expect(byName.session_exec.category).toBe("shell-session");
    expect(byName.session_exec.description).toContain("synced back");
  });

  it("file tools use ungated categories", () => {
    for (const kind of ["local", "fly"] as const) {
      const { byName } = toolset(kind);
      expect(byName.session_read_file.category).toBe("read");
      expect(byName.session_write_file.category).toBe("workspace-mutate");
    }
  });

  it("descriptions tell the model when to prefer plain workspace tools", () => {
    const { byName } = toolset("fly");
    expect(byName.session_exec.description).toContain("workspace tools");
    expect(byName.session_exec.parameters).toMatchObject({
      type: "object",
      required: ["cmd"],
    });
  });
});

describe("session_exec.run", () => {
  it("provisions a session, runs the command, and reports the result", async () => {
    const { byName, state } = toolset("fly");
    const output = await byName.session_exec.run({ cmd: "ls" }, ctx());
    expect(state.execCalls.some(([, cmd]) => cmd === "ls")).toBe(true);
    expect(output).toContain("exit code 0");
    expect(output).toContain("listing");
  });

  it("reuses the same session across calls", async () => {
    const { byName, state } = toolset("fly");
    await byName.session_exec.run({ cmd: "a" }, ctx());
    await byName.session_exec.run({ cmd: "b" }, ctx());
    const sessions = new Set(state.execCalls.map(([sessionId]) => sessionId));
    expect(sessions).toEqual(new Set(["fly-bot-1"]));
  });

  it("syncs modified files back and mentions them in the output", async () => {
    const { byName, state, localWrites } = toolset("fly");
    // The command creates a file while it runs; the post-exec sync must
    // copy it back to the local workspace.
    state.onExec = () => {
      state.files.set("made.txt", { content: "new", mtimeMs: 2 });
    };
    const output = await byName.session_exec.run({ cmd: "make it" }, ctx());
    expect(localWrites).toEqual([["bot-1", "made.txt", "new"]]);
    expect(output).toContain("Synced back to local workspace: made.txt");
  });

  it("does not sync on the local provider (already local)", async () => {
    const { byName, localWrites, state } = toolset("local");
    state.files.set("x.txt", { content: "x", mtimeMs: 1 });
    const output = await byName.session_exec.run({ cmd: "true" }, ctx());
    expect(localWrites).toHaveLength(0);
    expect(output).not.toContain("Synced back");
  });

  it("requires cmd", async () => {
    const { byName } = toolset("fly");
    await expect(byName.session_exec.run({}, ctx())).resolves.toContain(
      "cmd is required",
    );
  });

  it("reports timeout and truncation flags", async () => {
    const { byName, state } = toolset("fly");
    state.execResult = {
      exitCode: null,
      stdout: "partial",
      stderr: "",
      truncated: true,
      timedOut: true,
    };
    const output = await byName.session_exec.run({ cmd: "sleep 999" }, ctx());
    expect(output).toContain("killed (no exit code)");
    expect(output).toContain("TIMED OUT");
    expect(output).toContain("OUTPUT TRUNCATED");
  });

  // F4 regression: a file the provider refuses to read back (non-UTF-8 /
  // oversize) is skipped with a visible warning; the exec result stays
  // truthful and the other files still sync.
  it("reports a truthful exec with a sync warning when a file cannot sync back", async () => {
    const { byName, state, localWrites, syncWarnings } = toolset("fly");
    state.onExec = () => {
      state.files.set("good.txt", { content: "ok", mtimeMs: 2 });
      state.files.set("bad.bin", { content: "??", mtimeMs: 2 });
      state.failReads.set("bad.bin", "file is not valid UTF-8: bad.bin");
    };
    const output = await byName.session_exec.run({ cmd: "make both" }, ctx());
    // Exec truthful + good file synced.
    expect(output).toContain("exit code 0");
    expect(output).toContain("Synced back to local workspace: good.txt");
    expect(localWrites).toEqual([["bot-1", "good.txt", "ok"]]);
    // Visible warning, in the output and via the timeline callback.
    expect(output).toContain("Warning: sync-back skipped 1 file");
    expect(output).toContain("bad.bin (file is not valid UTF-8: bad.bin)");
    expect(syncWarnings).toEqual([["bot-1", "t-1", ["bad.bin"]]]);
  });

  it("returns a readable error when provisioning fails", async () => {
    const { byName, state } = toolset("fly");
    state.failProvision = true;
    const output = await byName.session_exec.run({ cmd: "ls" }, ctx());
    expect(output).toBe("Error: provider outage");
  });
});

describe("session_read_file.run / session_write_file.run", () => {
  it("reads a session file", async () => {
    const { byName, state } = toolset("fly");
    state.files.set("notes.txt", { content: "hello", mtimeMs: 1 });
    await expect(
      byName.session_read_file.run({ path: "notes.txt" }, ctx()),
    ).resolves.toBe("hello");
  });

  it("returns a readable error for missing files", async () => {
    const { byName } = toolset("fly");
    await expect(
      byName.session_read_file.run({ path: "nope.txt" }, ctx()),
    ).resolves.toBe("Error: file not found: nope.txt");
  });

  it("requires path arguments", async () => {
    const { byName } = toolset("fly");
    await expect(
      byName.session_read_file.run({}, ctx()),
    ).resolves.toContain("path is required");
    await expect(
      byName.session_write_file.run({ content: "x" }, ctx()),
    ).resolves.toContain("path is required");
  });

  it("write on a remote provider writes through to the local workspace", async () => {
    const { byName, state, localWrites } = toolset("fly");
    const output = await byName.session_write_file.run(
      { path: "out.txt", content: "data" },
      ctx(),
    );
    expect(output).toBe("Wrote 4 bytes to out.txt");
    expect(state.writeCalls).toEqual([["fly-bot-1", "out.txt", "data"]]);
    expect(localWrites).toEqual([["bot-1", "out.txt", "data"]]);
  });

  it("write on the local provider writes once (workspace IS local)", async () => {
    const { byName, state, localWrites } = toolset("local");
    await byName.session_write_file.run(
      { path: "out.txt", content: "data" },
      ctx(),
    );
    expect(state.writeCalls).toEqual([["local-bot-1", "out.txt", "data"]]);
    expect(localWrites).toHaveLength(0);
  });
});

describe("formatExecResult", () => {
  it("renders a plain success", () => {
    const text = formatExecResult(OK, []);
    expect(text).toContain("exit code 0");
    expect(text).toContain("stdout:");
    expect(text).not.toContain("stderr:");
  });

  it("includes stderr when present", () => {
    const text = formatExecResult({ ...OK, stderr: "warn" }, []);
    expect(text).toContain("stderr:\nwarn");
  });

  it("appends a partial-sync warning without touching the exit report", () => {
    const text = formatExecResult(OK, ["a.txt"], [
      { path: "big.bin", error: "file exceeds the 5MB limit: big.bin" },
    ]);
    expect(text).toContain("exit code 0");
    expect(text).toContain("Synced back to local workspace: a.txt");
    expect(text).toContain(
      "Warning: sync-back skipped 1 file (the command itself still ran): " +
        "big.bin (file exceeds the 5MB limit: big.bin)",
    );
  });
});

// Spec: the personal host is the USER'S machine, not a disposable session.
describe("session_exec gating by whose machine it is", () => {
  it("approve-gates the personal host exactly like the user's Mac", () => {
    // The old rule was `provider.kind === "local"`, which put the personal
    // host — a persistent machine holding the user's SSH keys and logged-in
    // browser — into the disposable-VM branch, where shell-session defaults
    // to allow. A shell there is a superset of every gated category.
    expect(toolset("host").byName.session_exec?.category).toBe("shell-local");
    expect(toolset("local").byName.session_exec?.category).toBe("shell-local");
    expect(toolset("fly").byName.session_exec?.category).toBe("shell-session");
  });

  it("stops telling the model the personal host is disposable and ephemeral", () => {
    const description = toolset("host").byName.session_exec?.description ?? "";
    expect(description).toContain("user's OWN personal computer");
    expect(description).toContain("requires the user's approval");
    // It must state the opposite of the old claim, not merely avoid the word.
    expect(description).toContain("NOT disposable");
    expect(description).not.toContain("ephemeral");
    expect(description).not.toContain("micro-VM");
  });

  it("still describes the Fly session as the disposable VM it is", () => {
    const description = toolset("fly").byName.session_exec?.description ?? "";
    expect(description).toContain("disposable");
    expect(description).toContain("micro-VM");
  });

  it("marks command output and session file reads as untrusted", () => {
    const { byName } = toolset("fly");
    expect(byName.session_exec?.untrustedOutput).toBe(true);
    expect(byName.session_read_file?.untrustedOutput).toBe(true);
  });

  it("classifies a session write under skills/ as self-modify", () => {
    const write = toolset("local").byName.session_write_file;
    expect(write?.classify?.({ path: "notes/plan.md" })).toBeUndefined();
    expect(write?.classify?.({ path: "skills/helper/SKILL.md" })).toBe("self-modify");
  });
});
