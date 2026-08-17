import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
}));

import {
  TRAY_OPEN_EVENT,
  TRAY_PAUSE_ALL_EVENT,
  flyExec,
  flyProvision,
  flyReadFile,
  flyStatus,
  flyStop,
  flyWriteFile,
  isTauri,
  notify,
  onTrayOpen,
  onTrayPauseAll,
  sessionLocalExec,
  setBadgeCount,
  trayUpdate,
  webFetch,
  workspaceDelete,
  workspaceList,
  workspaceListDetailed,
  workspaceRead,
  workspaceWrite,
} from "./index";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function enableTauri(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe("isTauri", () => {
  it("is false without __TAURI_INTERNALS__ and true with it", () => {
    expect(isTauri()).toBe(false);
    enableTauri();
    expect(isTauri()).toBe(true);
  });
});

describe("workspace wrappers (inside Tauri)", () => {
  beforeEach(enableTauri);

  it("workspaceList invokes workspace_list with botId", async () => {
    const entries = [{ path: "a.txt", isDir: false, size: 3 }];
    // The Rust walker caps depth and entry count, so it returns the flag too.
    mocks.invoke.mockResolvedValueOnce({ entries, truncated: false });
    await expect(workspaceList("bot-1")).resolves.toEqual(entries);
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_list", {
      botId: "bot-1",
    });
  });

  it("workspaceListDetailed surfaces the truncation flag", async () => {
    mocks.invoke.mockResolvedValueOnce({ entries: [], truncated: true });
    await expect(workspaceListDetailed("bot-1")).resolves.toEqual({
      entries: [],
      truncated: true,
    });
  });

  it("workspaceRead invokes workspace_read with botId and relPath", async () => {
    mocks.invoke.mockResolvedValueOnce("hello");
    await expect(workspaceRead("bot-1", "notes/a.txt")).resolves.toBe("hello");
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_read", {
      botId: "bot-1",
      relPath: "notes/a.txt",
    });
  });

  it("workspaceWrite invokes workspace_write with content", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await workspaceWrite("bot-1", "a.txt", "body");
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_write", {
      botId: "bot-1",
      relPath: "a.txt",
      content: "body",
    });
  });

  it("workspaceDelete invokes workspace_delete", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await workspaceDelete("bot-1", "a.txt");
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_delete", {
      botId: "bot-1",
      relPath: "a.txt",
    });
  });

  it("propagates rejection from invoke", async () => {
    mocks.invoke.mockRejectedValueOnce("path escapes the bot workspace");
    await expect(workspaceRead("bot-1", "../x")).rejects.toBe(
      "path escapes the bot workspace",
    );
  });
});

