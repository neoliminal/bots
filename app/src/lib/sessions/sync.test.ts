import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine, signatureOf } from "./sync";
import type {
  SessionExecResult,
  SessionFileEntry,
  SessionProvider,
} from "./types";

const OK: SessionExecResult = {
  exitCode: 0,
  stdout: "done",
  stderr: "",
  truncated: false,
  timedOut: false,
};

/** Tiny deterministic content hash standing in for the provider's cksum. */
function tinyHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * Fake remote provider with a mutable in-memory filesystem. `onExec` lets a
 * test mutate files "during" a command; `failReads` makes readFile reject
 * for specific paths (simulating non-UTF-8 / oversize refusals); listings
 * include a content hash unless `withHashes` is false.
 */
function fakeRemote(options: { withHashes?: boolean } = {}) {
  const withHashes = options.withHashes ?? true;
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const state = {
    files,
    onExec: undefined as undefined | (() => void | Promise<void>),
    execCalls: [] as string[],
    readCalls: [] as string[],
    writeCalls: [] as Array<[string, string]>,
    failReads: new Map<string, string>(),
    setFile(path: string, content: string, mtimeMs: number) {
      files.set(path, { content, mtimeMs });
    },
  };
  const provider: SessionProvider = {
    kind: "fly",
    async provision(botId) {
      return { sessionId: `m-${botId}`, status: "running" };
    },
    async exec(_sessionId, cmd) {
      state.execCalls.push(cmd);
      await state.onExec?.();
      return OK;
    },
    async readFile(_sessionId, relPath) {
      state.readCalls.push(relPath);
      const failure = state.failReads.get(relPath);
      if (failure !== undefined) throw new Error(failure);
      const file = files.get(relPath);
      if (!file) throw new Error(`missing: ${relPath}`);
      return file.content;
    },
    async writeFile(_sessionId, relPath, content) {
      state.writeCalls.push([relPath, content]);
      files.set(relPath, { content, mtimeMs: Date.now() });
    },
    async listFiles(): Promise<SessionFileEntry[]> {
      return [...files.entries()].map(([path, file]) => ({
        path,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
        ...(withHashes ? { contentHash: tinyHash(file.content) } : {}),
      }));
    },
    async stop() {},
    async status() {
      return "running";
    },
  };
  return { provider, state };
}

function localWriteSpy() {
  const writes: Array<[string, string, string]> = [];
  const fn = async (botId: string, relPath: string, content: string) => {
    writes.push([botId, relPath, content]);
  };
  return { writes, fn };
}

describe("signatureOf", () => {
  it("combines mtime and size, tolerating missing mtimes", () => {
    expect(signatureOf({ path: "a", size: 3, mtimeMs: 1000 })).toBe("1000:3");
    expect(signatureOf({ path: "a", size: 3 })).toBe("?:3");
  });

  it("includes the provider's content hash when reported (F5)", () => {
    expect(
      signatureOf({ path: "a", size: 3, mtimeMs: 1000, contentHash: "42" }),
    ).toBe("1000:3:42");
    // Same second, same size, different content → different signatures.
    expect(
      signatureOf({ path: "a", size: 3, mtimeMs: 1000, contentHash: "42" }),
    ).not.toBe(
      signatureOf({ path: "a", size: 3, mtimeMs: 1000, contentHash: "43" }),
    );
  });
});

describe("SyncEngine with a local provider", () => {
  it("is inactive and never lists, reads, or writes", async () => {
    const { provider, state } = fakeRemote();
    const local: SessionProvider = { ...provider, kind: "local" };
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(local, fn);
    expect(sync.active).toBe(false);
    state.setFile("a.txt", "data", 1);
    const { result, synced, failed } = await sync.execWithSync("bot-1", "s", "touch x");
    expect(result).toEqual(OK);
    expect(synced).toEqual([]);
    expect(failed).toEqual([]);
    expect(writes).toHaveLength(0);
    expect(await sync.snapshot("s")).toEqual(new Map());
    expect(await sync.syncChanged("bot-1", "s", new Map())).toEqual({
      synced: [],
      failed: [],
    });
  });

  it("writeThrough writes only to the provider (already local)", async () => {
    const { provider, state } = fakeRemote();
    const local: SessionProvider = { ...provider, kind: "local" };
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(local, fn);
    await sync.writeThrough("bot-1", "s", "a.txt", "content");
    expect(state.writeCalls).toEqual([["a.txt", "content"]]);
    expect(writes).toHaveLength(0);
  });
});

