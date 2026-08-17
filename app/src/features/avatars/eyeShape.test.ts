// Eye outline geometry (bot-avatars spec, "Minimal eyes"): the closed shape
// each eye is drawn as, including the taper that carries expression.

import { describe, expect, it } from "vitest";
import {
  BALL,
  EYE_GEOMETRY,
  EYE_SAMPLES,
  MAX_GAZE_DEG,
  eyeOutlinePath,
  eyePlacement,
  type EyeGeometry,
} from "./poses";

const HALF = 8;

/**
 * The point each command lands on, in order. Parsed per command rather than
 * by scanning number pairs — an arc's leading "rx ry" would otherwise read
 * as a coordinate.
 */
function points(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [, cmd, rawArgs] of d.matchAll(/([MLAZ])([^MLAZ]*)/g)) {
    const args = rawArgs.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "Z") continue;
    // M/L end at their only pair; A ends at its final pair.
    out.push([args[args.length - 2], args[args.length - 1]]);
  }
  return out;
}

/** Thickness of the shape at the spine's start (t=0) and end (t=1). */
function endThicknesses(geo: EyeGeometry): { start: number; end: number } {
  const pts = points(eyeOutlinePath(geo, HALF));
  // Upper edge runs first (samples+1 points), lower edge runs back after the
  // end cap, so the first and last upper/lower pairs sit at the two ends.
  // Order: upper[0..N], then the end cap lands on lower[N], then
  // lower[N-1..0], then the start cap lands back on upper[0] — so the very
  // last point is a repeat of the first, and lower[0] sits just before it.
  const upperStart = pts[0];
  const upperEnd = pts[EYE_SAMPLES];
  const lowerEnd = pts[EYE_SAMPLES + 1];
  const lowerStart = pts[pts.length - 2];
  return {
    start: Math.hypot(upperStart[0] - lowerStart[0], upperStart[1] - lowerStart[1]),
    end: Math.hypot(upperEnd[0] - lowerEnd[0], upperEnd[1] - lowerEnd[1]),
  };
}

const base: EyeGeometry = {
  scale: 1,
  width: 8,
  rot: 90,
  bend: 0,
  lift: 0,
  tilt: 0,
  taper: 1,
};

describe("eyeOutlinePath", () => {
  it("closes the shape and spans the full spine", () => {
    const d = eyeOutlinePath(base, HALF);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const xs = points(d).map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(-HALF, 1);
    expect(Math.max(...xs)).toBeCloseTo(HALF, 1);
  });

  it("is an even capsule when taper is 1", () => {
    const { start, end } = endThicknesses(base);
    expect(start).toBeCloseTo(8, 5);
    expect(end).toBeCloseTo(8, 5);
  });

  it("narrows one end when tapered — the point of the whole thing", () => {
    const { start, end } = endThicknesses({ ...base, taper: 0.5 });
    expect(start).toBeCloseTo(8, 5);
    expect(end).toBeCloseTo(4, 5);
  });

  it("can flare instead of narrow", () => {
    const { start, end } = endThicknesses({ ...base, taper: 1.5 });
    expect(end).toBeGreaterThan(start);
  });

  it("bows the shape when bent, without changing its thickness", () => {
    const straight = points(eyeOutlinePath(base, HALF)).map(([, y]) => y);
    const bent = points(eyeOutlinePath({ ...base, bend: 9 }, HALF)).map(([, y]) => y);
    // The bend lifts the middle of the shape well above the straight one.
    expect(Math.min(...bent)).toBeLessThan(Math.min(...straight));
    const { start, end } = endThicknesses({ ...base, bend: 9 });
    expect(start).toBeCloseTo(8, 1);
    expect(end).toBeCloseTo(8, 1);
  });

  it("gives every shape in the vocabulary the same command sequence", () => {
    // `d` only animates between paths whose commands line up, and the
    // avatars morph expressions rather than swapping them.
    const skeletons = new Set(
      Object.values(EYE_GEOMETRY).map((geo) =>
        eyeOutlinePath(geo, HALF).replace(/-?[\d.]+/g, "#"),
      ),
    );
    expect(skeletons.size).toBe(1);
  });

  it("tapers the expressions that should carry weight, and leaves the rest even", () => {
    // Thinking and resolve lean on the wedge; sleepy lines and happy arcs
    // stay even so they read as calm.
    expect(EYE_GEOMETRY.squint.taper).toBeLessThan(0.8);
    expect(EYE_GEOMETRY.determined.taper).toBeLessThan(0.8);
    expect(EYE_GEOMETRY.line.taper).toBe(1);
    expect(EYE_GEOMETRY.arc.taper).toBe(1);
  });
});

describe("eyePlacement (gaze rides the ball's surface)", () => {
  const LEFT = 34;
  const RIGHT = 66;
  const Y = 42;
  const centre = { x: 0, y: 0 };

  it("rests exactly where the eye was designed to sit", () => {
    const p = eyePlacement(LEFT, Y, centre);
    expect(p.x).toBeCloseTo(LEFT, 6);
    expect(p.y).toBeCloseTo(Y, 6);
    // Foreshortening is normalised to rest, so the designed pose is untouched.
    expect(p.sx).toBeCloseTo(1, 6);
    expect(p.sy).toBeCloseTo(1, 6);
  });

  it("moves both eyes the same way for one gaze", () => {
    const gaze = { x: 3, y: 0 };
    expect(eyePlacement(LEFT, Y, gaze).x).toBeGreaterThan(LEFT);
    expect(eyePlacement(RIGHT, Y, gaze).x).toBeGreaterThan(RIGHT);
  });

  it("converges the pair toward the limb instead of sliding it", () => {
    // A flat translate keeps spacing constant; a sphere does not.
    const spacing = (gx: number) =>
      eyePlacement(RIGHT, Y, { x: gx, y: 0 }).x - eyePlacement(LEFT, Y, { x: gx, y: 0 }).x;
    expect(spacing(6)).toBeLessThan(spacing(0));
    expect(spacing(-6)).toBeLessThan(spacing(0));
  });

  it("squashes the eye as its patch of surface turns away", () => {
    const far = eyePlacement(RIGHT, Y, { x: 8, y: 0 });
    expect(far.sx).toBeLessThan(0.9);
    // Turning horizontally barely affects the vertical dimension.
    expect(far.sy).toBeGreaterThan(far.sx);
  });

  it("keeps the eyes on the visible face however hard the gaze pulls", () => {
    for (const gx of [50, -50, 200]) {
      for (const gy of [50, -50, 200]) {
        const p = eyePlacement(RIGHT, Y, { x: gx, y: gy });
        const fromCentre = Math.hypot(p.x - BALL.cx, p.y - BALL.cy);
        expect(fromCentre).toBeLessThan(BALL.r);
        expect(p.sx).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("stops rotating at the clamp", () => {
    const atClamp = eyePlacement(LEFT, Y, { x: MAX_GAZE_DEG, y: 0 });
    const wayPast = eyePlacement(LEFT, Y, { x: MAX_GAZE_DEG * 10, y: 0 });
    expect(wayPast.x).toBeCloseTo(atClamp.x, 6);
  });

  it("looks down for a positive gaze.y, matching screen coordinates", () => {
    expect(eyePlacement(LEFT, Y, { x: 0, y: 4 }).y).toBeGreaterThan(Y);
    expect(eyePlacement(LEFT, Y, { x: 0, y: -4 }).y).toBeLessThan(Y);
  });
});
