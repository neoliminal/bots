import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../lib/storage";
import type { SessionKind, SessionStatus } from "../lib/sessions";
import {
  COMPUTE_OPTIONS,
  computeOptionLabel,
  DECIDE_LATER,
  USE_THIS_COMPUTER,
} from "./computeOptions";
import {
  COMPUTE_HANDLER,
  FALLBACK_HANDLER,
  HOST_HANDLER,
  ONBOARDING_COMPUTE_ASKED_KEY,
  SCAN_AGAIN,
  computeIntroCard,
  handleOnboardingAnswer,
  initOnboarding,
  isOnboardingHandler,
  markComputeAsked,
  resetOnboardingForTest,
  shouldAskComputeLocation,
  type OnboardingCtx,
  type OnboardingDeps,
  type OnboardingPost,
} from "./onboardingCompute";

/** The option row text for a provider, as the card renders it. */
function optionFor(kind: SessionKind): string {
  const option = COMPUTE_OPTIONS.find((o) => o.kind === kind);
  if (option === undefined) throw new Error(`no option for ${kind}`);
  return computeOptionLabel(option);
}

interface Harness {
  ctx: OnboardingCtx;
  deps: OnboardingDeps;
  posts: OnboardingPost[];
  starterCalls: number;
  providers: SessionKind[];
  targets: string[];
}

function harness(overrides: Partial<OnboardingDeps> = {}): Harness {
  const posts: OnboardingPost[] = [];
  const providers: SessionKind[] = [];
  const targets: string[] = [];
  const state = { starterCalls: 0 };
  const ctx: OnboardingCtx = {
    botId: "bot-1",
    post: (post) => posts.push(post),
    starterTasks: () => {
      state.starterCalls += 1;
    },
  };
  const deps: OnboardingDeps = {
    setSessionProvider: async (kind) => {
      providers.push(kind);
    },
    setHostTarget: async (target) => {
      targets.push(target);
    },
    hostProviderStatus: async () => "running" as SessionStatus,
    flyProviderStatus: async () => "none" as SessionStatus,
    hostDiscover: async () => [],
    localUserName: async () => "neo",
    ...overrides,
  };
  return {
    ctx,
    deps,
    posts,
    providers,
    targets,
    get starterCalls() {
      return state.starterCalls;
    },
  };
}

/** The card attached to the most recent post, if any. */
function lastCard(posts: OnboardingPost[]): OnboardingPost["card"] {
  return posts[posts.length - 1]?.card;
}

