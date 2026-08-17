import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionLocalExec: vi.fn(),
  workspaceList: vi.fn(),
  workspaceRead: vi.fn(),
  workspaceWrite: vi.fn(),
}));

vi.mock("../native", () => ({
  sessionLocalExec: mocks.sessionLocalExec,
  workspaceList: mocks.workspaceList,
  workspaceRead: mocks.workspaceRead,
  workspaceWrite: mocks.workspaceWrite,
}));

import {
  LOCAL_SESSION_PREFIX,
  LocalSessionProvider,
  localSessionBotId,
} from "./local";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("localSessionBotId", () => {
  it("round-trips the bot id", () => {
    expect(localSessionBotId(`${LOCAL_SESSION_PREFIX}bot-1`)).toBe("bot-1");
  });

  it("rejects non-local session ids", () => {
    expect(() => localSessionBotId("m-abc")).toThrow("not a local session id");
  });
});

describe("LocalSessionProvider", () => {
  const provider = new LocalSessionProvider();

  it("is the local kind and provisions instantly", async () => {
    expect(provider.kind).toBe("local");
    await expect(provider.provision("bot-1")).resolves.toEqual({
      sessionId: "local:bot-1",
      status: "running",
    });
  });

  it("exec delegates to session_local_exec with the bot id", async () => {
    mocks.sessionLocalExec.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: 12,
    });
    const result = await provider.exec("local:bot-1", "echo hi", {
      timeoutMs: 5000,
    });
    expect(mocks.sessionLocalExec).toHaveBeenCalledWith(
      "bot-1",
      "echo hi",
      5000,
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  });

  it("file ops reuse the guarded workspace commands", async () => {
    mocks.workspaceRead.mockResolvedValueOnce("content");
    await expect(provider.readFile("local:bot-1", "a.txt")).resolves.toBe(
      "content",
    );
    expect(mocks.workspaceRead).toHaveBeenCalledWith("bot-1", "a.txt");

    mocks.workspaceWrite.mockResolvedValueOnce(undefined);
    await provider.writeFile("local:bot-1", "b.txt", "data");
    expect(mocks.workspaceWrite).toHaveBeenCalledWith("bot-1", "b.txt", "data");
  });

  it("listFiles filters directories out of the workspace listing", async () => {
    mocks.workspaceList.mockResolvedValueOnce([
      { path: "dir", isDir: true, size: 0 },
      { path: "dir/file.txt", isDir: false, size: 7 },
    ]);
    await expect(provider.listFiles("local:bot-1")).resolves.toEqual([
      { path: "dir/file.txt", size: 7 },
    ]);
  });

  it("stop is a no-op and status is always running", async () => {
    await expect(provider.stop()).resolves.toBeUndefined();
    await expect(provider.status()).resolves.toBe("running");
  });
});
