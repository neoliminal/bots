// Spec: openspec/specs/bot-management, "Role description first guess".
import { describe, expect, it } from "vitest";
import {
  ROLE_LIBRARY,
  collectRecentUserMessages,
  starterOptionsFor,
  suggestRoles,
} from "./roleSuggestions";

const noContext = { existingBots: [], recentUserMessages: [] };

describe("suggestRoles ordering", () => {
  it("offers Personal Assistant first with an empty roster (spec: first Bot defaults to assistant)", () => {
    const suggestions = suggestRoles(noContext);
    expect(suggestions[0]?.title).toBe("Personal Assistant");
    // The full library is offered when nothing is covered yet.
    expect(suggestions.map((s) => s.title)).toEqual(ROLE_LIBRARY.map((r) => r.title));
  });

  it("every suggestion carries a non-trivial description", () => {
    for (const s of suggestRoles(noContext)) {
      expect(s.description.length).toBeGreaterThan(80);
    }
  });
});

describe("suggestRoles complement filtering", () => {
  it("drops roles already covered by an existing bot (spec: suggestions complement the roster)", () => {
    const suggestions = suggestRoles({
      existingBots: [{ name: "Scout", roleDescription: "Research things overnight" }],
      recentUserMessages: [],
    });
    const titles = suggestions.map((s) => s.title);
    expect(titles).not.toContain("Research");
    expect(titles[0]).toBe("Personal Assistant");
  });

  it("matches on bot names as well as role descriptions", () => {
    const titles = suggestRoles({
      existingBots: [
        { name: "Executive Assistant", roleDescription: "" },
        { name: "Penny", roleDescription: "Handles invoice and expense processing" },
      ],
      recentUserMessages: [],
    }).map((s) => s.title);
    expect(titles).not.toContain("Executive Assistant");
    expect(titles).not.toContain("Expense & Invoice Manager");
    expect(titles[0]).toBe("Personal Assistant");
  });

  it("only removes Personal Assistant when an existing bot already matches it", () => {
    const titles = suggestRoles({
      existingBots: [
        { name: "Jeeves", roleDescription: "My generalist personal assistant" },
      ],
      recentUserMessages: [],
    }).map((s) => s.title);
    expect(titles).not.toContain("Personal Assistant");
    expect(titles.length).toBe(ROLE_LIBRARY.length - 1);
  });
});

describe("suggestRoles usage inference", () => {
  it("floats the expense manager on invoice-heavy history (spec: suggestions learn from usage)", () => {
    const suggestions = suggestRoles({
      existingBots: [],
      recentUserMessages: [
        "Can you process this invoice from Acme?",
        "File these expenses from my trip",
        "Here is another receipt to log",
        "What's the weather like?",
      ],
    });
    // Personal Assistant stays the default first guess; the boosted role
    // lands immediately after it.
    expect(suggestions[0]?.title).toBe("Personal Assistant");
    expect(suggestions[1]?.title).toBe("Expense & Invoice Manager");
  });

  it("ranks clusters by how many messages mention them", () => {
    const titles = suggestRoles({
      existingBots: [],
      recentUserMessages: [
        "Pull the weekly report together",
        "Update the metrics dashboard",
        "Any new support tickets today?",
      ],
    }).map((s) => s.title);
    expect(titles[1]).toBe("Data & Reporting");
    expect(titles[2]).toBe("Support Triage");
  });
});

describe("collectRecentUserMessages", () => {
  it("returns user messages across threads, newest first, capped at the limit", () => {
    const threads = {
      a: [
        { role: "user", text: "oldest", createdAt: 1 },
        { role: "bot", text: "bot reply", createdAt: 2 },
        { role: "user", text: "   ", createdAt: 3 },
      ],
      b: [
        { role: "user", text: "newest", createdAt: 10 },
        { role: "user", text: "middle", createdAt: 5 },
      ],
    };
    expect(collectRecentUserMessages(threads)).toEqual(["newest", "middle", "oldest"]);
    expect(collectRecentUserMessages(threads, 2)).toEqual(["newest", "middle"]);
  });

  it("caps at 50 by default", () => {
    const thread = Array.from({ length: 80 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
      createdAt: i,
    }));
    expect(collectRecentUserMessages({ a: thread })).toHaveLength(50);
  });
});

describe("starterOptionsFor (bot-management spec, introduction card)", () => {
  it("returns the library role's options for an exact description", () => {
    const research = ROLE_LIBRARY.find((r) => r.title === "Research")!;
    expect(starterOptionsFor(research.description)).toContain(
      "Research a topic and summarize it",
    );
  });

  it("borrows the closest role's options for a custom description via keywords", () => {
    const options = starterOptionsFor(
      "You are my research analyst for competitor deep dives.",
    );
    expect(options).toContain("Research a topic and summarize it");
  });

  it("falls back to generic options for unmatched descriptions", () => {
    const options = starterOptionsFor("You fold origami cranes.");
    expect(options).toContain("Tell me what you can do");
    expect(options.length).toBeGreaterThanOrEqual(2);
  });
});
