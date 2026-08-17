// First-run compute-location flow (agent-computer spec, "Onboarding compute
// location choice" + "Guided personal-host setup during onboarding";
// bot-management spec, "First Bot's introduction covers compute location").
//
// The first Bot asks where it should work as an ordinary question card, and
// the APP answers it: every step here is local, so onboarding completes with
// no API key, no model call, and — until the user picks the host branch — no
// network call either.
//
// Shape: pure-ish step functions over an injected `OnboardingDeps` (the same
// pattern the engine uses for `chatStream`), so every branch — including the
// unreachable-host and missing-token paths — is testable in vitest without
// Tauri, without a network, and without a model.

import { sessionLocalExec, hostDiscover } from "../lib/native";
import type { SessionKind, SessionStatus } from "../lib/sessions";
import { createLocalStorage, type KeyValueStorage } from "../lib/storage";
import {
  COMPUTE_OPTIONS,
  computeKindFromAnswer,
  computeOptionLabel,
  DECIDE_LATER,
  USE_THIS_COMPUTER,
} from "./computeOptions";
import {
  flyProviderStatus,
  hostProviderStatus,
  setHostTarget,
  setSessionProvider,
} from "./sessionGlue";

/** Storage key recording that the location question has been asked once. */
export const ONBOARDING_COMPUTE_ASKED_KEY = "onboarding.computeAsked";

/** Handler tags. Cards carrying these are answered by the app, not a model. */
export const COMPUTE_HANDLER = "onboarding.compute";
export const HOST_HANDLER = "onboarding.host";
export const FALLBACK_HANDLER = "onboarding.fallback";

/** Answer text that re-runs discovery from the host card. */
export const SCAN_AGAIN = "Look again";

/** True for cards this module owns. */
export function isOnboardingHandler(handler: string | undefined): boolean {
  return (
    handler === COMPUTE_HANDLER ||
    handler === HOST_HANDLER ||
    handler === FALLBACK_HANDLER
  );
}

export interface OnboardingDeps {
  setSessionProvider: (kind: SessionKind) => Promise<void>;
  setHostTarget: (target: string) => Promise<void>;
  hostProviderStatus: () => Promise<SessionStatus>;
  flyProviderStatus: () => Promise<SessionStatus>;
  hostDiscover: () => Promise<string[]>;
  /** The account name to guess for SSH, so a chip is one click, not a form. */
  localUserName: (botId: string) => Promise<string>;
}

/** A line the Bot posts, optionally carrying its own app-handled card. */
export interface OnboardingPost {
  text: string;
  card?: { prompt: string; options: string[]; handler: string };
}

/** How the flow reaches the thread. Supplied by App.tsx. */
export interface OnboardingCtx {
  botId: string;
  /** Post a Bot line (+ optional card) into the Bot's thread. */
  post: (post: OnboardingPost) => void;
  /** Seed the starter-task card: the location question is settled. */
  starterTasks: () => void;
}

/**
 * `whoami` on this computer, for the SSH username guess. Runs through the local
 * session binding (sandboxed, sanitized env) and degrades to "user" — the
 * same default the Settings field uses — outside Tauri or on any failure.
 */
async function defaultLocalUserName(botId: string): Promise<string> {
  try {
    const result = await sessionLocalExec(botId, "whoami", 5_000);
    const line = result.stdout.trim().split("\n")[0] ?? "";
    // Windows `whoami` prints DOMAIN\user — keep just the account name.
    const name = line.split(/[\\/]/).pop() ?? "";
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : "user";
  } catch {
    return "user";
  }
}

const defaultDeps: OnboardingDeps = {
  setSessionProvider,
  setHostTarget,
  hostProviderStatus,
  flyProviderStatus,
  hostDiscover,
  localUserName: defaultLocalUserName,
};

// --- Asked-once flag -------------------------------------------------------

let storage: KeyValueStorage = createLocalStorage();
let asked = false;

