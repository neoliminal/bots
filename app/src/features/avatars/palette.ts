// Curated bot colors + ball gradient derivation (spec: openspec/specs/bot-avatars,
// look: docs/design/visual-style.md "Avatars"). Owned by the avatars feature and
// exported so the bot editor can consume the palette without owning it.

/**
 * Juicy, saturated reference palette (violet, blue, sky, green, orange, pink,
 * red, teal). Each entry is the MID gradient color — the bot's canonical hex.
 */
export const AVATAR_PALETTE = [
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#22c55e", // green
  "#f97316", // orange
  "#ec4899", // pink
  "#ef4444", // red
  "#14b8a6", // teal
] as const;

/** The three vertical gradient stops derived from a bot's base color. */
export interface BallGradientStops {
  /** Lighter, desaturated-toward-white version of the color (ball top). */
  top: string;
  /** The bot's base color itself (ball middle). */
  mid: string;
  /** Slightly deeper version of the color (ball bottom). */
  bottom: string;
}

/** Fraction of white mixed into the base color for the top stop. */
export const TOP_LIGHTEN = 0.38;
/** Fraction of black mixed into the base color for the bottom stop. */
export const BOTTOM_DEEPEN = 0.18;

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function mixChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

function mixHex(rgb: [number, number, number], target: number, t: number): string {
  return (
    "#" +
    rgb
      .map((c) => mixChannel(c, target, t).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Compute the vertical gradient stops for a ball color: lighter/desaturated
 * toward white at the top, the color itself in the middle, slightly deeper at
 * the bottom. Colors that aren't parseable hex fall back to a flat gradient
 * (all three stops the input color), so any CSS color still renders.
 */
export function ballGradientStops(color: string): BallGradientStops {
  const rgb = parseHex(color);
  if (!rgb) return { top: color, mid: color, bottom: color };
  return {
    top: mixHex(rgb, 255, TOP_LIGHTEN),
    mid: color.trim().toLowerCase(),
    bottom: mixHex(rgb, 0, BOTTOM_DEEPEN),
  };
}
