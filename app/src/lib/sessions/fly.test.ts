import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flyProvision: vi.fn(),
  flyExec: vi.fn(),
  flyReadFile: vi.fn(),
  flyWriteFile: vi.fn(),
  flyStop: vi.fn(),
  flyStatus: vi.fn(),
}));

vi.mock("../native", () => ({
  flyProvision: mocks.flyProvision,
  flyExec: mocks.flyExec,
  flyReadFile: mocks.flyReadFile,
  flyWriteFile: mocks.flyWriteFile,
  flyStop: mocks.flyStop,
  flyStatus: mocks.flyStatus,
}));

import { FlySessionProvider, LIST_FILES_CMD, parseListOutput } from "./fly";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("parseListOutput", () => {
  it("parses mtime|size|cksum|path lines into entries with content hashes", () => {
    const stdout =
      "1700000000|12|111|./out/result.txt\n1700000100|3|222|./a.txt\n";
    expect(parseListOutput(stdout)).toEqual([
      { path: "a.txt", size: 3, mtimeMs: 1700000100000, contentHash: "222" },
      {
        path: "out/result.txt",
        size: 12,
        mtimeMs: 1700000000000,
        contentHash: "111",
      },
    ]);
  });

  it("still parses legacy mtime|size|path lines (no hash)", () => {
    expect(parseListOutput("1700000000|12|./out/result.txt\n")).toEqual([
      { path: "out/result.txt", size: 12, mtimeMs: 1700000000000 },
    ]);
  });

  it("skips blank and malformed lines", () => {
    const stdout = "\nnot-a-line\n1700|x|9|./bad-size\n1700000000|5|9|./ok.txt\n";
    expect(parseListOutput(stdout)).toEqual([
      { path: "ok.txt", size: 5, mtimeMs: 1700000000000, contentHash: "9" },
    ]);
  });

  it("keeps paths containing pipes intact", () => {
    expect(parseListOutput("100|4|77|./we|rd.txt")).toEqual([
      { path: "we|rd.txt", size: 4, mtimeMs: 100000, contentHash: "77" },
    ]);
    // Legacy line whose path contains a pipe but is not purely numeric.
    expect(parseListOutput("100|4|./we|rd.txt")).toEqual([
      { path: "we|rd.txt", size: 4, mtimeMs: 100000 },
    ]);
  });

  // F5: the listing command itself must compute the content checksum.
  it("LIST_FILES_CMD includes a cksum per file", () => {
    expect(LIST_FILES_CMD).toContain("cksum");
    expect(LIST_FILES_CMD).toContain("stat -c");
  });
});

describe("FlySessionProvider", () => {
  let provider: FlySessionProvider;

  beforeEach(async () => {
    // Every machine command is bound to the bot that provisioned it (the
    // Rust layer refuses the rest), so the provider learns the owner here.
    provider = new FlySessionProvider();
    mocks.flyProvision.mockResolvedValueOnce({
      sessionId: "m-1",
      state: "running",
    });
    await provider.provision("bot-1");
    mocks.flyProvision.mockReset();
  });

  it("is the fly kind", () => {
    expect(provider.kind).toBe("fly");
  });

  it("provision maps the native result", async () => {
    mocks.flyProvision.mockResolvedValueOnce({
      sessionId: "m-1",
      state: "running",
    });
    await expect(provider.provision("bot-2")).resolves.toEqual({
      sessionId: "m-1",
      status: "running",
    });
    expect(mocks.flyProvision).toHaveBeenCalledWith("bot-2");
  });

  it("exec maps the native result and passes the timeout", async () => {
    mocks.flyExec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "o",
      stderr: "e",
    });
    const result = await provider.exec("m-1", "ls", { timeoutMs: 9000 });
    expect(mocks.flyExec).toHaveBeenCalledWith("bot-1", "m-1", "ls", 9000);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "o",
      stderr: "e",
      truncated: false,
      timedOut: false,
    });
  });

  it("file ops delegate to the native fly commands", async () => {
    mocks.flyReadFile.mockResolvedValueOnce("data");
    await expect(provider.readFile("m-1", "a.txt")).resolves.toBe("data");
    expect(mocks.flyReadFile).toHaveBeenCalledWith("bot-1", "m-1", "a.txt");

    mocks.flyWriteFile.mockResolvedValueOnce(undefined);
    await provider.writeFile("m-1", "b.txt", "content");
    expect(mocks.flyWriteFile).toHaveBeenCalledWith(
      "bot-1",
      "m-1",
      "b.txt",
      "content",
    );
  });

  it("listFiles runs the stat command and parses the output", async () => {
    mocks.flyExec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "1700000000|2|345|./x.txt\n",
      stderr: "",
    });
    await expect(provider.listFiles("m-1")).resolves.toEqual([
      { path: "x.txt", size: 2, mtimeMs: 1700000000000, contentHash: "345" },
    ]);
    expect(mocks.flyExec).toHaveBeenCalledWith(
      "bot-1",
      "m-1",
      LIST_FILES_CMD,
      undefined,
    );
  });

  it("listFiles throws when the listing command fails", async () => {
    mocks.flyExec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    await expect(provider.listFiles("m-1")).rejects.toThrow(
      "cannot list session files: boom",
    );
  });

  it("stop passes destroy through", async () => {
    mocks.flyStop.mockResolvedValue(undefined);
    await provider.stop("m-1");
    expect(mocks.flyStop).toHaveBeenCalledWith("bot-1", "m-1", undefined);
    await provider.stop("m-1", { destroy: true });
    expect(mocks.flyStop).toHaveBeenCalledWith("bot-1", "m-1", true);
  });

  it("refuses commands for a machine it never provisioned", async () => {
    // Cross-bot access: one bot exec-ing inside another bot's session, or
    // destroying a machine it does not own, is refused before any HTTP call.
    await expect(provider.exec("someone-elses-machine", "cat /workspace/*"))
      .rejects.toThrow(/unknown session/);
    await expect(
      provider.stop("someone-elses-machine", { destroy: true }),
    ).rejects.toThrow(/unknown session/);
    expect(mocks.flyExec).not.toHaveBeenCalled();
    expect(mocks.flyStop).not.toHaveBeenCalled();
  });

  it("status maps machine states and unknown states become error", async () => {
    mocks.flyStatus.mockResolvedValueOnce("running");
    await expect(provider.status("m-1")).resolves.toBe("running");
    mocks.flyStatus.mockResolvedValueOnce("weird");
    await expect(provider.status("m-1")).resolves.toBe("error");
  });

  it("providerStatus reports unconfigured cleanly without a token", async () => {
    mocks.flyStatus.mockResolvedValueOnce("unconfigured");
    await expect(provider.providerStatus()).resolves.toBe("unconfigured");
    expect(mocks.flyStatus).toHaveBeenCalledWith();
  });

  it("providerStatus reports none (no session yet) when configured", async () => {
    mocks.flyStatus.mockResolvedValueOnce("ready");
    await expect(provider.providerStatus()).resolves.toBe("none");
  });
});