/**
 * Load the asked-once flag at bootstrap. A roster that already has Bots
 * means this user predates the flow (or has been through it): the flag is
 * set without asking, so no established user is questioned retroactively.
 */
export async function initOnboarding(options: {
  hasBots: boolean;
  storage?: KeyValueStorage;
}): Promise<void> {
  if (options.storage) storage = options.storage;
  asked = (await storage.get<boolean>(ONBOARDING_COMPUTE_ASKED_KEY)) === true;
  if (!asked && options.hasBots) {
    asked = true;
    await storage.set(ONBOARDING_COMPUTE_ASKED_KEY, true);
  }
}

/** True only for the very first Bot, and only once ever. */
export function shouldAskComputeLocation(): boolean {
  return !asked;
}

/** Record that the card has been shown (persisted best-effort). */
export function markComputeAsked(): void {
  asked = true;
  void storage.set(ONBOARDING_COMPUTE_ASKED_KEY, true).catch(() => {
    // Worst case the question is asked once more on a later first Bot;
    // failing the seed over a storage write would be the worse trade.
  });
}

/** Test helper: forget the flag and the storage binding. */
export function resetOnboardingForTest(): void {
  asked = false;
  storage = createLocalStorage();
}

// --- The card the introduction leads with ---------------------------------

/** The location question, as a tagged choice block. */
export function computeIntroCard(): {
  prompt: string;
  options: string[];
  handler: string;
} {
  return {
    prompt: "Where should I run commands?",
    options: [...COMPUTE_OPTIONS.map(computeOptionLabel), DECIDE_LATER],
    handler: COMPUTE_HANDLER,
  };
}

/** The greeting line that introduces the question, in the Bot's voice. */
export function computeIntroText(greeting: string): string {
  return `${greeting}\n\nOne thing first — where should I actually do the work? It decides what I can get done while you're away from your computer.`;
}

// --- Branches --------------------------------------------------------------

/** Options offered whenever the host branch needs another attempt. */
function hostRetryCard(): OnboardingPost["card"] {
  return {
    prompt: "What should I do?",
    options: [SCAN_AGAIN, USE_THIS_COMPUTER],
    handler: HOST_HANDLER,
  };
}

async function chooseLocal(
  ctx: OnboardingCtx,
  deps: OnboardingDeps,
  text: string,
): Promise<void> {
  await deps.setSessionProvider("local");
  ctx.post({ text });
  ctx.starterTasks();
}

/** "Decide later", or free text we shouldn't try to parse. */
function skipChoice(ctx: OnboardingCtx): void {
  ctx.post({
    text: "No problem — I'll work here on this computer for now. You can move me to another machine any time in Settings.",
    // No card: the whole point of this branch is to stop asking.
  });
  ctx.starterTasks();
}

async function chooseHost(ctx: OnboardingCtx, deps: OnboardingDeps): Promise<void> {
  ctx.post({ text: "Looking for machines on your network…" });
  const hosts = await deps.hostDiscover().catch(() => []);
  const user = await deps.localUserName(ctx.botId).catch(() => "user");
  if (hosts.length === 0) {
    ctx.post({
      text: "I couldn't spot one from here. If you know its address, type it below (like you@minipc.local) and I'll try it — otherwise I'll stay on this computer for now.",
      card: hostRetryCard(),
    });
    return;
  }
  ctx.post({
    text:
      hosts.length === 1
        ? "Found one on your network — is that it?"
        : `Found ${hosts.length} machines on your network — which one is yours?`,
    card: {
      prompt: "Which machine should I work on?",
      options: [...hosts.map((host) => `${user}@${host}`), SCAN_AGAIN, USE_THIS_COMPUTER],
      handler: HOST_HANDLER,
    },
  });
}

/**
 * A chip is already `user@host`; a typed answer may be either that or a bare
 * hostname, which we complete with the local account name. Anything else is
 * prose, and prose is not something to guess at.
 */