describe("SyncEngine.execWithSync (remote)", () => {
  it("copies files created by the exec back to the local workspace", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("stable.txt", "old", 1);
    state.onExec = () => {
      state.setFile("out/result.txt", "fresh", 2);
    };
    const { result, synced } = await sync.execWithSync(
      "bot-1",
      "m-1",
      "make result",
    );
    expect(result).toEqual(OK);
    expect(synced).toEqual(["out/result.txt"]);
    expect(writes).toEqual([["bot-1", "out/result.txt", "fresh"]]);
  });

  it("copies files modified (mtime bump) by the exec", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("data.csv", "v1", 1);
    state.onExec = () => {
      state.setFile("data.csv", "v2", 2);
    };
    const { synced } = await sync.execWithSync("bot-1", "m-1", "update");
    expect(synced).toEqual(["data.csv"]);
    expect(writes).toEqual([["bot-1", "data.csv", "v2"]]);
  });

  it("does not copy untouched files", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("stable.txt", "same", 1);
    const { synced } = await sync.execWithSync("bot-1", "m-1", "true");
    expect(synced).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("checkpoint-syncs intermediate outputs during a long exec", async () => {
    vi.useFakeTimers();
    try {
      const { provider, state } = fakeRemote();
      const { writes, fn } = localWriteSpy();
      const sync = new SyncEngine(provider, fn);

      let finishExec!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishExec = resolve;
      });
      state.onExec = () => gate;

      const pending = sync.execWithSync(
        "bot-1",
        "m-1",
        "long job",
        undefined,
        60_000,
      );
      // Intermediate output appears 10s in...
      await vi.advanceTimersByTimeAsync(10_000);
      state.setFile("partial.txt", "chunk-1", 5);
      // ...and the 60s checkpoint copies it back while the exec still runs.
      await vi.advanceTimersByTimeAsync(50_000);
      expect(writes).toEqual([["bot-1", "partial.txt", "chunk-1"]]);

      // More output, second checkpoint.
      state.setFile("partial.txt", "chunk-1chunk-2", 6);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(writes).toHaveLength(2);

      finishExec();
      const { synced } = await pending;
      // Final sync found nothing new; both checkpoints already copied.
      expect(synced.sort()).toEqual(["partial.txt"]);
      expect(writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops checkpoint polling after the exec completes", async () => {
    vi.useFakeTimers();
    try {
      const { provider, state } = fakeRemote();
      const { writes, fn } = localWriteSpy();
      const sync = new SyncEngine(provider, fn);
      await sync.execWithSync("bot-1", "m-1", "quick", undefined, 60_000);
      state.setFile("later.txt", "x", 9);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("final sync still runs when the exec itself rejects is not required — exec errors propagate after clearing the timer", async () => {
    const { provider, state } = fakeRemote();
    const failing: SessionProvider = {
      ...provider,
      async exec() {
        throw new Error("session died");
      },
    };
    const { fn } = localWriteSpy();
    const sync = new SyncEngine(failing, fn);
    state.setFile("a.txt", "x", 1);
    await expect(sync.execWithSync("bot-1", "m-1", "boom")).rejects.toThrow(
      "session died",
    );
  });
});

describe("SyncEngine.writeThrough (remote)", () => {
  it("writes to the session and immediately to the local workspace", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    await sync.writeThrough("bot-1", "m-1", "notes/plan.md", "# plan");
    expect(state.writeCalls).toEqual([["notes/plan.md", "# plan"]]);
    expect(writes).toEqual([["bot-1", "notes/plan.md", "# plan"]]);
  });
});

describe("SyncEngine.syncChanged baseline maintenance", () => {
  it("updates the baseline so a second call copies nothing", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("a.txt", "v1", 1);
    const baseline = new Map<string, string>();
    expect(await sync.syncChanged("bot-1", "m-1", baseline)).toEqual({
      synced: ["a.txt"],
      failed: [],
    });
    expect(await sync.syncChanged("bot-1", "m-1", baseline)).toEqual({
      synced: [],
      failed: [],
    });
    expect(writes).toHaveLength(1);
  });
});

