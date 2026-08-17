import { describe, expect, it } from "vitest";
import {
  COMPUTE_OPTIONS,
  computeKindFromAnswer,
  computeOptionLabel,
  DECIDE_LATER,
  USE_THIS_COMPUTER,
} from "./computeOptions";
import type { SessionKind } from "../lib/sessions";

/**
 * The whole point of this module is that Settings and the onboarding card
 * cannot drift. A new provider added to `SessionKind` without copy here
 * would leave one surface silently missing it.
 */
const ALL_KINDS: SessionKind[] = ["local", "fly", "host"];

describe("computeOptions", () => {
  it("covers every session kind exactly once", () => {
    const kinds = COMPUTE_OPTIONS.map((o) => o.kind);
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort());
  });

  it("gives every option both a card clause and a settings paragraph", () => {
    for (const option of COMPUTE_OPTIONS) {
      expect(option.cardLabel.length).toBeGreaterThan(0);
      expect(option.oneLine.length).toBeGreaterThan(0);
      // The card row must stay one line; the settings body may run long.
      expect(computeOptionLabel(option).length).toBeLessThan(80);
      expect(option.settingsBody.length).toBeGreaterThan(option.oneLine.length);
    }
  });

  it("resolves an option row back to its provider", () => {
    for (const option of COMPUTE_OPTIONS) {
      expect(computeKindFromAnswer(computeOptionLabel(option))).toBe(option.kind);
      expect(computeKindFromAnswer(option.cardLabel)).toBe(option.kind);
    }
  });

  it("returns null for answers that are not a provider choice", () => {
    expect(computeKindFromAnswer(DECIDE_LATER)).toBeNull();
    expect(computeKindFromAnswer(USE_THIS_COMPUTER)).toBeNull();
    expect(computeKindFromAnswer("my nuc in the cupboard")).toBeNull();
    expect(computeKindFromAnswer("")).toBeNull();
  });
});