async function normalizeTarget(
  text: string,
  ctx: OnboardingCtx,
  deps: OnboardingDeps,
): Promise<string | null> {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(text)) return text;
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(text) && text.includes(".")) {
    const user = await deps.localUserName(ctx.botId).catch(() => "user");
    return `${user}@${text}`;
  }
  return null;
}

async function tryHostTarget(
  text: string,
  ctx: OnboardingCtx,
  deps: OnboardingDeps,
): Promise<void> {
  const target = await normalizeTarget(text, ctx, deps);
  if (target === null) {
    ctx.post({
      text: `I couldn't read "${text}" as a machine address — they look like you@minipc.local.`,
      card: hostRetryCard(),
    });
    return;
  }
  await deps.setHostTarget(target);
  const status = await deps.hostProviderStatus().catch<SessionStatus>(() => "error");
  if (status !== "running") {
    // The provider is deliberately left where it was: selecting a host I
    // can't reach would break the first command instead of this sentence.
    ctx.post({
      text: `I couldn't reach ${target}. Signing in over SSH has to work without a password prompt — host/README.md in the project folder sets that up.`,
      card: hostRetryCard(),
    });
    return;
  }
  await deps.setSessionProvider("host");
  ctx.post({
    text: `${target} answered — that's where I'll run things from now on. Files still sync back to this computer, and I can use a real browser there.`,
  });
  ctx.starterTasks();
}

async function chooseFly(ctx: OnboardingCtx, deps: OnboardingDeps): Promise<void> {
  const status = await deps
    .flyProviderStatus()
    .catch<SessionStatus>(() => "unconfigured");
  if (status === "unconfigured") {
    ctx.post({
      text: "Cloud VMs need a Fly API token first: add FLY_API_TOKEN=<your token> to keys/.env in the project folder and restart me. Until then I'd have nowhere to run.",
      card: {
        prompt: "Until then?",
        options: [USE_THIS_COMPUTER],
        handler: FALLBACK_HANDLER,
      },
    });
    return;
  }
  await deps.setSessionProvider("fly");
  ctx.post({
    text: "Cloud it is — I'll start a disposable VM the first time I need to run something, and it stops itself when it goes idle.",
  });
  ctx.starterTasks();
}

// --- Entry point -----------------------------------------------------------

/**
 * Answer an onboarding card. The user's selection has already been posted as
 * an ordinary user message by the send path (messaging spec: a chip tap is a
 * message), so this only composes the Bot's side and applies the effect.
 */
export async function handleOnboardingAnswer(
  handler: string,
  answer: string,
  ctx: OnboardingCtx,
  deps: OnboardingDeps = defaultDeps,
): Promise<void> {
  const text = answer.trim();
  if (handler === COMPUTE_HANDLER) {
    const kind = computeKindFromAnswer(text);
    if (kind === "local") {
      await chooseLocal(
        ctx,
        deps,
        "Right here it is — I'll work in my own folder on this computer. I won't interrupt you for ordinary work; anything sensitive still comes to you first.",
      );
      return;
    }
    if (kind === "host") {
      await chooseHost(ctx, deps);
      return;
    }
    if (kind === "fly") {
      await chooseFly(ctx, deps);
      return;
    }
    skipChoice(ctx);
    return;
  }

  if (handler === HOST_HANDLER) {
    if (text === USE_THIS_COMPUTER) {
      await chooseLocal(
        ctx,
        deps,
        "This computer for now, then — I'll work in my own folder here. You can point me at your own machine later in Settings.",
      );
      return;
    }
    if (text === SCAN_AGAIN) {
      await chooseHost(ctx, deps);
      return;
    }
    await tryHostTarget(text, ctx, deps);
    return;
  }

  if (handler === FALLBACK_HANDLER) {
    if (text === USE_THIS_COMPUTER) {
      await chooseLocal(
        ctx,
        deps,
        "This computer for now, then — I'll work in my own folder here. Switch me over in Settings once the token's in place.",
      );
      return;
    }
    skipChoice(ctx);
  }
}
