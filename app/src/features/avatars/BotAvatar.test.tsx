import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotAvatar, CELEBRATE_MS, ERROR_SETTLE_MS, eyeStrokeFor } from "./BotAvatar";
import { AVATAR_STATES, STATE_LABELS, type AvatarState } from "./types";
import { ballGradientStops } from "./palette";
import type { EyeShape } from "./poses";

const renderAvatar = (state: AvatarState, extra: Partial<Parameters<typeof BotAvatar>[0]> = {}) =>
  render(<BotAvatar color="#14b8a6" state={state} label="Scout" {...extra} />);

afterEach(() => {
  vi.useRealTimers();
});

describe("BotAvatar aria", () => {
  it.each(AVATAR_STATES)("renders %s with accessible label", (state) => {
    renderAvatar(state);
    const el = screen.getByRole("img");
    expect(el).toHaveAccessibleName(`Scout — ${STATE_LABELS[state]}`);
  });

  it("reads like 'Scout — thinking' for thinking", () => {
    renderAvatar("thinking");
    expect(screen.getByRole("img")).toHaveAccessibleName("Scout — thinking");
  });
});

describe("state -> class/pose mapping", () => {
  it.each(AVATAR_STATES)("applies av-state-%s and pose data", (state) => {
    renderAvatar(state);
    const el = screen.getByRole("img");
    expect(el).toHaveClass(`av-state-${state}`);
    expect(el).toHaveAttribute("data-state", state);
  });

  it("maps minimal-stroke eye shapes per state", () => {
    const expected: Array<[AvatarState, EyeShape]> = [
      ["idle", "open"],
      ["thinking", "squint"],
      ["working", "open"],
      ["talkingToUser", "open"],
      ["talkingToBot", "open"],
      ["waitingOnUser", "tall"],
      ["handoff", "open"],
      ["error", "dot"],
      ["sleeping", "line"],
      ["celebrating", "arc"],
      ["disconnected", "squint"],
    ];
    for (const [state, eyes] of expected) {
      const { unmount } = renderAvatar(state);
      expect(screen.getByRole("img")).toHaveAttribute("data-eyes", eyes);
      unmount();
    }
  });

  it.each(AVATAR_STATES)("exposes a morph class av-eyes-* for %s", (state) => {
    renderAvatar(state);
    const el = screen.getByRole("img");
    const eyes = el.getAttribute("data-eyes");
    expect(eyes).toBeTruthy();
    expect(el).toHaveClass(`av-eyes-${eyes}`);
  });
});

describe("eye anatomy (white shape, dark outline, no cartoon eyeballs)", () => {
  it.each(AVATAR_STATES)("renders each eye as one filled outlined shape in %s", (state) => {
    const { container } = renderAvatar(state, { size: 64 });
    const eyes = container.querySelectorAll(".av-eye");
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      // Exactly ONE closed path per eye: white, outlined, no separate
      // pupil/iris parts — expression is the shape itself.
      const paths = eye.querySelectorAll("path");
      expect(paths).toHaveLength(1);
      const path = paths[0];
      expect(path.getAttribute("fill")).toBe("#ffffff");
      expect(path.getAttribute("stroke")).toBeTruthy();
      expect(path.getAttribute("d")).toMatch(/^M .* Z$/);
      expect(eye.querySelectorAll("circle, ellipse, clipPath, rect")).toHaveLength(0);
    }
    expect(container.querySelectorAll(".av-pupil")).toHaveLength(0);
    expect(container.querySelectorAll("clipPath")).toHaveLength(0);
  });

  it("keeps every expression's path interpolable (same command shape)", () => {
    // Expressions morph by transitioning `d`, which only interpolates when
    // the command sequence matches — so this is load-bearing, not cosmetic.
    const commandsFor = (state: (typeof AVATAR_STATES)[number]) => {
      const { container } = renderAvatar(state, { size: 64 });
      const d = container.querySelector(".av-eye path")!.getAttribute("d")!;
      return d.replace(/-?[\d.]+/g, "#");
    };
    const shapes = new Set(AVATAR_STATES.map(commandsFor));
    expect(shapes.size).toBe(1);
  });
});