// F4 regression: one unreadable file (non-UTF-8 / >5MB refusal) must not
// abort the sync-back of the other modified files, and the exec result must
// stay truthful (exec succeeded, sync partial).
describe("SyncEngine per-file failure tolerance (F4)", () => {
  it("syncChanged skips the failing file with a recorded failure and continues", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("a.txt", "alpha", 1);
    state.setFile("bad.bin", " binary", 1);
    state.setFile("z.txt", "zulu", 1);
    state.failReads.set("bad.bin", "file is not valid UTF-8: bad.bin");

    const { synced, failed } = await sync.syncChanged("bot-1", "m-1", new Map());
    expect(synced.sort()).toEqual(["a.txt", "z.txt"]);
    expect(failed).toEqual([
      { path: "bad.bin", error: "file is not valid UTF-8: bad.bin" },
    ]);
    expect(writes.map(([, p]) => p).sort()).toEqual(["a.txt", "z.txt"]);
  });

  it("does not advance the baseline for a failed file, so it retries later", async () => {
    const { provider, state } = fakeRemote();
    const { fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("flaky.txt", "v1", 1);
    state.failReads.set("flaky.txt", "transient outage");

    const baseline = new Map<string, string>();
    const first = await sync.syncChanged("bot-1", "m-1", baseline);
    expect(first.failed).toHaveLength(1);

    state.failReads.delete("flaky.txt");
    const second = await sync.syncChanged("bot-1", "m-1", baseline);
    expect(second).toEqual({ synced: ["flaky.txt"], failed: [] });
  });

  it("execWithSync reports a successful exec with the partial-sync detail", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.onExec = () => {
      state.setFile("good.txt", "fine", 2);
      state.setFile("huge.bin", "x".repeat(10), 2);
      state.failReads.set("huge.bin", "file exceeds the 5MB limit: huge.bin");
    };

    const { result, synced, failed } = await sync.execWithSync(
      "bot-1",
      "m-1",
      "make stuff",
    );
    // Exec stays truthful: it succeeded even though the sync was partial.
    expect(result).toEqual(OK);
    expect(synced).toEqual(["good.txt"]);
    expect(failed).toEqual([
      { path: "huge.bin", error: "file exceeds the 5MB limit: huge.bin" },
    ]);
    expect(writes).toEqual([["bot-1", "good.txt", "fine"]]);
  });

  it("execWithSync survives even a failing final listing without faking an exec failure", async () => {
    const { provider, state } = fakeRemote();
    const { fn } = localWriteSpy();
    let execDone = false;
    const flaky: SessionProvider = {
      ...provider,
      async exec(sessionId, cmd, opts) {
        const r = await provider.exec(sessionId, cmd, opts);
        execDone = true;
        return r;
      },
      async listFiles(sessionId) {
        if (execDone) throw new Error("listing failed");
        return provider.listFiles(sessionId);
      },
    };
    state.setFile("a.txt", "x", 1);
    const sync = new SyncEngine(flaky, fn);
    const { result, failed } = await sync.execWithSync("bot-1", "m-1", "true");
    expect(result).toEqual(OK);
    expect(failed).toEqual([
      { path: "(workspace listing)", error: "listing failed" },
    ]);
  });
});

// F5 regression: a rewrite within the same mtime second at the same size is
// detected via the provider's content hash in the signature.
describe("SyncEngine same-second same-size detection (F5)", () => {
  it("detects a same-second same-size content change when hashes are reported", async () => {
    const { provider, state } = fakeRemote();
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("data.csv", "aaaa", 1000);
    state.onExec = () => {
      // Same mtime second, same byte size, different content.
      state.setFile("data.csv", "bbbb", 1000);
    };
    const { synced } = await sync.execWithSync("bot-1", "m-1", "rewrite");
    expect(synced).toEqual(["data.csv"]);
    expect(writes).toEqual([["bot-1", "data.csv", "bbbb"]]);
  });

  it("documents the residual window: without hashes the change is invisible", async () => {
    // Providers reporting neither a content hash nor sub-second mtimes
    // cannot distinguish this rewrite — the documented residual window.
    const { provider, state } = fakeRemote({ withHashes: false });
    const { writes, fn } = localWriteSpy();
    const sync = new SyncEngine(provider, fn);
    state.setFile("data.csv", "aaaa", 1000);
    state.onExec = () => {
      state.setFile("data.csv", "bbbb", 1000);
    };
    const { synced } = await sync.execWithSync("bot-1", "m-1", "rewrite");
    expect(synced).toEqual([]);
    expect(writes).toEqual([]);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sync-back refuses prompt-influencing paths", () => {
  it("does not write a remote skills/ file into the local workspace", async () => {
    // Sync-back is the one direction where REMOTE-chosen filenames land on
    // the user's machine, and skills/*/SKILL.md is auto-discovered into the
    // bot's system prompt. A compromised session could otherwise install
    // permanent instructions through a completely path-valid write.
    const { provider, state } = fakeRemote();
    const written: string[] = [];
    const sync = new SyncEngine(provider, async (_botId, relPath) => {
      written.push(relPath);
    });
    state.setFile("notes/plan.md", "ordinary work", 1);
    state.setFile("skills/helper/SKILL.md", "---\nname: x\n---\nDo bad things", 1);

    const result = await sync.syncChanged("bot-1", "s-1", new Map());

    expect(written).toEqual(["notes/plan.md"]);
    expect(result.synced).toEqual(["notes/plan.md"]);
    expect(result.failed.map((f) => f.path)).toEqual(["skills/helper/SKILL.md"]);
    expect(result.failed[0]?.error).toContain("not synced back");
  });

  it("reports the refusal once, not on every poll", async () => {
    const { provider, state } = fakeRemote();
    const sync = new SyncEngine(provider, async () => {});
    state.setFile("skills/helper/SKILL.md", "body", 1);
    const baseline = new Map<string, string>();

    expect((await sync.syncChanged("bot-1", "s-1", baseline)).failed).toHaveLength(1);
    expect((await sync.syncChanged("bot-1", "s-1", baseline)).failed).toHaveLength(0);
  });
});
