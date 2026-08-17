import { describe, expect, it } from "vitest";
import {
  AVATAR_PALETTE,
  BOTTOM_DEEPEN,
  TOP_LIGHTEN,
  ballGradientStops,
} from "./palette";

function luminance(hex: string): number {
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("AVATAR_PALETTE", () => {
  it("is the juicy saturated reference set of 8 hex colors", () => {
    expect(AVATAR_PALETTE).toHaveLength(8);
    for (const c of AVATAR_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    // violet, blue, sky, green, orange, pink, red, teal
    expect(AVATAR_PALETTE).toEqual([
      "#8b5cf6",
      "#3b82f6",
      "#0ea5e9",
      "#22c55e",
      "#f97316",
      "#ec4899",
      "#ef4444",
      "#14b8a6",
    ]);
  });
});

describe("ballGradientStops", () => {
  it("keeps the base color as the mid stop", () => {
    for (const c of AVATAR_PALETTE) {
      expect(ballGradientStops(c).mid).toBe(c);
    }
  });

  it("derives a lighter top and a deeper bottom from the base color", () => {
    for (const c of AVATAR_PALETTE) {
      const { top, mid, bottom } = ballGradientStops(c);
      expect(luminance(top)).toBeGreaterThan(luminance(mid));
      expect(luminance(bottom)).toBeLessThan(luminance(mid));
    }
  });

  it("computes stops by mixing toward white/black at the documented ratios", () => {
    // teal #14b8a6 -> r=20, g=184, b=166
    const { top, bottom } = ballGradientStops("#14b8a6");
    const mixTo = (c: number, target: number, t: number) =>
      Math.round(c + (target - c) * t);
    const expectHex = (rgb: number[]) =>
      "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
    expect(top).toBe(
      expectHex([20, 184, 166].map((c) => mixTo(c, 255, TOP_LIGHTEN))),
    );
    expect(bottom).toBe(
      expectHex([20, 184, 166].map((c) => mixTo(c, 0, BOTTOM_DEEPEN))),
    );
  });

  it("supports short hex", () => {
    const { top, mid, bottom } = ballGradientStops("#08f");
    expect(mid).toBe("#08f");
    expect(top).toMatch(/^#[0-9a-f]{6}$/);
    expect(bottom).toMatch(/^#[0-9a-f]{6}$/);
    expect(luminance(top)).toBeGreaterThan(luminance(bottom));
  });

  it("falls back to a flat gradient for non-hex colors", () => {
    expect(ballGradientStops("rebeccapurple")).toEqual({
      top: "rebeccapurple",
      mid: "rebeccapurple",
      bottom: "rebeccapurple",
    });
  });
});
