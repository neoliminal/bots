import { useEffect, useRef, useState, type RefObject } from "react";
import type { EyeGeometry, Gaze, GazeMode } from "./poses";

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * True while the element is on screen AND the document is visible.
 * Falls back to "visible" where IntersectionObserver is unavailable (jsdom).
 */
export function useAvatarVisibility(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return inView && pageVisible;
}

/** Tracks the prefers-reduced-motion media query (false where unsupported). */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** Max tandem gaze offset in SVG units when tracking the cursor. */
const CURSOR_GAZE_RADIUS = 4.5;
/** Cursor distance (px) at which the gaze reaches full deflection. */
const CURSOR_GAZE_RANGE = 120;

/**
 * Gaze target that tracks the pointer: the offset points from the avatar's
 * center toward the cursor, ramping up to full deflection over
 * CURSOR_GAZE_RANGE px. Updates are rAF-coalesced. Returns null while
 * inactive or before the pointer has moved (callers fall back to ambient
 * wander), and resets to null when the pointer leaves the window.
 */
export function useCursorGaze(
  ref: RefObject<Element | null>,
  active: boolean,
  /**
   * How hard the eyes track. 1 is the ambient follow used in the thread
   * header. Above 1 the eyes swing further AND lock on from further away —
   * the avatar you are actually talking to should feel like it is watching
   * you, not idly noticing you.
   */
  intensity = 1,
): Gaze | null {
  const [gaze, setGaze] = useState<Gaze | null>(null);

  useEffect(() => {
    if (!active) {
      setGaze(null);
      return;
    }
    let frame = 0;
    let last: { x: number; y: number } | null = null;

    const apply = () => {
      frame = 0;
      const el = ref.current;
      if (!el || !last) return;
      const rect = el.getBoundingClientRect();
      const dx = last.x - (rect.left + rect.width / 2);
      const dy = last.y - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        setGaze({ x: 0, y: 0 });
        return;
      }
      const radius = CURSOR_GAZE_RADIUS * intensity;
      const range = CURSOR_GAZE_RANGE * intensity;
      const deflect = radius * Math.min(1, dist / range);
      setGaze({ x: (dx / dist) * deflect, y: (dy / dist) * deflect });
    };

    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      last = null;
      setGaze(null);
    };

    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
      setGaze(null);
    };
  }, [ref, active, intensity]);

  return gaze;
}

export interface AmbientLifeOptions {
  /** Master switch: false stops every timer (hidden, reduced motion, …). */
  active: boolean;
  mode: GazeMode;
  /** Gaze used when mode is not an ambient one (fixed/peer), or while inactive. */
  restGaze: Gaze;
  blink: boolean;
  /** Enable micro-saccades (disabled at small sizes / reduced motion). */
  saccades: boolean;
}

export interface AmbientLife {
  gaze: Gaze;
  blinking: boolean;
}

const SCAN_PATTERN: readonly Gaze[] = [
  { x: -4, y: -1.5 },
  { x: -1, y: -1.5 },
  { x: 2, y: -1.5 },
  { x: 4.5, y: -1 },
  { x: -4.5, y: 0.5 },
  { x: -1, y: 0.5 },
  { x: 2.5, y: 0.5 },
  { x: 4, y: 1 },
];

/**
 * Ambient eye life: wandering gaze / scanning darts, micro-saccades and
 * randomized blinking (~2–8 s). All timers are per-instance randomized so two
 * avatars never animate in lockstep, and every timer stops when `active` is
 * false.
 */