describe("onboardingCompute", () => {
  beforeEach(() => {
    resetOnboardingForTest();
  });

  describe("the introduction card", () => {
    it("offers every provider plus an explicit way out, all one click", () => {
      const card = computeIntroCard();
      expect(card.handler).toBe(COMPUTE_HANDLER);
      expect(card.options).toEqual([
        ...COMPUTE_OPTIONS.map(computeOptionLabel),
        DECIDE_LATER,
      ]);
    });

    it("recognizes its own handlers only", () => {
      expect(isOnboardingHandler(COMPUTE_HANDLER)).toBe(true);
      expect(isOnboardingHandler(HOST_HANDLER)).toBe(true);
      expect(isOnboardingHandler(FALLBACK_HANDLER)).toBe(true);
      expect(isOnboardingHandler(undefined)).toBe(false);
      expect(isOnboardingHandler("model.card")).toBe(false);
    });
  });

  describe("this computer", () => {
    it("selects local and hands off to starter tasks", async () => {
      const h = harness();
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("local"), h.ctx, h.deps);
      expect(h.providers).toEqual(["local"]);
      expect(h.posts).toHaveLength(1);
      expect(lastCard(h.posts)).toBeUndefined();
      expect(h.starterCalls).toBe(1);
    });
  });

  describe("a machine I own", () => {
    it("offers each discovered host as a chip with the local account name", async () => {
      const h = harness({ hostDiscover: async () => ["minipc.local", "nas.local"] });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("host"), h.ctx, h.deps);
      expect(h.posts[0].text).toContain("Looking for machines");
      expect(lastCard(h.posts)?.options).toEqual([
        "neo@minipc.local",
        "neo@nas.local",
        SCAN_AGAIN,
        USE_THIS_COMPUTER,
      ]);
      expect(lastCard(h.posts)?.handler).toBe(HOST_HANDLER);
      // Nothing is committed until a host actually answers.
      expect(h.providers).toEqual([]);
      expect(h.starterCalls).toBe(0);
    });

    it("saves, probes and selects the host when it answers", async () => {
      const h = harness();
      await handleOnboardingAnswer(HOST_HANDLER, "neo@minipc.local", h.ctx, h.deps);
      expect(h.targets).toEqual(["neo@minipc.local"]);
      expect(h.providers).toEqual(["host"]);
      expect(h.posts[0].text).toContain("neo@minipc.local");
      expect(h.starterCalls).toBe(1);
    });

    it("does not select an unreachable host, and offers a way forward", async () => {
      const h = harness({ hostProviderStatus: async () => "error" as SessionStatus });
      await handleOnboardingAnswer(HOST_HANDLER, "neo@minipc.local", h.ctx, h.deps);
      expect(h.providers).toEqual([]);
      expect(h.posts[0].text).toContain("couldn't reach");
      expect(lastCard(h.posts)?.options).toEqual([SCAN_AGAIN, USE_THIS_COMPUTER]);
      expect(h.starterCalls).toBe(0);
    });

    it("treats a probe that throws as unreachable", async () => {
      const h = harness({
        hostProviderStatus: async () => {
          throw new Error("ssh exploded");
        },
      });
      await handleOnboardingAnswer(HOST_HANDLER, "neo@minipc.local", h.ctx, h.deps);
      expect(h.providers).toEqual([]);
      expect(lastCard(h.posts)?.handler).toBe(HOST_HANDLER);
    });

    it("invites an address when discovery finds nothing", async () => {
      const h = harness({ hostDiscover: async () => [] });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("host"), h.ctx, h.deps);
      expect(h.posts[1].text).toContain("couldn't spot one");
      expect(lastCard(h.posts)?.options).toEqual([SCAN_AGAIN, USE_THIS_COMPUTER]);
      expect(h.starterCalls).toBe(0);
    });

    it("treats a failed scan as an empty one", async () => {
      const h = harness({
        hostDiscover: async () => {
          throw new Error("no mDNS");
        },
      });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("host"), h.ctx, h.deps);
      expect(lastCard(h.posts)?.options).toEqual([SCAN_AGAIN, USE_THIS_COMPUTER]);
    });

    it("re-runs discovery on 'look again'", async () => {
      const discover = vi.fn(async () => ["minipc.local"]);
      const h = harness({ hostDiscover: discover });
      await handleOnboardingAnswer(HOST_HANDLER, SCAN_AGAIN, h.ctx, h.deps);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(lastCard(h.posts)?.options).toContain("neo@minipc.local");
    });

    it("completes a bare hostname with the local account name", async () => {
      const h = harness();
      await handleOnboardingAnswer(HOST_HANDLER, "minipc.local", h.ctx, h.deps);
      expect(h.targets).toEqual(["neo@minipc.local"]);
      expect(h.providers).toEqual(["host"]);
    });

    it("falls back to 'user' when whoami is unavailable", async () => {
      const h = harness({
        localUserName: async () => {
          throw new Error("no tauri");
        },
      });
      await handleOnboardingAnswer(HOST_HANDLER, "minipc.local", h.ctx, h.deps);
      expect(h.targets).toEqual(["user@minipc.local"]);
    });

    it("never guesses at prose", async () => {
      const h = harness();
      await handleOnboardingAnswer(HOST_HANDLER, "the nuc in the cupboard", h.ctx, h.deps);
      expect(h.targets).toEqual([]);
      expect(h.providers).toEqual([]);
      expect(h.posts[0].text).toContain("couldn't read");
      expect(lastCard(h.posts)?.options).toEqual([SCAN_AGAIN, USE_THIS_COMPUTER]);
    });

    it("returns to this computer in one click", async () => {
      const h = harness();
      await handleOnboardingAnswer(HOST_HANDLER, USE_THIS_COMPUTER, h.ctx, h.deps);
      expect(h.providers).toEqual(["local"]);
      expect(h.starterCalls).toBe(1);
    });
  });

  describe("a cloud VM", () => {
    it("selects fly when the token is configured", async () => {
      const h = harness({ flyProviderStatus: async () => "none" as SessionStatus });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("fly"), h.ctx, h.deps);
      expect(h.providers).toEqual(["fly"]);
      expect(h.starterCalls).toBe(1);
    });

    it("never selects fly without a token, and names the one missing step", async () => {
      const h = harness({
        flyProviderStatus: async () => "unconfigured" as SessionStatus,
      });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("fly"), h.ctx, h.deps);
      expect(h.providers).toEqual([]);
      expect(h.posts[0].text).toContain("FLY_API_TOKEN");
      expect(lastCard(h.posts)?.options).toEqual([USE_THIS_COMPUTER]);
      expect(lastCard(h.posts)?.handler).toBe(FALLBACK_HANDLER);
      expect(h.starterCalls).toBe(0);
    });

    it("treats a failed status check as unconfigured", async () => {
      const h = harness({
        flyProviderStatus: async () => {
          throw new Error("network down");
        },
      });
      await handleOnboardingAnswer(COMPUTE_HANDLER, optionFor("fly"), h.ctx, h.deps);
      expect(h.providers).toEqual([]);
    });

    it("falls back to this computer from the token card", async () => {
      const h = harness();
      await handleOnboardingAnswer(FALLBACK_HANDLER, USE_THIS_COMPUTER, h.ctx, h.deps);
      expect(h.providers).toEqual(["local"]);
      expect(h.starterCalls).toBe(1);
    });
  });

  describe("skipping", () => {
    it("leaves the default alone on 'decide later' and moves on", async () => {
      const h = harness();
      await handleOnboardingAnswer(COMPUTE_HANDLER, DECIDE_LATER, h.ctx, h.deps);
      expect(h.providers).toEqual([]);
      expect(h.posts[0].text).toContain("Settings");
      expect(lastCard(h.posts)).toBeUndefined();
      expect(h.starterCalls).toBe(1);
    });

    it("treats unparseable free text as 'decide later' rather than guessing", async () => {
      const h = harness();
      await handleOnboardingAnswer(COMPUTE_HANDLER, "whatever you think", h.ctx, h.deps);
      expect(h.providers).toEqual([]);
      expect(h.starterCalls).toBe(1);
    });

    it("never blocks: every branch either finishes or leaves a card", async () => {
      for (const answer of [
        optionFor("local"),
        optionFor("host"),
        optionFor("fly"),
        DECIDE_LATER,
        "something typed",
      ]) {
        const h = harness();
        await handleOnboardingAnswer(COMPUTE_HANDLER, answer, h.ctx, h.deps);
        expect(h.starterCalls > 0 || lastCard(h.posts) !== undefined).toBe(true);
      }
    });
  });

  describe("asked once, ever", () => {
    it("asks a brand-new user with no bots", async () => {
      await initOnboarding({ hasBots: false, storage: createMemoryStorage() });
      expect(shouldAskComputeLocation()).toBe(true);
    });

    it("never asks a user who already has bots (upgrade path)", async () => {
      const storage = createMemoryStorage();
      await initOnboarding({ hasBots: true, storage });
      expect(shouldAskComputeLocation()).toBe(false);
      expect(await storage.get(ONBOARDING_COMPUTE_ASKED_KEY)).toBe(true);
    });

    it("does not ask again after the card has been seeded", async () => {
      const storage = createMemoryStorage();
      await initOnboarding({ hasBots: false, storage });
      markComputeAsked();
      expect(shouldAskComputeLocation()).toBe(false);
      await initOnboarding({ hasBots: false, storage });
      expect(shouldAskComputeLocation()).toBe(false);
    });
  });
});
