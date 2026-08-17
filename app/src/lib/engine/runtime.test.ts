import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, DEFAULT_CELEBRATE_MS, DEFAULT_HANDOFF_MS } from "./runtime";
import type { BotRuntimeState } from "./types";

describe("runtime state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults every bot to idle", () => {
    const runtime = createRuntime();
    expect(runtime.getState("b1")).toBe("idle");
    expect(runtime.snapshot()).toEqual({});
  });

  it("sets state and exposes it in the snapshot map", () => {
    const runtime = createRuntime();
    runtime.setState("b1", "thinking");
    runtime.setState("b2", "working");
    expect(runtime.getState("b1")).toBe("thinking");
    expect(runtime.snapshot()).toEqual({ b1: "thinking", b2: "working" });
  });

  it("subscribe emits the current state immediately, then changes", () => {
    const runtime = createRuntime();
    const seen: BotRuntimeState[] = [];
    runtime.subscribe("b1", (s) => seen.push(s));

    runtime.setState("b1", "thinking");
    runtime.setState("b1", "thinking"); // no-op, no duplicate emission
    runtime.setState("b1", "talkingToUser");

    expect(seen).toEqual(["idle", "thinking", "talkingToUser"]);
  });

  it("does not notify other bots' subscribers or after unsubscribe", () => {
    const runtime = createRuntime();
    const seen: BotRuntimeState[] = [];
    const unsubscribe = runtime.subscribe("b1", (s) => seen.push(s));

    runtime.setState("b2", "working");
    unsubscribe();
    runtime.setState("b1", "error");

    expect(seen).toEqual(["idle"]);
  });

  it("celebrate enters celebrating, then settles to idle", () => {
    const runtime = createRuntime();
    runtime.celebrate("b1");
    expect(runtime.getState("b1")).toBe("celebrating");

    vi.advanceTimersByTime(DEFAULT_CELEBRATE_MS);
    expect(runtime.getState("b1")).toBe("idle");
  });

  it("a state change during celebration cancels the settle-to-idle", () => {
    const runtime = createRuntime();
    runtime.celebrate("b1");
    runtime.setState("b1", "thinking"); // new work started mid-celebration

    vi.advanceTimersByTime(DEFAULT_CELEBRATE_MS * 2);
    expect(runtime.getState("b1")).toBe("thinking");
  });

  it("handoff enters handoff briefly, then settles to idle", () => {
    const runtime = createRuntime();
    runtime.handoff("b1");
    expect(runtime.getState("b1")).toBe("handoff");

    vi.advanceTimersByTime(DEFAULT_HANDOFF_MS);
    expect(runtime.getState("b1")).toBe("idle");
  });

  it("settle returns to idle from transient states", () => {
    const runtime = createRuntime();
    runtime.setState("b1", "waitingOnUser");
    runtime.settle("b1");
    expect(runtime.getState("b1")).toBe("idle");
  });

  it("sleeping wins: setBusyState, settle, celebrate, and handoff are no-ops while sleeping", () => {
    const runtime = createRuntime();
    runtime.setState("b1", "sleeping");

    runtime.setBusyState("b1", "thinking");
    expect(runtime.getState("b1")).toBe("sleeping");

    runtime.setBusyState("b1", "waitingOnUser");
    expect(runtime.getState("b1")).toBe("sleeping");

    runtime.settle("b1");
    expect(runtime.getState("b1")).toBe("sleeping");

    runtime.celebrate("b1");
    runtime.handoff("b1");
    expect(runtime.getState("b1")).toBe("sleeping");
    vi.advanceTimersByTime(DEFAULT_CELEBRATE_MS * 2);
    expect(runtime.getState("b1")).toBe("sleeping");
  });

  it("setBusyState drives transitions for a non-sleeping bot", () => {
    const runtime = createRuntime();
    const seen: BotRuntimeState[] = [];
    runtime.subscribe("b1", (s) => seen.push(s));

    runtime.setBusyState("b1", "thinking");
    runtime.setBusyState("b1", "waitingOnUser");
    runtime.setBusyState("b1", "talkingToBot");
    runtime.settle("b1");

    expect(seen).toEqual(["idle", "thinking", "waitingOnUser", "talkingToBot", "idle"]);
  });

  it("pausing (sleeping) during celebration cancels the settle timer", () => {
    const runtime = createRuntime();
    runtime.celebrate("b1");
    runtime.setState("b1", "sleeping");
    vi.advanceTimersByTime(DEFAULT_CELEBRATE_MS * 2);
    expect(runtime.getState("b1")).toBe("sleeping");
  });

  it("clear removes state and listeners", () => {
    const runtime = createRuntime();
    const seen: BotRuntimeState[] = [];
    runtime.subscribe("b1", (s) => seen.push(s));
    runtime.setState("b1", "working");
    runtime.clear("b1");
    runtime.setState("b1", "error");

    expect(seen).toEqual(["idle", "working"]);
    expect(runtime.snapshot()).toEqual({ b1: "error" });
  });
});