export function useAmbientLife(opts: AmbientLifeOptions): AmbientLife {
  const { active, mode, blink, saccades } = opts;
  const restGaze = opts.restGaze;
  const [gaze, setGaze] = useState<Gaze>(restGaze);
  const [saccade, setSaccade] = useState<Gaze>({ x: 0, y: 0 });
  const [blinking, setBlinking] = useState(false);
  // Random per-instance phase so identical mounts still desynchronize.
  const seed = useRef(Math.random());

  // Base gaze target.
  useEffect(() => {
    if (!active || (mode !== "wander" && mode !== "scan")) {
      setGaze(restGaze);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let scanIndex = Math.floor(seed.current * SCAN_PATTERN.length);

    const tick = () => {
      if (cancelled) return;
      if (mode === "scan") {
        scanIndex = (scanIndex + 1) % SCAN_PATTERN.length;
        setGaze(SCAN_PATTERN[scanIndex]);
        timer = setTimeout(tick, rand(180, 420));
      } else {
        setGaze({ x: rand(-4, 4), y: rand(-3, 3) });
        timer = setTimeout(tick, rand(900, 3200));
      }
    };
    timer = setTimeout(tick, rand(0, mode === "scan" ? 300 : 1200));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // restGaze is a stable pose constant per state; state changes flow through `mode`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, restGaze.x, restGaze.y]);

  // Micro-saccades: tiny fast jitters layered on the base gaze.
  useEffect(() => {
    if (!active || !saccades || mode === "scan") {
      setSaccade({ x: 0, y: 0 });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      setSaccade({ x: rand(-0.7, 0.7), y: rand(-0.5, 0.5) });
      timer = setTimeout(tick, rand(280, 900));
    };
    timer = setTimeout(tick, rand(100, 600));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, saccades, mode]);

  // Randomized blinking every ~2–8 s.
  useEffect(() => {
    if (!active || !blink) {
      setBlinking(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        timer = setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          schedule();
        }, 130);
      }, rand(2000, 8000));
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, blink]);

  return {
    gaze: { x: gaze.x + saccade.x, y: gaze.y + saccade.y },
    blinking,
  };
}

// ---------------------------------------------------------------------------
// Eased pose: one target, always chased
// ---------------------------------------------------------------------------

/** Reaction lag before the eyes start following a new target (ms). */
export const POSE_DELAY_MS = 110;

/** Time for the remaining distance to a target to halve (ms). */
export const GAZE_HALF_LIFE_MS = 90;
export const SHAPE_HALF_LIFE_MS = 130;

/** What the eyes are aiming at: where to look, and what shape to be. */
export interface PoseTarget {
  gaze: Gaze;
  geo: EyeGeometry;
}

const GEO_KEYS = [
  "scale",
  "width",
  "rot",
  "bend",
  "lift",
  "tilt",
  "taper",
] as const satisfies readonly (keyof EyeGeometry)[];

/** Below this, a value has arrived and the loop can stop burning frames. */
const SETTLED = 0.005;

function easeTo(current: number, target: number, dt: number, halfLife: number): number {
  const k = 1 - Math.pow(2, -dt / halfLife);
  return current + (target - current) * k;
}

function poseDistance(a: PoseTarget, b: PoseTarget): number {
  let d = Math.abs(a.gaze.x - b.gaze.x) + Math.abs(a.gaze.y - b.gaze.y);
  for (const key of GEO_KEYS) d += Math.abs(a.geo[key] - b.geo[key]);
  return d;
}

/**
 * The pose the eyes are actually in, always travelling toward the pose they
 * want to be in — never jumping to it.
 *
 * Two separate ideas, both of which the eyes need to feel alive:
 *
 * - **Lag.** A new target is not adopted for `delayMs`; the eyes keep
 *   heading where they were going. This is reaction time, and it is what
 *   stops the gaze from feeling welded to the cursor. It is a true delay
 *   line, not a "wait until the target stops changing" gate — the latter
 *   would freeze the eyes solid while the mouse kept moving.
 * - **Chase.** Position AND shape ease toward the lagged target by a fixed
 *   fraction of the remaining distance each frame, so a target that changes
 *   mid-flight simply bends the path rather than restarting it.
 *
 * The loop stops once everything has arrived, so a resting avatar costs
 * nothing. Mounting snaps to the target (no swoop-in), and so does reduced
 * motion or an inactive avatar.
 */
export function useEasedPose(
  target: PoseTarget,
  active: boolean,
  options: { delayMs?: number; gazeHalfLifeMs?: number; shapeHalfLifeMs?: number } = {},
): PoseTarget {
  const delayMs = options.delayMs ?? POSE_DELAY_MS;
  const gazeHalfLife = options.gazeHalfLifeMs ?? GAZE_HALF_LIFE_MS;
  const shapeHalfLife = options.shapeHalfLifeMs ?? SHAPE_HALF_LIFE_MS;

  const [pose, setPose] = useState<PoseTarget>(target);
  const currentRef = useRef<PoseTarget>(target);
  /** Recent targets with the time they were set — the delay line. */
  const historyRef = useRef<Array<{ at: number; target: PoseTarget }>>([]);
  const frameRef = useRef(0);
  const lastRef = useRef(0);

  // Record every target the render produces, so the loop can look up what
  // was being aimed at `delayMs` ago.
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const history = historyRef.current;
  const latest = history[history.length - 1];
  if (!latest || poseDistance(latest.target, target) > SETTLED) {
    history.push({ at: now, target });
    if (history.length > 240) history.shift();
  }

  useEffect(() => {
    if (!active) {
      // Snap: an avatar that is paused, off-screen, or honouring reduced
      // motion should show the truth, not a frozen half-finished tween.
      currentRef.current = target;
      historyRef.current = [];
      setPose(target);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      return;
    }

    const step = (t: number) => {
      frameRef.current = 0;
      const dt = Math.min(64, lastRef.current === 0 ? 16 : t - lastRef.current);
      lastRef.current = t;

      // The target as it was `delayMs` ago.
      const entries = historyRef.current;
      const cutoff = t - delayMs;
      let lagged = entries[0]?.target ?? target;
      for (const entry of entries) {
        if (entry.at <= cutoff) lagged = entry.target;
        else break;
      }
      while (entries.length > 1 && entries[1].at <= cutoff) entries.shift();

      const from = currentRef.current;
      const next: PoseTarget = {
        gaze: {
          x: easeTo(from.gaze.x, lagged.gaze.x, dt, gazeHalfLife),
          y: easeTo(from.gaze.y, lagged.gaze.y, dt, gazeHalfLife),
        },
        geo: { ...from.geo },
      };
      for (const key of GEO_KEYS) {
        next.geo[key] = easeTo(from.geo[key], lagged.geo[key], dt, shapeHalfLife);
      }

      // Arrived: land exactly on the target rather than crawling forever.
      if (poseDistance(next, lagged) <= SETTLED) {
        currentRef.current = lagged;
        setPose(lagged);
        lastRef.current = 0;
        // Still frames to run if the newest target is not the lagged one.
        if (poseDistance(lagged, target) > SETTLED) {
          frameRef.current = requestAnimationFrame(step);
        }
        return;
      }

      currentRef.current = next;
      setPose(next);
      frameRef.current = requestAnimationFrame(step);
    };

    if (!frameRef.current) frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      lastRef.current = 0;
    };
  }, [active, target, delayMs, gazeHalfLife, shapeHalfLife]);

  return active ? pose : target;
}
