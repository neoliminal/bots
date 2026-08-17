import { describe, expect, it, vi } from "vitest";
import { createRunTracker, DELEGATION_MAX_FAN_OUT } from "./runs";

describe("run tracker (delegation tree)", () => {
  it("tracks runId -> descendants across the delegation tree", () => {
    const tracker = createRunTracker();
    tracker.register("root");
    tracker.register("child-a", { parentRunId: "root" });
    tracker.register("child-b", { parentRunId: "root" });
    tracker.register("grandchild", { parentRunId: "child-a" });

    expect(new Set(tracker.descendants("root"))).toEqual(
      new Set(["child-a", "child-b", "grandchild"]),
    );
    expect(tracker.descendants("child-a")).toEqual(["grandchild"]);
    expect(tracker.descendants("child-b")).toEqual([]);
    expect(tracker.isActive("grandchild")).toBe(true);
  });

  it("aborting the originating run aborts every descendant, deepest first", () => {
    const tracker = createRunTracker();
    const order: string[] = [];
    const abortFor = (id: string) => () => order.push(id);
    tracker.register("root", { abort: abortFor("root") });
    tracker.register("child", { parentRunId: "root", abort: abortFor("child") });
    tracker.register("grandchild", {
      parentRunId: "child",
      abort: abortFor("grandchild"),
    });

    const aborted = tracker.abortTree("root");

    expect(aborted).toEqual(["grandchild", "child", "root"]);
    expect(order).toEqual(["grandchild", "child", "root"]); // no orphaned work
    expect(tracker.isActive("root")).toBe(false);
    expect(tracker.isActive("grandchild")).toBe(false);
  });

  it("aborting a mid-tree run leaves the rest of the tree running", () => {
    const tracker = createRunTracker();
    const rootAbort = vi.fn();
    const siblingAbort = vi.fn();
    const childAbort = vi.fn();
    tracker.register("root", { abort: rootAbort });
    tracker.register("child-a", { parentRunId: "root", abort: childAbort });
    tracker.register("child-b", { parentRunId: "root", abort: siblingAbort });

    tracker.abortTree("child-a");

    expect(childAbort).toHaveBeenCalledTimes(1);
    expect(rootAbort).not.toHaveBeenCalled();
    expect(siblingAbort).not.toHaveBeenCalled();
    expect(tracker.isActive("root")).toBe(true);
    expect(tracker.isActive("child-b")).toBe(true);
  });

  it("abort callbacks fire once even if abortTree is called twice", () => {
    const tracker = createRunTracker();
    const abort = vi.fn();
    tracker.register("root", { abort });
    tracker.abortTree("root");
    tracker.abortTree("root");
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("garbage-collects fully settled subtrees", () => {
    const tracker = createRunTracker();
    tracker.register("root");
    tracker.register("child", { parentRunId: "root" });
    tracker.complete("child");
    expect(tracker.descendants("root")).toEqual([]);
    tracker.complete("root");
    expect(tracker.isActive("root")).toBe(false);
    expect(tracker.descendants("root")).toEqual([]);
  });

  it("counts per-run fan-out", () => {
    const tracker = createRunTracker();
    expect(tracker.fanOutOf("run-1")).toBe(0);
    expect(tracker.noteFanOut("run-1")).toBe(1);
    expect(tracker.noteFanOut("run-1")).toBe(2);
    expect(tracker.noteFanOut("run-1")).toBe(3);
    expect(tracker.fanOutOf("run-1")).toBe(DELEGATION_MAX_FAN_OUT);
    expect(tracker.fanOutOf("run-2")).toBe(0);
  });
});
