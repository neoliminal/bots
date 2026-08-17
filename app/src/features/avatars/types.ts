/** All runtime states a Bot avatar can render. */
export const AVATAR_STATES = [
  "idle",
  "thinking",
  "working",
  "talkingToUser",
  "talkingToBot",
  "waitingOnUser",
  "handoff",
  "error",
  "sleeping",
  "celebrating",
  "disconnected",
] as const;

export type AvatarState = (typeof AVATAR_STATES)[number];

/** Human-readable state text used in the aria-label ("Scout — thinking"). */
export const STATE_LABELS: Record<AvatarState, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  talkingToUser: "talking to you",
  talkingToBot: "talking to another bot",
  waitingOnUser: "waiting on you",
  handoff: "handing off",
  error: "error",
  sleeping: "sleeping",
  celebrating: "celebrating",
  disconnected: "connection lost",
};

export interface BotAvatarProps {
  /** Ball fill color (any CSS color). */
  color: string;
  /** Current runtime state of the Bot. */
  state: AvatarState;
  /** Rendered size in px (width = height). Default 64. */
  size?: number;
  /**
   * Force reduced-motion rendering (static poses + cross-fades).
   * When omitted, the `prefers-reduced-motion` media query is honored.
   */
  reduceMotion?: boolean;
  /** Bot name used for the accessible label: "{label} — {state}". */
  label: string;
  /**
   * Direction of the peer avatar for talkingToBot/handoff, in degrees.
   * 0 = to the right, 90 = up, 180 = left, 270 = down.
   */
  peerAngle?: number;
  /**
   * In ambient-wander states (idle), track the user's cursor instead of
   * wandering. Meant for the avatar of the active conversation only;
   * ignored in every non-wander state and under reduced motion.
   */
  followCursor?: boolean;
  /**
   * Multiplier on how hard `followCursor` tracks (default 1). The active
   * conversation's row uses a higher value so the bot you are working with
   * visibly watches you, while the rest of the roster stays calm.
   */
  gazeIntensity?: number;
}