/** Parse an eye's `translate(x y) scale(sx sy)` placement transform. */
function placementOf(eye: SVGGElement) {
  const t = eye.getAttribute("transform") ?? "";
  const [x, y] = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(t)!.slice(1).map(Number);
  const [sx, sy] = /scale\((-?[\d.]+) (-?[\d.]+)\)/.exec(t)!.slice(1).map(Number);
  return { x, y, sx, sy };
}

describe("tandem eye movement", () => {
  it("moves both eyes with one shared gaze transform", () => {
    // thinking has a deterministic fixed gaze of {x: 1.5, y: -4}.
    const { container } = renderAvatar("thinking");
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    expect(pair).not.toBeNull();
    expect(pair!.getAttribute("data-gaze")).toBe("1.5,-4");
    // Both eyes live inside the single gaze group.
    expect(pair!.querySelectorAll(".av-eye")).toHaveLength(2);
  });

  it("rests each eye at its designed spot, face-on", () => {
    const { container } = renderAvatar("talkingToUser"); // fixed gaze at centre
    const eyes = [...container.querySelectorAll<SVGGElement>(".av-eye")];
    expect(eyes).toHaveLength(2);
    const [left, right] = eyes.map((e) => placementOf(e));
    expect(left.x).toBeCloseTo(34, 2);
    expect(right.x).toBeCloseTo(66, 2);
    expect(left.y).toBeCloseTo(42, 2);
    // Foreshortening is normalised to the resting pose, so no squash here.
    expect(left.sx).toBeCloseTo(1, 3);
    expect(left.sy).toBeCloseTo(1, 3);
  });

  it("carries the eyes around the ball, not across it", () => {
    // thinking looks up-and-slightly-right ({x: 1.5, y: -4}).
    const { container } = renderAvatar("thinking");
    const [left, right] = [...container.querySelectorAll<SVGGElement>(".av-eye")].map(
      (e) => placementOf(e),
    );
    // Both eyes moved the same way — one gaze, one rotation…
    expect(left.x).toBeGreaterThan(34);
    expect(right.x).toBeGreaterThan(66);
    expect(left.y).toBeLessThan(42);
    // …and the far eye foreshortens as the surface turns away, which a flat
    // translate could never do.
    expect(right.sx).toBeLessThan(1);
  });

  it("draws the eyes together as they near the limb", () => {
    const spacingAt = (state: "talkingToUser" | "working") => {
      const { container } = renderAvatar(state);
      const [l, r] = [...container.querySelectorAll<SVGGElement>(".av-eye")].map((e) =>
        placementOf(e),
      );
      return r.x - l.x;
    };
    // working looks off to the left ({x: -3}); resting is face-on.
    expect(spacingAt("working")).toBeLessThan(spacingAt("talkingToUser"));
  });

  it("aims the tandem pair at the peer for talkingToBot", () => {
    const { container } = renderAvatar("talkingToBot", { peerAngle: 180 });
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    // peerGaze(180) = { x: -4.5, y: ~0 }
    expect(pair!.getAttribute("data-gaze")).toMatch(/^-4\.5,/);
    expect(pair!.querySelectorAll(".av-eye")).toHaveLength(2);
  });
});

