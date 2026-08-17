// The pose tween (bot-avatars spec, "Ambient eye life"): the eyes hold a
// target and always travel toward it, so nothing ever snaps to a new value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEasedPose, type PoseTarget } from "./hooks";
import { EYE_GEOMETRY } from "./poses";

/** A controllable clock + frame pump, so the tween is deterministic. */
function frameDriver() {
  let now = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    id += 1;
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    callbacks.delete(handle);
  });
  return {
    get now() {
      return now;
    },
    /** Advance by `ms`, running one frame. */
    frame(ms = 16) {
      now += ms;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      act(() => {
        for (const [, cb] of pending) cb(now);
      });
    },
    /** Advance several frames. */
    frames(count: number, ms = 16) {
      for (let i = 0; i < count; i++) this.frame(ms);
    },
  };
}

const at = (x: number, y: number): PoseTarget => ({
  gaze: { x, y },
  geo: EYE_GEOMETRY.open,
});

describe("useEasedPose", () => {
  let clock: ReturnType<typeof frameDriver>;

  beforeEach(() => {
    clock = frameDriver();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts already at its target — mounting is not an animation", () => {
    const { result } = renderHook(() => useEasedPose(at(4, -2), true));
    expect(result.current.gaze).toEqual({ x: 4, y: -2 });
  });

  it("waits a beat before reacting, then closes the gap", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: PoseTarget }) => useEasedPose(target, true),
      { initialProps: { target: at(0, 0) } },
    );

    rerender({ target: at(10, 0) });
    // Inside the reaction delay the eyes have not set off yet.
    clock.frames(3, 16);
    expect(result.current.gaze.x).toBeLessThan(0.5);

    // Past it, they move — but do not arrive instantly.
    clock.frames(4, 40);
    const midway = result.current.gaze.x;
    expect(midway).toBeGreaterThan(0.5);
    expect(midway).toBeLessThan(10);

    clock.frames(40, 40);
    expect(result.current.gaze.x).toBeCloseTo(10, 2);
  });

  it("never jumps: every step is a fraction of what is left", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: PoseTarget }) => useEasedPose(target, true),
      { initialProps: { target: at(0, 0) } },
    );
    rerender({ target: at(10, 0) });
    clock.frames(10, 30); // clear the delay line

    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock.frame(16);
      samples.push(result.current.gaze.x);
    }
    // Monotonic toward the target, each step smaller than the last.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    const first = samples[1] - samples[0];
    const last = samples[samples.length - 1] - samples[samples.length - 2];
    expect(last).toBeLessThan(first);
  });

  it("bends toward a target that moves mid-flight instead of restarting", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: PoseTarget }) => useEasedPose(target, true),
      { initialProps: { target: at(0, 0) } },
    );
    rerender({ target: at(10, 0) });
    clock.frames(8, 30);
    const partway = result.current.gaze.x;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(10);

    // Reverse the target: the eyes carry on from where they are.
    rerender({ target: at(-10, 0) });
    clock.frames(4, 30);
    expect(result.current.gaze.x).toBeLessThan(partway);
    clock.frames(60, 30);
    expect(result.current.gaze.x).toBeCloseTo(-10, 1);
  });

  it("tweens the shape too, not just the position", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: PoseTarget }) => useEasedPose(target, true),
      {
        initialProps: {
          target: { gaze: { x: 0, y: 0 }, geo: EYE_GEOMETRY.open } as PoseTarget,
        },
      },
    );
    rerender({ target: { gaze: { x: 0, y: 0 }, geo: EYE_GEOMETRY.line } });
    clock.frames(6, 30);

    const geo = result.current.geo;
    // Mid-morph: between the two shapes on every axis that differs.
    const lo = Math.min(EYE_GEOMETRY.open.rot, EYE_GEOMETRY.line.rot);
    const hi = Math.max(EYE_GEOMETRY.open.rot, EYE_GEOMETRY.line.rot);
    expect(geo.rot).toBeGreaterThan(lo);
    expect(geo.rot).toBeLessThan(hi);

    clock.frames(60, 30);
    expect(result.current.geo.rot).toBeCloseTo(EYE_GEOMETRY.line.rot, 2);
    expect(result.current.geo.taper).toBeCloseTo(EYE_GEOMETRY.line.taper, 2);
  });

  it("snaps and stops animating when the avatar is inactive", () => {
    const { result, rerender } = renderHook(
      ({ target, active }: { target: PoseTarget; active: boolean }) =>
        useEasedPose(target, active),
      { initialProps: { target: at(0, 0), active: false } },
    );
    rerender({ target: at(9, 0), active: false });
    // Reduced motion / off-screen: show the truth immediately.
    expect(result.current.gaze).toEqual({ x: 9, y: 0 });
  });

  it("stops scheduling frames once it has arrived", () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    const { rerender } = renderHook(
      ({ target }: { target: PoseTarget }) => useEasedPose(target, true),
      { initialProps: { target: at(0, 0) } },
    );
    rerender({ target: at(5, 0) });
    clock.frames(80, 30);
    const settled = raf.mock.calls.length;
    clock.frames(5, 30);
    // A resting avatar costs nothing: no new frames requested.
    expect(raf.mock.calls.length).toBe(settled);
  });
});
