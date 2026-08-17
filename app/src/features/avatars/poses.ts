import type { AvatarState } from "./types";

export interface Gaze {
  x: number;
  y: number;
}

/**
 * Minimal-stroke eye vocabulary. Each eye is always a SINGLE rounded-end
 * stroke (one <path>); every shape below is just different geometry for that
 * same stroke, so state changes morph smoothly (transform / stroke-width / d
 * transitions) instead of hard-swapping elements.
 *
 * - open:       vertical rounded stroke (neutral)
 * - squint:     shorter vertical stroke drifted upward (thinking/effort)
 * - determined: short mirrored-tilt squint (post-error resolve)
 * - tall:       stroke grown tall and slightly thicker (alert/waiting)
 * - dot:        stroke collapsed to a thick dot (startled/alert pop)
 * - line:       horizontal sleepy line (tired/sleeping)
 * - arc:        upward curved stroke (happy/celebrating)
 */
export type EyeShape =
  | "open"
  | "squint"
  | "determined"
  | "tall"
  | "dot"
  | "line"
  | "arc";

/**
 * Geometry for one eye. The spine is a horizontal quadratic
 * `(-half,0) → (half,0)` bowed by `bend`; `eyeOutlinePath` inflates it into
 * a closed, round-ended shape of thickness `width`, optionally tapered. The
 * pose transform is `translateY(lift) rotate(rot ± tilt) scaleX(scale)`, so
 * length, angle and lift still animate as plain CSS transforms.
 */
export interface EyeGeometry {
  /** Scale along the eye's own axis (1 = full length, ~0 = dot). */
  scale: number;
  /** Thickness in SVG units at the start of the spine. */
  width: number;
  /** Rotation in degrees: 90 = vertical eye, 0 = horizontal. */
  rot: number;
  /** Upward bend of the quadratic control point (0 = straight, >0 = arc). */
  bend: number;
  /** Vertical offset of the whole eye in SVG units (negative = up). */
  lift: number;
  /** Mirrored per-eye tilt in degrees (left +tilt, right -tilt). */
  tilt: number;
  /**
   * Thickness at the far end as a multiple of `width`. 1 is an even
   * capsule; below 1 the eye narrows to a wedge, which is where a lot of
   * the expression lives — a determined stare reads very differently from
   * a neutral one purely by where the weight sits. Rotation is 90° for the
   * upright shapes, so the spine runs top → bottom: the taper thins the
   * BOTTOM of an upright eye.
   */
  taper: number;
}

export const EYE_GEOMETRY: Record<EyeShape, EyeGeometry> = {
  open: { scale: 1, width: 10.5, rot: 90, bend: 0, lift: 0, tilt: 0, taper: 0.88 },
  // Thinking: heavy at the top, thinning to a wedge — the shape of a frown
  // of concentration, without needing a brow.
  squint: { scale: 0.46, width: 10, rot: 90, bend: 0, lift: -6, tilt: 7, taper: 0.38 },
  // Resolve: a hard wedge, tilted sharply inward.
  determined: { scale: 0.5, width: 10.5, rot: 90, bend: 0, lift: -4, tilt: 20, taper: 0.3 },
  // Alert: tall, wide, and barely tapered — the eyes are as open as they get.
  tall: { scale: 1.42, width: 11.5, rot: 90, bend: 0, lift: -1.5, tilt: 0, taper: 0.95 },
  dot: { scale: 0.04, width: 13, rot: 90, bend: 0, lift: 0, tilt: 0, taper: 1 },
  line: { scale: 1.05, width: 7.5, rot: 0, bend: 0, lift: 3, tilt: 0, taper: 1 },
  // Happy: fattest in the middle of the arc is not expressible with a single
  // taper, so keep it even and let a deeper bend carry the smile.
  arc: { scale: 1.05, width: 9.5, rot: 0, bend: 12, lift: -3, tilt: 0, taper: 1 },
};

/** Points sampled along the spine per edge. Fixed so every shape's path has
 * the same command count and `d` stays interpolable between expressions. */
export const EYE_SAMPLES = 10;

/**
 * The closed outline of one eye: the spine inflated to `width` thickness at
 * its start and `width × taper` at its end, with round caps at both ends.
 *
 * Built as an explicit polygon-with-arc-caps rather than a stroked line
 * because a stroke cannot vary in width — and the taper is the point. Every
 * shape emits the same sequence of commands (M, L×n, A, L×n, A, Z), which is
 * what lets the browser morph one expression into the next.
 */
export function eyeOutlinePath(geo: EyeGeometry, half: number): string {
  const h0 = geo.width / 2;
  const h1 = (geo.width * geo.taper) / 2;
  const upper: string[] = [];
  const lower: string[] = [];

  for (let i = 0; i <= EYE_SAMPLES; i++) {
    const t = i / EYE_SAMPLES;
    // Quadratic spine: (-half,0) → (half,0) with control (0,-bend).
    const x = half * (2 * t - 1);
    const y = -2 * geo.bend * t * (1 - t);
    // Tangent, then its left normal, normalized.
    const dx = 2 * half;
    const dy = -2 * geo.bend * (1 - 2 * t);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const h = h0 + (h1 - h0) * t;
    upper.push(`${round(x + nx * h)} ${round(y + ny * h)}`);
    lower.push(`${round(x - nx * h)} ${round(y - ny * h)}`);
  }

  const capEnd = `A ${round(h1)} ${round(h1)} 0 0 0 ${lower[lower.length - 1]}`;
  const capStart = `A ${round(h0)} ${round(h0)} 0 0 0 ${upper[0]}`;
  return [
    `M ${upper[0]}`,
    ...upper.slice(1).map((p) => `L ${p}`),
    capEnd,
    ...lower.slice(0, -1).reverse().map((p) => `L ${p}`),
    capStart,
    "Z",
  ].join(" ");
}

