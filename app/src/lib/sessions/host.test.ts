import { describe, expect, it, vi } from "vitest";
import {
  HOST_SESSION_PREFIX,
  HostSessionProvider,
  MAX_FILE_BYTES,
  WRITE_CHUNK_BYTES,
  hostSessionBotId,
  shQuote,
  validateRelPath,
  workspaceDir,
  type HostExecFn,
} from "./host";
import { LIST_FILES_CMD } from "./fly";

const OK = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
  durationMs: 1,
};

/** utf-8 string → base64 (browser-lib friendly, no Buffer). */
function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → bytes. */
function b64bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fake transport recording every (target, cmd) pair. */
function fakeExec(
  responder: (cmd: string) => Partial<typeof OK> | undefined = () => undefined,
) {
  const calls: { target: string; cmd: string; timeoutMs?: number }[] = [];
  const exec: HostExecFn = async (target, cmd, timeoutMs) => {
    calls.push({ target, cmd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return { ...OK, ...responder(cmd) };
  };
  return { calls, exec };
}

const provider = (exec: HostExecFn, target = "john@minipc.local") =>
  new HostSessionProvider(target, { exec });

describe("helpers", () => {
  it("quotes for the remote POSIX shell, single quotes included", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("a b;rm -rf /")).toBe(`'a b;rm -rf /'`);
  });

  it("validates relative paths like the workspace layer", () => {
    expect(validateRelPath("notes/today.md")).toBe("notes/today.md");
    for (const bad of ["", "/abs", "../up", "a/../b", "a//b", "./x"]) {
      expect(() => validateRelPath(bad)).toThrow();
    }
  });

  it("restricts bot ids that appear unquoted in commands", () => {
    expect(workspaceDir("bot-1_A")).toBe("~/.bots-host/workspace/bot-1_A");
    for (const bad of ["a b", "a;b", "a/../b", "$(x)", ""]) {
      expect(() => workspaceDir(bad)).toThrow();
    }
  });

  it("round-trips session ids", () => {
    expect(hostSessionBotId(`${HOST_SESSION_PREFIX}b1`)).toBe("b1");
    expect(() => hostSessionBotId("fly:b1")).toThrow();
  });
});

describe("provision / exec", () => {
  it("provisions by creating the per-bot workspace dir", async () => {
    const { calls, exec } = fakeExec(() => ({ stdout: "ready\n" }));
    const result = await provider(exec).provision("b1");
    expect(result).toEqual({ sessionId: "host:b1", status: "running" });
    expect(calls[0].target).toBe("john@minipc.local");
    expect(calls[0].cmd).toContain("mkdir -p ~/.bots-host/workspace/b1");
  });

  it("execs with cwd pinned to the bot workspace", async () => {
    const { calls, exec } = fakeExec(() => ({ stdout: "hi\n" }));
    const result = await provider(exec).exec("host:b1", "echo hi", {
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe("hi\n");
    expect(calls[0].cmd).toBe("cd ~/.bots-host/workspace/b1 && (echo hi)");
    expect(calls[0].timeoutMs).toBe(5000);
  });

  it("maps ssh transport failure (exit 255) to a clear error", async () => {
    const { exec } = fakeExec(() => ({
      exitCode: 255,
      stderr: "Connection refused",
    }));
    await expect(provider(exec).exec("host:b1", "echo hi")).rejects.toThrow(
      /unreachable over ssh: Connection refused/,
    );
  });

  it("throws a configuration error when no target is set", async () => {
    const { exec } = fakeExec();
    await expect(provider(exec, "").exec("host:b1", "x")).rejects.toThrow(
      /not configured/,
    );
  });
});

describe("readFile", () => {
  it("reads via base64 and decodes utf-8", async () => {
    const content = "héllo wörld ✓";
    const b64 = b64encode(content);
    const { calls, exec } = fakeExec(() => ({ stdout: `${b64}\n` }));
    const result = await provider(exec).readFile("host:b1", "notes/a.md");
    expect(result).toBe(content);
    expect(calls[0].cmd).toBe(
      "cd ~/.bots-host/workspace/b1 && base64 < 'notes/a.md'",
    );
  });

  it("rejects truncated (oversized) reads instead of clipping silently", async () => {
    const { exec } = fakeExec(() => ({ stdout: "QUJD", truncated: true }));
    await expect(provider(exec).readFile("host:b1", "big.bin")).rejects.toThrow(
      /256KB output cap/,
    );
  });

  it("surfaces read failures with stderr", async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stderr: "No such file" }));
    await expect(provider(exec).readFile("host:b1", "nope.txt")).rejects.toThrow(
      /No such file/,
    );
  });
});

