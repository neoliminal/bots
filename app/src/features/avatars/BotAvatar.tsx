import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import "./avatar.css";
import { ballGradientStops } from "./palette";
import {
  EYE_GEOMETRY,
  STATE_POSES,
  peerGaze,
  eyeOutlinePath,
  eyePlacement,
  type EyeGeometry,
  type EyePlacement,
  type EyeShape,
  type Gaze,
} from "./poses";
import { STATE_LABELS, type AvatarState, type BotAvatarProps } from "./types";
import {
  useAmbientLife,
  useAvatarVisibility,
  useCursorGaze,
  useEasedPose,
  usePrefersReducedMotion,
} from "./hooks";

/** How long the one-shot celebration plays before settling to idle. */
export const CELEBRATE_MS = 1200;

/**
 * Error choreography: startled dots + brief shake for this long, then the
 * eyes settle into a determined squint (and the ball stops shaking).
 */
export const ERROR_SETTLE_MS = 1000;

/** Below this size, fine detail (confetti, micro-saccades, zzz) is disabled. */
const DETAIL_MIN_SIZE = 32;

const EYE = {
  leftX: 34,
  rightX: 66,
  y: 42,
  /** Half-length of the eye's spine. */
  half: 10,
};

/** The eye's fill. White on every ball color — that is the point of it. */
export const EYE_FILL = "#ffffff";

/** Outline thickness in SVG units (viewBox is 100 wide). */
export const EYE_OUTLINE_WIDTH = 2;

/**
 * The eye outline color. Dark ink on light and mid balls; on a very dark
 * ball a black outline against a white eye would vanish into the ball and
 * leave a floating white blob, so the outline lightens just enough to read
 * as a deliberate edge.
 *
 * Kept contrast-aware rather than a constant because the palette includes
 * near-black customs, and the outline is what gives the eye its shape at
 * roster size — the taper is invisible without it.
 */
export function eyeStrokeFor(ballColor: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(ballColor.trim());
  if (!m) return "#1f2937";
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.18 ? "#64748b" : "#1f2937";
}

/** Keep transform strings short (and diffs readable). */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

let instanceCounter = 0;

const CONFETTI = [
  { cfx: "-26px", cfy: "-34px", cfr: "-200deg", fill: "#f59e0b" },
  { cfx: "-12px", cfy: "-44px", cfr: "160deg", fill: "#ec4899" },
  { cfx: "4px", cfy: "-46px", cfr: "-140deg", fill: "#22c55e" },
  { cfx: "18px", cfy: "-40px", cfr: "220deg", fill: "#3b82f6" },
  { cfx: "30px", cfy: "-28px", cfr: "-180deg", fill: "#eab308" },
  { cfx: "-32px", cfy: "-20px", cfr: "140deg", fill: "#a855f7" },
] as const;

interface EyeProps {
  /** Where this eye sits on the ball right now, and how it foreshortens. */
  placement: EyePlacement;
  /** The geometry to draw RIGHT NOW — mid-tween, not the target shape. */
  geo: EyeGeometry;
  side: "left" | "right";
  /** Outline color, contrast-picked against the ball color. */
  stroke: string;
}

/**
 * One eye = ONE closed shape: white, outlined in dark ink, with round ends
 * and an optional taper (see `eyeOutlinePath`). Every expression is the same
 * element morphed via CSS-transitionable properties — transform for
 * length/rotation/lift, `d` for thickness, taper and bend — never a swap to
 * a different element kind.
 *
 * The white fill is what makes the eye read at roster sizes against any ball
 * color; the outline is what keeps it from disappearing into a pale one.
 */