/** Trim float noise so paths stay short and diffs stay readable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Gaze on a curved surface
// ---------------------------------------------------------------------------

/** The ball, in viewBox units (see BotAvatar's <circle>). */
export const BALL = { cx: 50, cy: 50, r: 44 };

/** The radius the eyes ride on — just inside the ball's silhouette. */
export const EYE_SPHERE_R = 40;

/** Ball rotation (degrees) per unit of gaze offset. */
export const GAZE_DEG_PER_UNIT = 3.5;

/** Hard limit on rotation, so eyes never slide off the visible face. */
export const MAX_GAZE_DEG = 52;

/** Where one eye lands, and how the surface foreshortens it there. */
export interface EyePlacement {
  /** Projected centre, in viewBox units. */
  x: number;
  y: number;
  /** Foreshortening across the eye's width / height (1 = face-on). */
  sx: number;
  sy: number;
}

function clampDeg(deg: number): number {
  return Math.max(-MAX_GAZE_DEG, Math.min(MAX_GAZE_DEG, deg));
}

/**
 * Place one eye on the ball for a given gaze.
 *
 * The eyes do not slide across a flat disc — they sit ON the ball, so
 * looking around rotates the sphere beneath them: they travel along an arc,
 * draw closer together as they near the limb, and squash as the surface
 * turns away. Without this, a hard look to the side reads as two stickers
 * sliding off the side of a circle.
 *
 * Foreshortening is normalised against the resting pose, so the eyes look
 * exactly as designed when facing forward and only distort as they move.
 */
export function eyePlacement(baseX: number, baseY: number, gaze: Gaze): EyePlacement {
  const R = EYE_SPHERE_R;
  const dx = baseX - BALL.cx;
  const dy = baseY - BALL.cy;
  const z0 = Math.sqrt(Math.max(0, R * R - dx * dx - dy * dy));

  const yaw = (clampDeg(gaze.x * GAZE_DEG_PER_UNIT) * Math.PI) / 180;
  const pitch = (clampDeg(gaze.y * GAZE_DEG_PER_UNIT) * Math.PI) / 180;

  // Rotate the surface point: yaw about the vertical axis, then pitch about
  // the horizontal one. Screen y grows downward, so a positive pitch looks
  // down, matching a positive gaze.y.
  const x1 = dx * Math.cos(yaw) + z0 * Math.sin(yaw);
  const z1 = -dx * Math.sin(yaw) + z0 * Math.cos(yaw);
  const y2 = dy * Math.cos(pitch) + z1 * Math.sin(pitch);
  const z2 = -dy * Math.sin(pitch) + z1 * Math.cos(pitch);

  // Orthographic foreshortening of a small patch at that surface normal.
  const shrink = (a: number, b: number) => Math.hypot(a, b) / R;
  const restSx = shrink(z0, dy);
  const restSy = shrink(z0, dx);

  return {
    x: BALL.cx + x1,
    y: BALL.cy + y2,
    sx: restSx === 0 ? 1 : shrink(z2, y2) / restSx,
    sy: restSy === 0 ? 1 : shrink(z2, x1) / restSy,
  };
}

/** How the tandem gaze behaves in a given state. */
export type GazeMode =
  | "wander" // ambient drifting to random nearby targets
  | "scan" // fast left-right screen-reading darts
  | "peer" // fixed toward the peer avatar (peerAngle prop)
  | "fixed"; // fixed at pose.gaze

export interface StatePose {
  eyes: EyeShape;
  mode: GazeMode;
  /** Tandem pair offset in SVG units when mode is "fixed" (max ~5). */
  gaze: Gaze;
  /** Whether ambient blinking runs in this state. */
  blink: boolean;
}

const CENTER: Gaze = { x: 0, y: 0 };

export const STATE_POSES: Record<AvatarState, StatePose> = {
  idle: { eyes: "open", mode: "wander", gaze: CENTER, blink: true },
  thinking: { eyes: "squint", mode: "fixed", gaze: { x: 1.5, y: -4 }, blink: true },
  working: { eyes: "open", mode: "scan", gaze: { x: -3, y: -1 }, blink: true },
  talkingToUser: { eyes: "open", mode: "fixed", gaze: CENTER, blink: true },
  talkingToBot: { eyes: "open", mode: "peer", gaze: CENTER, blink: true },
  waitingOnUser: { eyes: "tall", mode: "fixed", gaze: { x: 0, y: -0.5 }, blink: true },
  handoff: { eyes: "open", mode: "peer", gaze: CENTER, blink: true },
  error: { eyes: "dot", mode: "fixed", gaze: CENTER, blink: false },
  sleeping: { eyes: "line", mode: "fixed", gaze: CENTER, blink: false },
  celebrating: { eyes: "arc", mode: "fixed", gaze: CENTER, blink: false },
  disconnected: { eyes: "squint", mode: "fixed", gaze: { x: 0, y: 2 }, blink: false },
};

/** Tandem gaze offset toward a peer at `angleDeg` (0 = right, 90 = up). */
export function peerGaze(angleDeg: number, radius = 4.5): Gaze {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(rad) * radius, y: -Math.sin(rad) * radius };
}
