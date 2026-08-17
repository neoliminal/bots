// One source of truth for how the three compute locations are described to
// the user (agent-computer spec, "Onboarding compute location choice").
//
// Two surfaces consume this: SessionSettings (radio rows, room for a
// paragraph) and the first Bot's onboarding card (one option row each, room
// for a clause). They must offer the same set of providers and must not
// drift into two different stories about what each one costs the user —
// hence `settingsBody` and `oneLine` living side by side on one record.

import type { SessionKind } from "../lib/sessions";

export interface ComputeOption {
  kind: SessionKind;
  /** Title in Settings. */
  title: string;
  /** Short name in the onboarding card's option row. */
  cardLabel: string;
  /** The consequence of this choice, in a clause (onboarding card). */
  oneLine: string;
  /** The full description (Settings). */
  settingsBody: string;
}

export const COMPUTE_OPTIONS: readonly ComputeOption[] = [
  {
    kind: "local",
    title: "Local (this computer)",
    cardLabel: "This computer",
    oneLine: "I work in my own folder here, and stop when it sleeps",
    settingsBody:
      "Commands run sandboxed inside each bot's workspace folder on this " +
      "computer, and stop when the computer sleeps. Bots work in there without " +
      "asking; sensitive actions still pause for you, and everything they " +
      "run is in the Activity log below.",
  },
  {
    kind: "host",
    title: "Personal host (your machine)",
    cardLabel: "A machine I own",
    oneLine: "always on, keeps my logins, and I can browse the web for you",
    settingsBody:
      "Commands run on a machine you own (e.g. a mini-PC) over SSH, with " +
      "per-bot workspaces and DOM-driven browsing through a real browser. " +
      "This host is persistent: workspaces and browser logins are retained " +
      "between sessions. Files still sync back to this computer.",
  },
  {
    kind: "fly",
    title: "Fly Machines (cloud)",
    cardLabel: "A cloud VM",
    oneLine: "disposable, costs per minute, needs an API token",
    settingsBody:
      "Commands run in a disposable cloud micro-VM per bot, seeded from its " +
      "workspace. Files sync back to this computer after every command; sessions " +
      "auto-stop when idle.",
  },
];

/** Answer text that returns the user to the local default from any dead end. */
export const USE_THIS_COMPUTER = "Use this computer for now";

/** Answer text that leaves the default in place without choosing. */
export const DECIDE_LATER = "Decide later — this computer for now";

/** The option row text for a compute choice: label plus its consequence. */
export function computeOptionLabel(option: ComputeOption): string {
  return `${option.cardLabel} — ${option.oneLine}`;
}

/**
 * Resolve an answer from the onboarding location card back to a provider.
 * Returns null for anything unrecognized (typed prose), which the flow
 * treats as "decide later" rather than trying to parse it.
 */
export function computeKindFromAnswer(answer: string): SessionKind | null {
  const text = answer.trim();
  for (const option of COMPUTE_OPTIONS) {
    if (text === computeOptionLabel(option) || text === option.cardLabel) {
      return option.kind;
    }
  }
  return null;
}