function Eye({ placement, geo, side, stroke }: EyeProps) {
  const tilt = side === "left" ? geo.tilt : -geo.tilt;
  const poseTransform = `translateY(${geo.lift}px) rotate(${geo.rot + tilt}deg) scaleX(${geo.scale})`;
  // Placement (where on the sphere) is an SVG transform; the pose (which
  // expression) is a CSS transform on the child, so the two never fight and
  // each keeps its own transition.
  const place = `translate(${round(placement.x)} ${round(placement.y)}) scale(${round(placement.sx)} ${round(placement.sy)})`;
  return (
    <g className="av-eye" data-side={side} transform={place}>
      <g className="av-blinkable">
        <g className="av-pose" style={{ transform: poseTransform }}>
          <path
            className="av-stroke"
            d={eyeOutlinePath(geo, EYE.half)}
            fill={EYE_FILL}
            stroke={stroke}
            strokeLinejoin="round"
            style={{ strokeWidth: EYE_OUTLINE_WIDTH }}
          />
        </g>
      </g>
    </g>
  );
}

/**
 * A Bot's animated ball avatar: colored ball, two minimal stroke eyes that
 * move in tandem, and a distinct animation per runtime state. Pure SVG +
 * CSS — no animation libs.
 */
export function BotAvatar({
  color,
  state,
  size = 64,
  reduceMotion,
  label,
  peerAngle = 0,
  followCursor = false,
  gazeIntensity = 1,
}: BotAvatarProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const visible = useAvatarVisibility(rootRef);
  const prefersReduced = usePrefersReducedMotion();
  const rm = reduceMotion ?? prefersReduced;
  const detail = size >= DETAIL_MIN_SIZE;

  // One-shot celebration: play once, then settle to idle.
  const [celebrationDone, setCelebrationDone] = useState(false);
  useEffect(() => {
    if (state !== "celebrating") {
      setCelebrationDone(false);
      return;
    }
    setCelebrationDone(false);
    const t = setTimeout(() => setCelebrationDone(true), CELEBRATE_MS);
    return () => clearTimeout(t);
  }, [state]);

  // Error choreography: startled dots + brief shake, then settle into a
  // determined squint (the ball may stay still afterwards).
  const [errorSettled, setErrorSettled] = useState(false);
  useEffect(() => {
    if (state !== "error") {
      setErrorSettled(false);
      return;
    }
    setErrorSettled(false);
    const t = setTimeout(() => setErrorSettled(true), ERROR_SETTLE_MS);
    return () => clearTimeout(t);
  }, [state]);

  const effectiveState: AvatarState =
    state === "celebrating" && celebrationDone ? "idle" : state;

  const pose = STATE_POSES[effectiveState];
  // Reduced motion skips the startled pop and shows the settled pose directly.
  const eyeShape: EyeShape =
    effectiveState === "error" && (errorSettled || rm) ? "determined" : pose.eyes;
  const eyeStroke = eyeStrokeFor(color);

  // Vertical gradient fill: lighter top -> base color -> deeper bottom.
  // The id is per-instance so many avatars on one page never collide.
  const reactId = useId();
  const gradientId = useMemo(
    () => `av-ball-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const gradient = useMemo(() => ballGradientStops(color), [color]);
  const running = visible && !rm && effectiveState !== "disconnected";

  const ambient = useAmbientLife({
    active: running && (pose.mode === "wander" || pose.mode === "scan" || pose.blink),
    mode: pose.mode,
    restGaze: pose.gaze,
    blink: pose.blink,
    saccades: detail && pose.mode === "wander",
  });

  // Cursor tracking only replaces ambient wander (idle); blinking and the
  // pose itself are untouched, and ambient wander resumes when the cursor
  // leaves the window.
  const cursorGaze = useCursorGaze(
    rootRef,
    followCursor && running && pose.mode === "wander",
    gazeIntensity,
  );

  const targetGaze: Gaze =
    pose.mode === "peer"
      ? peerGaze(peerAngle)
      : pose.mode === "fixed"
        ? pose.gaze
        : (cursorGaze ?? ambient.gaze);

  // One target — where to look and what shape to be — that the eyes are
  // always travelling toward, so nothing ever snaps to a new value.
  const target = useMemo(
    () => ({ gaze: targetGaze, geo: EYE_GEOMETRY[eyeShape] }),
    [targetGaze.x, targetGaze.y, eyeShape],
  );
  const eased = useEasedPose(target, running);
  const gaze = eased.gaze;

  // Per-instance random phase/duration so avatars never animate in lockstep.
  const inst = useMemo(() => {
    instanceCounter += 1;
    return {
      phase: -(Math.random() * 5),
      durx: 0.85 + Math.random() * 0.3,
    };
  }, []);

  const leanRight = Math.cos((peerAngle * Math.PI) / 180) >= 0;
  const style = {
    width: size,
    height: size,
    "--av-phase": `${inst.phase.toFixed(2)}s`,
    "--av-durx": inst.durx.toFixed(3),
    "--av-lean": leanRight ? "8deg" : "-8deg",
    "--av-nudge": leanRight ? "5%" : "-5%",
  } as CSSProperties;

  const classes = [
    "bot-avatar",
    `av-state-${effectiveState}`,
    `av-eyes-${eyeShape}`,
    rm ? "av-rm" : "",
    !visible ? "av-paused" : "",
    !detail ? "av-low" : "",
    effectiveState === "disconnected" ? "av-dim" : "",
    effectiveState === "error" && (errorSettled || rm) ? "av-error-settled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showConfetti =
    effectiveState === "celebrating" && detail && !rm && visible;
  const showZzz = effectiveState === "sleeping" && detail;

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={`${label} — ${STATE_LABELS[effectiveState]}`}
      className={classes}
      data-state={effectiveState}
      data-eyes={eyeShape}
      data-detail={detail ? "high" : "low"}
      style={style}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient.top} />
            <stop offset="52%" stopColor={gradient.mid} />
            <stop offset="100%" stopColor={gradient.bottom} />
          </linearGradient>
        </defs>
        <g className="av-motion">
          <g className="av-tilt">
            <circle
              className="av-ball"
              data-ball=""
              cx={50}
              cy={50}
              r={44}
              fill={`url(#${gradientId})`}
            />
            {detail && (
              <ellipse
                className="av-gloss"
                data-gloss=""
                cx={35}
                cy={25}
                rx={13}
                ry={7}
                fill="#ffffff"
                opacity={0.3}
              />
            )}
            {/* The pair moves as one, but ON the ball: a single gaze
                rotates the sphere, and each eye is projected onto it, so
                they arc, converge and foreshorten instead of sliding. */}
            <g
              className={`av-eyes${ambient.blinking ? " av-blink" : ""}`}
              data-gaze={`${round(targetGaze.x)},${round(targetGaze.y)}`}
            >
              <Eye
                placement={eyePlacement(EYE.leftX, EYE.y, gaze)}
                geo={eased.geo}
                side="left"
                stroke={eyeStroke}
              />
              <Eye
                placement={eyePlacement(EYE.rightX, EYE.y, gaze)}
                geo={eased.geo}
                side="right"
                stroke={eyeStroke}
              />
            </g>
          </g>
        </g>
        {showConfetti &&
          CONFETTI.map((c, i) => (
            <rect
              key={i}
              className="av-confetti"
              data-confetti=""
              x={48}
              y={8}
              width={4}
              height={6}
              rx={1}
              fill={c.fill}
              style={{ "--cfx": c.cfx, "--cfy": c.cfy, "--cfr": c.cfr } as CSSProperties}
            />
          ))}
        {showZzz &&
          [0, 1, 2].map((i) => (
            <text
              key={i}
              className="av-zzz"
              data-zzz=""
              x={70 + i * 7}
              y={26 - i * 6}
              fontSize={10 + i * 2}
              fontFamily="ui-rounded, system-ui, sans-serif"
              fontWeight={700}
              fill="#94a3b8"
              style={{ "--zd": `${(i * 0.55).toFixed(2)}s` } as CSSProperties}
            >
              z
            </text>
          ))}
      </svg>
    </span>
  );
}