describe("writeFile", () => {
  /** Decode what the recorded commands would have written to the file. */
  function decodeWrites(cmds: string[]): string {
    let chunks: Uint8Array[] = [];
    for (const cmd of cmds) {
      const match = /printf %s '([A-Za-z0-9+/=]*)' \| base64 -d (>>?) /.exec(cmd);
      expect(match, `unparseable write cmd: ${cmd}`).not.toBeNull();
      if (match![2] === ">") chunks = [];
      chunks.push(b64bytes(match![1]));
    }
    const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      total.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(total);
  }

  it("writes small files in one exec, creating parent dirs", async () => {
    const { calls, exec } = fakeExec();
    await provider(exec).writeFile("host:b1", "notes/deep/a.md", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain("mkdir -p 'notes/deep'");
    expect(calls[0].cmd).toContain("> 'notes/deep/a.md'");
    expect(decodeWrites(calls.map((c) => c.cmd))).toBe("hello");
  });

  it("chunks large content by BYTES and reassembles exactly", async () => {
    // Multi-byte chars across the chunk boundary must survive.
    const content = "é".repeat(WRITE_CHUNK_BYTES); // 2 bytes each → 2 chunks+
    const { calls, exec } = fakeExec();
    await provider(exec).writeFile("host:b1", "big.txt", content);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0].cmd).toContain("> 'big.txt'");
    for (const call of calls.slice(1)) {
      expect(call.cmd).toContain(">> 'big.txt'");
    }
    expect(decodeWrites(calls.map((c) => c.cmd))).toBe(content);
  });

  it("writes empty files (single truncating exec)", async () => {
    const { calls, exec } = fakeExec();
    await provider(exec).writeFile("host:b1", "empty.txt", "");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain("> 'empty.txt'");
  });

  it("enforces the 5MB cap before any transport", async () => {
    const { calls, exec } = fakeExec();
    const big = "a".repeat(MAX_FILE_BYTES + 1);
    await expect(
      provider(exec).writeFile("host:b1", "too-big.txt", big),
    ).rejects.toThrow(/5MB cap/);
    expect(calls).toHaveLength(0);
  });
});

describe("listFiles / status / stop", () => {
  it("lists via the shared fly listing command and parser", async () => {
    const { calls, exec } = fakeExec(() => ({
      stdout: "1700000000|5|123|./a.txt\n",
    }));
    const files = await provider(exec).listFiles("host:b1");
    expect(calls[0].cmd).toBe(`cd ~/.bots-host/workspace/b1 && ${LIST_FILES_CMD}`);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("a.txt");
    expect(files[0].size).toBe(5);
  });

  it("status: unconfigured without target, running when the probe answers", async () => {
    const { exec } = fakeExec(() => ({ stdout: "ok\n" }));
    expect(await provider(exec, "").status("host:b1")).toBe("unconfigured");
    expect(await provider(exec).status("host:b1")).toBe("running");
  });

  it("status: error when the host is unreachable", async () => {
    const { exec } = fakeExec(() => ({ exitCode: 255, stderr: "timeout" }));
    expect(await provider(exec).status("host:b1")).toBe("error");
  });

  it("stop is a no-op (persistent host, spec: Personal host sessions)", async () => {
    const { calls, exec } = fakeExec();
    await provider(exec).stop("host:b1", { destroy: true });
    expect(calls).toHaveLength(0);
  });
});

describe("kind", () => {
  it("reports kind 'host'", () => {
    expect(provider(vi.fn() as unknown as HostExecFn).kind).toBe("host");
  });
});