describe("cursor following (followCursor)", () => {
  // jsdom rects are all zeros, so the avatar center is (0,0) and pointer
  // coords are the gaze direction directly. rAF is stubbed to run inline.
  const stubRaf = () => {
    // Runs the callback inline so the cursor hook applies without waiting a
    // frame — but NOT re-entrantly: the pose tween re-schedules itself every
    // frame, and an inline stub would recurse until the stack blew. Dropping
    // the nested request leaves the tween parked partway, which is fine here:
    // these tests assert the TARGET the eyes are aiming at, not the
    // in-between position.
    let inCallback = false;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (inCallback) return 0;
      inCallback = true;
      try {
        cb(0);
      } finally {
        inCallback = false;
      }
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  };
  afterEach(() => vi.unstubAllGlobals());

  const pointerMove = (clientX: number, clientY: number) => {
    act(() => {
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX, clientY }),
      );
    });
  };

  it("aims the idle gaze at the cursor, ramping with distance", () => {
    stubRaf();
    const { container } = renderAvatar("idle", { followCursor: true });
    // 100px right of center: deflection = 4.5 * min(1, 100/120) = 3.75.
    pointerMove(100, 0);
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    expect(pair!.getAttribute("data-gaze")).toBe("3.75,0");
    // Beyond full range the deflection caps at the 4.5-unit radius.
    pointerMove(0, 500);
    expect(pair!.getAttribute("data-gaze")).toBe("0,4.5");
  });

  it("tracks harder at higher intensity — further swing, longer reach", () => {
    stubRaf();
    const { container } = renderAvatar("idle", {
      followCursor: true,
      gazeIntensity: 2,
    });
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    // Same 100px as the ambient case, but the ramp is twice as long, so the
    // eyes are only half-way up a radius that is itself twice as big:
    // 9 * min(1, 100/240) = 3.75 — the same deflection from twice the
    // distance is the point.
    pointerMove(100, 0);
    expect(pair!.getAttribute("data-gaze")).toBe("3.75,0");
    // Where the ambient follow has long since capped at 4.5, this is still
    // climbing, and tops out twice as far out.
    pointerMove(500, 0);
    expect(pair!.getAttribute("data-gaze")).toBe("9,0");
  });

  it("ignores the cursor in non-wander states", () => {
    stubRaf();
    const { container } = renderAvatar("thinking", { followCursor: true });
    pointerMove(100, 0);
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    // thinking keeps its fixed pose gaze.
    expect(pair!.getAttribute("data-gaze")).toBe("1.5,-4");
  });

  it("ignores the cursor under reduced motion", () => {
    stubRaf();
    const { container } = renderAvatar("idle", {
      followCursor: true,
      reduceMotion: true,
    });
    pointerMove(100, 0);
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    expect(pair!.getAttribute("data-gaze")).toBe("0,0");
  });

  it("falls back to ambient gaze when the pointer leaves the window", () => {
    stubRaf();
    const { container } = renderAvatar("idle", { followCursor: true });
    pointerMove(0, 500);
    const pair = container.querySelector<SVGGElement>(".av-eyes");
    expect(pair!.getAttribute("data-gaze")).toBe("0,4.5");
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent("pointerleave"));
    });
    // Back on the ambient wander feed (deflection capped at ±4 x / ±3 y,
    // so the 4.5-unit cursor lock cannot persist).
    expect(pair!.getAttribute("data-gaze")).not.toBe("0,4.5");
  });
});

describe("error choreography", () => {
  it("pops to startled dots, then settles into a determined squint", () => {
    vi.useFakeTimers();
    renderAvatar("error");
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-eyes", "dot");
    expect(el).not.toHaveClass("av-error-settled");
    act(() => {
      vi.advanceTimersByTime(ERROR_SETTLE_MS + 100);
    });
    expect(el).toHaveAttribute("data-eyes", "determined");
    expect(el).toHaveClass("av-error-settled");
    expect(el).toHaveAttribute("data-state", "error");
    expect(el).toHaveAccessibleName("Scout — error");
  });

  it("skips the startled pop under reduced motion (static settled pose)", () => {
    renderAvatar("error", { reduceMotion: true });
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-eyes", "determined");
    expect(el).toHaveClass("av-error-settled");
  });

  it("re-arms the startled pop when re-entering error", () => {
    vi.useFakeTimers();
    const { rerender } = renderAvatar("error");
    act(() => {
      vi.advanceTimersByTime(ERROR_SETTLE_MS + 100);
    });
    expect(screen.getByRole("img")).toHaveAttribute("data-eyes", "determined");
    rerender(<BotAvatar color="#14b8a6" state="idle" label="Scout" />);
    rerender(<BotAvatar color="#14b8a6" state="error" label="Scout" />);
    expect(screen.getByRole("img")).toHaveAttribute("data-eyes", "dot");
  });
});