describe("webFetch", () => {
  it("invokes web_fetch and returns the result", async () => {
    enableTauri();
    const result = { status: 200, contentType: "text/html", text: "hi" };
    mocks.invoke.mockResolvedValueOnce(result);
    await expect(webFetch("https://example.com/")).resolves.toEqual(result);
    expect(mocks.invoke).toHaveBeenCalledWith("web_fetch", {
      url: "https://example.com/",
    });
  });

  it("returns an empty result outside Tauri", async () => {
    await expect(webFetch("https://example.com/")).resolves.toEqual({
      status: 0,
      contentType: "",
      text: "",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("notify", () => {
  beforeEach(enableTauri);

  it("sends immediately when permission is already granted", async () => {
    mocks.isPermissionGranted.mockResolvedValueOnce(true);
    await expect(notify("Title", "Body")).resolves.toBe(true);
    expect(mocks.requestPermission).not.toHaveBeenCalled();
    expect(mocks.sendNotification).toHaveBeenCalledWith({
      title: "Title",
      body: "Body",
    });
  });

  it("requests permission and sends when granted", async () => {
    mocks.isPermissionGranted.mockResolvedValueOnce(false);
    mocks.requestPermission.mockResolvedValueOnce("granted");
    await expect(notify("T", "B")).resolves.toBe(true);
    expect(mocks.sendNotification).toHaveBeenCalledWith({
      title: "T",
      body: "B",
    });
  });

  it("returns false and does not send when permission is denied", async () => {
    mocks.isPermissionGranted.mockResolvedValueOnce(false);
    mocks.requestPermission.mockResolvedValueOnce("denied");
    await expect(notify("T", "B")).resolves.toBe(false);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("is a no-op outside Tauri", async () => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    await expect(notify("T", "B")).resolves.toBe(false);
    expect(mocks.isPermissionGranted).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

describe("tray", () => {
  it("trayUpdate invokes tray_update with items", async () => {
    enableTauri();
    mocks.invoke.mockResolvedValueOnce(undefined);
    const items = [{ id: "b1", title: "Scout — running" }];
    await trayUpdate(items);
    expect(mocks.invoke).toHaveBeenCalledWith("tray_update", { items });
  });

  it("onTrayPauseAll listens on the pause-all event and forwards fires", async () => {
    enableTauri();
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();
    const result = await onTrayPauseAll(handler);
    expect(mocks.listen).toHaveBeenCalledWith(
      TRAY_PAUSE_ALL_EVENT,
      expect.any(Function),
    );
    const registered = mocks.listen.mock.calls[0][1] as () => void;
    registered();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe(unlisten);
  });

  it("onTrayOpen listens on the open event", async () => {
    enableTauri();
    mocks.listen.mockResolvedValueOnce(vi.fn());
    await onTrayOpen(vi.fn());
    expect(mocks.listen).toHaveBeenCalledWith(
      TRAY_OPEN_EVENT,
      expect.any(Function),
    );
  });

  it("event helpers return a noop unlisten outside Tauri", async () => {
    const unlisten = await onTrayPauseAll(vi.fn());
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});

describe("setBadgeCount", () => {
  it("passes a number through", async () => {
    enableTauri();
    mocks.invoke.mockResolvedValueOnce(undefined);
    await setBadgeCount(4);
    expect(mocks.invoke).toHaveBeenCalledWith("set_badge_count", { count: 4 });
  });

  it("passes null to clear the badge", async () => {
    enableTauri();
    mocks.invoke.mockResolvedValueOnce(undefined);
    await setBadgeCount(null);
    expect(mocks.invoke).toHaveBeenCalledWith("set_badge_count", {
      count: null,
    });
  });

  it("is a no-op outside Tauri", async () => {
    await setBadgeCount(2);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("session bindings (inside Tauri)", () => {
  beforeEach(enableTauri);

  it("sessionLocalExec invokes session_local_exec with camelCase args", async () => {
    const result = {
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: 5,
    };
    mocks.invoke.mockResolvedValueOnce(result);
    await expect(sessionLocalExec("bot-1", "echo ok", 5000)).resolves.toEqual(
      result,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("session_local_exec", {
      botId: "bot-1",
      cmd: "echo ok",
      timeoutMs: 5000,
    });
  });

  it("sessionLocalExec passes null when no timeout is given", async () => {
    mocks.invoke.mockResolvedValueOnce({});
    await sessionLocalExec("bot-1", "true");
    expect(mocks.invoke).toHaveBeenCalledWith("session_local_exec", {
      botId: "bot-1",
      cmd: "true",
      timeoutMs: null,
    });
  });

  it("flyProvision invokes fly_provision", async () => {
    mocks.invoke.mockResolvedValueOnce({ sessionId: "m-1", state: "running" });
    await expect(flyProvision("bot-1")).resolves.toEqual({
      sessionId: "m-1",
      state: "running",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("fly_provision", {
      botId: "bot-1",
    });
  });

  it("flyExec invokes fly_exec", async () => {
    mocks.invoke.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await flyExec("bot-1", "m-1", "ls", 9000);
    // botId travels with every machine command: the Rust side refuses a
    // machine the calling bot does not own.
    expect(mocks.invoke).toHaveBeenCalledWith("fly_exec", {
      botId: "bot-1",
      sessionId: "m-1",
      cmd: "ls",
      timeoutMs: 9000,
    });
  });

  it("fly file ops invoke their commands", async () => {
    mocks.invoke.mockResolvedValueOnce("content");
    await expect(flyReadFile("bot-1", "m-1", "a.txt")).resolves.toBe("content");
    expect(mocks.invoke).toHaveBeenCalledWith("fly_read_file", {
      botId: "bot-1",
      sessionId: "m-1",
      relPath: "a.txt",
    });
    mocks.invoke.mockResolvedValueOnce(undefined);
    await flyWriteFile("bot-1", "m-1", "b.txt", "data");
    expect(mocks.invoke).toHaveBeenCalledWith("fly_write_file", {
      botId: "bot-1",
      sessionId: "m-1",
      relPath: "b.txt",
      content: "data",
    });
  });

  it("flyStop passes destroy through (null when omitted)", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    await flyStop("bot-1", "m-1");
    expect(mocks.invoke).toHaveBeenCalledWith("fly_stop", {
      botId: "bot-1",
      sessionId: "m-1",
      destroy: null,
    });
    mocks.invoke.mockResolvedValueOnce(undefined);
    await flyStop("bot-1", "m-1", true);
    expect(mocks.invoke).toHaveBeenCalledWith("fly_stop", {
      botId: "bot-1",
      sessionId: "m-1",
      destroy: true,
    });
  });

  it("flyStatus unwraps the state and passes an optional session id", async () => {
    mocks.invoke.mockResolvedValueOnce({ state: "running" });
    await expect(flyStatus("bot-1", "m-1")).resolves.toBe("running");
    expect(mocks.invoke).toHaveBeenCalledWith("fly_status", {
      botId: "bot-1",
      sessionId: "m-1",
    });
    mocks.invoke.mockResolvedValueOnce({ state: "unconfigured" });
    await expect(flyStatus()).resolves.toBe("unconfigured");
    expect(mocks.invoke).toHaveBeenCalledWith("fly_status", {
      botId: null,
      sessionId: null,
    });
  });

  it("propagates rejections (e.g. missing FLY_API_TOKEN)", async () => {
    mocks.invoke.mockRejectedValueOnce(
      "Fly compute sessions are not configured",
    );
    await expect(flyExec("bot-1", "m-1", "ls")).rejects.toBe(
      "Fly compute sessions are not configured",
    );
  });
});

describe("session bindings (outside Tauri)", () => {
  it("sessionLocalExec resolves to a stub result without invoking", async () => {
    const result = await sessionLocalExec("bot-1", "echo hi");
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("unavailable outside the desktop app");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("flyProvision rejects — remote sessions cannot be faked", async () => {
    await expect(flyProvision("bot-1")).rejects.toThrow(
      "unavailable outside the desktop app",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("remaining fly bindings degrade to safe defaults", async () => {
    const exec = await flyExec("bot-1", "m-1", "ls");
    expect(exec.exitCode).toBeNull();
    await expect(flyReadFile("bot-1", "m-1", "a.txt")).resolves.toBe("");
    await expect(flyWriteFile("bot-1", "m-1", "a.txt", "x")).resolves.toBeUndefined();
    await expect(flyStop("bot-1", "m-1")).resolves.toBeUndefined();
    await expect(flyStatus()).resolves.toBe("unconfigured");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("workspace wrappers (outside Tauri)", () => {
  it("resolve to safe defaults without invoking", async () => {
    await expect(workspaceList("bot-1")).resolves.toEqual([]);
    await expect(workspaceRead("bot-1", "a.txt")).resolves.toBe("");
    await expect(workspaceWrite("bot-1", "a.txt", "x")).resolves.toBeUndefined();
    await expect(workspaceDelete("bot-1", "a.txt")).resolves.toBeUndefined();
    await expect(trayUpdate([])).resolves.toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