describe("celebrating one-shot", () => {
  it("auto-settles to idle after the celebration", () => {
    vi.useFakeTimers();
    renderAvatar("celebrating");
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-state", "celebrating");
    expect(el).toHaveAttribute("data-eyes", "arc");
    act(() => {
      vi.advanceTimersByTime(CELEBRATE_MS + 100);
    });
    expect(el).toHaveAttribute("data-state", "idle");
    expect(el).toHaveAttribute("data-eyes", "open");
    expect(el).toHaveAccessibleName("Scout — idle");
  });

  it("shows confetti at full size, then removes it after settling", () => {
    vi.useFakeTimers();
    const { container } = renderAvatar("celebrating", { size: 64 });
    expect(container.querySelectorAll("[data-confetti]").length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(CELEBRATE_MS + 100);
    });
    expect(container.querySelectorAll("[data-confetti]").length).toBe(0);
  });
});

describe("reduced motion", () => {
  it("applies av-rm when reduceMotion is true and omits it otherwise", () => {
    const { unmount } = renderAvatar("idle", { reduceMotion: true });
    expect(screen.getByRole("img")).toHaveClass("av-rm");
    unmount();
    renderAvatar("idle", { reduceMotion: false });
    expect(screen.getByRole("img")).not.toHaveClass("av-rm");
  });

  it("keeps state info under reduced motion", () => {
    renderAvatar("thinking", { reduceMotion: true });
    const el = screen.getByRole("img");
    expect(el).toHaveClass("av-rm");
    expect(el).toHaveClass("av-state-thinking");
    expect(el).toHaveAttribute("data-eyes", "squint");
    expect(el).toHaveAccessibleName("Scout — thinking");
  });

  it("honors prefers-reduced-motion via matchMedia", () => {
    const mql = {
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
    try {
      renderAvatar("idle");
      expect(screen.getByRole("img")).toHaveClass("av-rm");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("disconnected look", () => {
  it("renders the dimmed disconnected treatment", () => {
    renderAvatar("disconnected");
    const el = screen.getByRole("img");
    expect(el).toHaveClass("av-dim");
    expect(el).toHaveClass("av-state-disconnected");
    expect(el).toHaveAccessibleName("Scout — connection lost");
  });
});

describe("small sizes", () => {
  it("disables fine detail below 32px but keeps state readable", () => {
    const { container } = renderAvatar("celebrating", { size: 24 });
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-detail", "low");
    expect(container.querySelectorAll("[data-confetti]").length).toBe(0);
    expect(el).toHaveAttribute("data-state", "celebrating");
  });

  it("keeps gross eye state at 16px", () => {
    renderAvatar("waitingOnUser", { size: 16 });
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-eyes", "tall");
    expect(el).toHaveAccessibleName("Scout — waiting on you");
  });

  it("keeps full detail at >= 32px", () => {
    const { container } = renderAvatar("sleeping", { size: 32 });
    expect(screen.getByRole("img")).toHaveAttribute("data-detail", "high");
    expect(container.querySelectorAll("[data-zzz]").length).toBe(3);
  });

  it("keeps sleepy lines compatible with the zzz overlay", () => {
    const { container } = renderAvatar("sleeping", { size: 64 });
    const el = screen.getByRole("img");
    expect(el).toHaveAttribute("data-eyes", "line");
    // Both the line eyes and the zzz render together.
    expect(container.querySelectorAll(".av-eye")).toHaveLength(2);
    expect(container.querySelectorAll("[data-zzz]")).toHaveLength(3);
  });
});

describe("ambient blinking", () => {
  it("blinks within ~8s while idle and visible", () => {
    vi.useFakeTimers();
    const { container } = renderAvatar("idle");
    act(() => {
      vi.advanceTimersByTime(8100);
    });
    // A blink lasts 130ms; land inside one by stepping until the class shows.
    let blinked = container.querySelector(".av-blink") !== null;
    for (let i = 0; i < 200 && !blinked; i++) {
      act(() => {
        vi.advanceTimersByTime(50);
      });
      blinked = container.querySelector(".av-blink") !== null;
    }
    expect(blinked).toBe(true);
  });

  it("never blinks under reduced motion", () => {
    vi.useFakeTimers();
    const { container } = renderAvatar("idle", { reduceMotion: true });
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(container.querySelector(".av-blink")).toBeNull();
  });
});

describe("ball gradient + gloss", () => {
  const getGradient = (container: HTMLElement) => {
    const grads = container.getElementsByTagName("linearGradient");
    expect(grads).toHaveLength(1);
    return grads[0];
  };

  it("fills the ball from a vertical linearGradient", () => {
    const { container } = renderAvatar("idle");
    const grad = getGradient(container);
    const id = grad.getAttribute("id");
    expect(id).toBeTruthy();
    // Vertical: same x endpoints, different y endpoints.
    expect(grad.getAttribute("x1")).toBe(grad.getAttribute("x2"));
    expect(grad.getAttribute("y1")).not.toBe(grad.getAttribute("y2"));
    const ball = container.querySelector("[data-ball]");
    expect(ball).not.toBeNull();
    expect(ball!.getAttribute("fill")).toBe(`url(#${id})`);
  });

  it("uses a unique per-instance gradient id", () => {
    const a = renderAvatar("idle");
    const b = renderAvatar("idle");
    const idA = getGradient(a.container).getAttribute("id");
    const idB = getGradient(b.container).getAttribute("id");
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it("derives the stops from the bot color: lighter top, base mid, deeper bottom", () => {
    const { container } = renderAvatar("idle"); // color #14b8a6
    const stops = getGradient(container).getElementsByTagName("stop");
    expect(stops).toHaveLength(3);
    const expected = ballGradientStops("#14b8a6");
    expect(stops[0].getAttribute("stop-color")).toBe(expected.top);
    expect(stops[1].getAttribute("stop-color")).toBe("#14b8a6");
    expect(stops[2].getAttribute("stop-color")).toBe(expected.bottom);
  });

  it("renders the subtle gloss highlight at detail sizes", () => {
    const { container } = renderAvatar("idle", { size: 64 });
    const gloss = container.querySelector("[data-gloss]");
    expect(gloss).not.toBeNull();
    expect(gloss!.getAttribute("fill")).toBe("#ffffff");
    const opacity = Number(gloss!.getAttribute("opacity"));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(0.5);
  });

  it("omits the gloss below the detail threshold but keeps the gradient", () => {
    const { container } = renderAvatar("idle", { size: 24 });
    expect(container.querySelector("[data-gloss]")).toBeNull();
    expect(container.getElementsByTagName("linearGradient")).toHaveLength(1);
    expect(container.querySelector("[data-ball]")).not.toBeNull();
  });

  it("keeps eyes flat white with a plain ink outline, untouched by the gradient", () => {
    const { container } = renderAvatar("idle");
    for (const eye of container.querySelectorAll(".av-eye")) {
      const path = eye.querySelector("path")!;
      expect(path.getAttribute("fill")).toBe("#ffffff");
      expect(path.getAttribute("stroke")).toBe("#1f2937");
      // The ball's gradient never leaks into the eyes.
      expect(path.getAttribute("fill")).not.toContain("url(");
      expect(path.getAttribute("stroke")).not.toContain("url(");
    }
  });
});

describe("eyeStrokeFor (contrast)", () => {
  it("uses dark ink on light ball colors", () => {
    expect(eyeStrokeFor("#5eead4")).toBe("#1f2937"); // light teal
    expect(eyeStrokeFor("#facc15")).toBe("#1f2937"); // yellow
  });

  it("keeps the ink outline on mid-dark balls, where white eyes already read", () => {
    expect(eyeStrokeFor("#1e3a8a")).toBe("#1f2937"); // navy
  });

  it("lifts the outline off near-black balls so the edge stays visible", () => {
    // A black outline on a black ball leaves a floating white blob.
    expect(eyeStrokeFor("#111")).toBe("#64748b"); // short-hex near-black
    expect(eyeStrokeFor("#0a0a0a")).toBe("#64748b");
  });

  it("falls back to dark ink for unparseable colors", () => {
    expect(eyeStrokeFor("rebeccapurple")).toBe("#1f2937");
  });
});
