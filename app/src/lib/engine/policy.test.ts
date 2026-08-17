// Policy hook + visibility tests (tool-extensibility spec: "Policy-hook
// gating", "Per-bot tool visibility filtering"; human-handoff: "Hard floor
// cannot be disabled").
import { describe, expect, it } from "vitest";
import {
  classifyConnectorTool,
  classifyFormField,
  decide,
  decideForChain,
  DEFAULT_CATEGORY_RULES,
  ESCALATE_WHEN_TAINTED,
  HARD_FLOOR_CATEGORIES,
  isVisible,
  tightest,
  type ActionCategory,
  type ToolPolicy,
} from "./policy";
import type { EngineTool } from "./tools";
import type { Bot } from "./types";

function makeBot(toolPolicy?: ToolPolicy): Bot {
  return {
    id: "bot-1",
    name: "Testy",
    color: "#123456",
    roleDescription: "test bot",
    createdAt: 0,
    paused: false,
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
  };
}

function makeTool(category: ActionCategory, name = `${category}-tool`): EngineTool {
  return {
    name,
    description: "a tool",
    parameters: { type: "object", properties: {} },
    category,
    run: () => "ok",
  };
}

describe("decide — category defaults (no bot policy)", () => {
  it("gates effects, not syntax: workspace work runs, sensitive effects stop", () => {
    const bot = makeBot();
    expect(decide(bot, makeTool("read"))).toBe("allow");
    expect(decide(bot, makeTool("workspace-mutate"))).toBe("allow");
    expect(decide(bot, makeTool("delegation"))).toBe("allow");
    expect(decide(bot, makeTool("shell-session"))).toBe("allow");
    expect(decide(bot, makeTool("shell-local"))).toBe("allow");
    expect(decide(bot, makeTool("external-comms"))).toBe("approve");
    expect(decide(bot, makeTool("bulk-delete"))).toBe("approve");
    expect(decide(bot, makeTool("credential"))).toBe("approve");
    expect(decide(bot, makeTool("payment"))).toBe("approve");
  });

  it("asks the same number of times wherever the workspace lives", () => {
    // task-execution spec, "Location does not change the answer": the two
    // shell categories must not diverge, or the provider choice silently
    // becomes an autonomy setting.
    const bot = makeBot();
    expect(decide(bot, makeTool("shell-local"))).toBe(
      decide(bot, makeTool("shell-session")),
    );
  });
});

describe("the sensitive-action floor is untouched by the shell default", () => {
  it("hard floors stay gated and cannot be loosened per bot", () => {
    // A bot whose owner has tried to allow everything.
    const bot = makeBot({
      categories: {
        "bulk-delete": "allow",
        credential: "allow",
        payment: "allow",
      },
    });
    expect(decide(bot, makeTool("bulk-delete"))).toBe("approve");
    expect(decide(bot, makeTool("credential"))).toBe("approve");
    expect(decide(bot, makeTool("payment"))).toBe("approve");
  });

  it("external comms stay gated by default", () => {
    expect(decide(makeBot(), makeTool("external-comms"))).toBe("approve");
  });

  it("taint escalation is unchanged", () => {
    const bot = makeBot();
    const tainted = { untrustedContent: true };
    expect(decide(bot, makeTool("self-modify"), {}, tainted)).toBe("approve");
    expect(decide(bot, makeTool("delegation"), {}, tainted)).toBe("approve");
    expect(decide(bot, makeTool("external-read"), {}, tainted)).toBe("approve");
  });

  it("a bot set to Ask first still prompts for shell", () => {
    // The platform default must never override an explicit per-bot choice
    // (task-execution spec, "The user can still ask to be asked").
    const bot = makeBot({ categories: { "shell-local": "approve" } });
    expect(decide(bot, makeTool("shell-local"))).toBe("approve");
  });
});

describe("decide — per-bot policy", () => {
  it("category rules override defaults", () => {
    const bot = makeBot({ categories: { "external-comms": "allow" } });
    expect(decide(bot, makeTool("external-comms"))).toBe("allow");
  });

  it("tool-name rules win over category rules", () => {
    const bot = makeBot({
      categories: { "external-comms": "allow" },
      tools: { send_email: "approve" },
    });
    expect(decide(bot, makeTool("external-comms", "send_email"))).toBe("approve");
    expect(decide(bot, makeTool("external-comms", "other_comms"))).toBe("allow");
  });

  it("policy can tighten an allowed category to approve or deny", () => {
    const approver = makeBot({ categories: { "workspace-mutate": "approve" } });
    expect(decide(approver, makeTool("workspace-mutate"))).toBe("approve");
    const denier = makeBot({ categories: { "workspace-mutate": "deny" } });
    expect(decide(denier, makeTool("workspace-mutate"))).toBe("deny");
  });
});

describe("decide — hard floors cannot be loosened", () => {
  it("covers payment, credential, and bulk-delete", () => {
    expect(HARD_FLOOR_CATEGORIES).toEqual(
      expect.arrayContaining(["payment", "credential", "bulk-delete"]),
    );
  });

  it.each(HARD_FLOOR_CATEGORIES.map((c) => [c] as const))(
    "an 'allow' rule on %s still requires approval (category rule)",
    (category) => {
      const bot = makeBot({ categories: { [category]: "allow" } });
      expect(decide(bot, makeTool(category))).toBe("approve");
    },
  );

  it.each(HARD_FLOOR_CATEGORIES.map((c) => [c] as const))(
    "an 'allow' rule on %s still requires approval (tool-name rule)",
    (category) => {
      const bot = makeBot({ tools: { sensitive: "allow" } });
      expect(decide(bot, makeTool(category, "sensitive"))).toBe("approve");
    },
  );

  it("deny (tighter than approve) is honored on floor categories", () => {
    const bot = makeBot({ categories: { payment: "deny" } });
    expect(decide(bot, makeTool("payment"))).toBe("deny");
  });

  it("floor defaults are approve even in DEFAULT_CATEGORY_RULES", () => {
    for (const category of HARD_FLOOR_CATEGORIES) {
      expect(DEFAULT_CATEGORY_RULES[category]).toBe("approve");
    }
  });
});

describe("isVisible", () => {
  it("everything is visible without a policy", () => {
    const bot = makeBot();
    expect(isVisible(bot, makeTool("shell-local"))).toBe(true);
    expect(isVisible(bot, makeTool("payment"))).toBe(true);
  });

  it("denied tools are hidden; approve-gated tools remain visible", () => {
    const bot = makeBot({
      tools: { hidden_tool: "deny" },
      categories: { "shell-local": "deny", "external-comms": "approve" },
    });
    expect(isVisible(bot, makeTool("read", "hidden_tool"))).toBe(false);
    expect(isVisible(bot, makeTool("shell-local"))).toBe(false);
    expect(isVisible(bot, makeTool("external-comms"))).toBe(true);
  });

  it("a tool-name allow rule un-hides a tool from a denied category", () => {
    const bot = makeBot({
      categories: { "shell-local": "deny" },
      tools: { session_exec: "approve" },
    });
    expect(isVisible(bot, makeTool("shell-local", "session_exec"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security fixes: argument-aware floors, taint escalation, fail-closed
// defaults, and delegation-chain intersection.
// ---------------------------------------------------------------------------

describe("decide — argument-aware classification (reachable hard floors)", () => {
  it("puts a password fill on the credential floor even though the tool is external-comms", () => {
    // Before: no tool ever declared `credential`, so that floor was dead code
    // and the "Bots never enter credentials" invariant was only prose in a
    // tool description — which injected content overrides by construction.
    const bot = makeBot();
    const fill: EngineTool = {
      ...makeTool("external-comms", "browse_fill"),
      classify: (args) => classifyFormField(args.label, args.value),
    };
    expect(decide(bot, fill, { label: "Email", value: "a@b.c" })).toBe("approve");
    expect(decide(bot, fill, { label: "Password", value: "hunter2" })).toBe("approve");
  });

  it("holds the floor even when the user explicitly allowed the tool by name", () => {
    // The whole point of a floor: no policy may loosen it below "approve".
    const permissive = makeBot({
      tools: { browse_fill: "allow" },
      categories: { "external-comms": "allow" },
    });
    const fill: EngineTool = {
      ...makeTool("external-comms", "browse_fill"),
      classify: (args) => classifyFormField(args.label, args.value),
    };
    // An ordinary field obeys the user's "allow"…
    expect(decide(permissive, fill, { label: "Search", value: "boots" })).toBe("allow");
    // …a credential field does not.
    expect(decide(permissive, fill, { label: "One-time code", value: "123456" })).toBe(
      "approve",
    );
    expect(
      decide(permissive, fill, { label: "Card number", value: "4111111111111111" }),
    ).toBe("approve");
  });

  it("detects a card number from the value even when the label is innocuous", () => {
    expect(classifyFormField("Reference", "4111 1111 1111 1111")).toBe("payment");
    expect(classifyFormField("Reference", "12345")).toBeUndefined();
  });

  it("classifies connector tools by name, never by server-declared category", () => {
    expect(classifyConnectorTool("mcp__stripe__create_payment")).toBe("payment");
    expect(classifyConnectorTool("mcp__vault__get_secret")).toBe("credential");
    expect(classifyConnectorTool("mcp__notion__search_pages")).toBeUndefined();
  });

  it("classification can only tighten, never loosen", () => {
    const bot = makeBot();
    const deleteTool: EngineTool = {
      ...makeTool("bulk-delete", "workspace_delete"),
      // A classifier claiming a gentler category must not win.
      classify: () => "read",
    };
    expect(decide(bot, deleteTool, {})).toBe("approve");
  });
});

describe("decide — untrusted-content escalation", () => {
  const tainted = { untrustedContent: true };

  it("escalates self-modify, delegation and external-read once content is tainted", () => {
    const bot = makeBot();
    for (const category of ESCALATE_WHEN_TAINTED) {
      const tool = makeTool(category);
      expect(decide(bot, tool, {}, { untrustedContent: false })).toBe("allow");
      expect(decide(bot, tool, {}, tainted)).toBe("approve");
    }
  });

  it("leaves ordinary local work alone when tainted", () => {
    // Escalating everything would make the app unusable after any web read;
    // only the categories injected text could ESCALATE through are gated.
    const bot = makeBot();
    expect(decide(bot, makeTool("read"), {}, tainted)).toBe("allow");
    expect(decide(bot, makeTool("workspace-mutate"), {}, tainted)).toBe("allow");
    expect(decide(bot, makeTool("shell-session"), {}, tainted)).toBe("allow");
  });

  it("never downgrades an explicit deny", () => {
    const strict = makeBot({ categories: { delegation: "deny" } });
    expect(decide(strict, makeTool("delegation"), {}, tainted)).toBe("deny");
  });

  it("escalates on the CLASSIFIED category too, not just the declared one", () => {
    const bot = makeBot();
    const write: EngineTool = {
      ...makeTool("workspace-mutate", "workspace_write"),
      classify: (args) => (args.path === "skills/x/SKILL.md" ? "self-modify" : undefined),
    };
    expect(decide(bot, write, { path: "notes.md" }, tainted)).toBe("allow");
    expect(decide(bot, write, { path: "skills/x/SKILL.md" }, tainted)).toBe("approve");
  });
});

describe("resolveRule — unknown categories fail closed", () => {
  it("resolves an unrecognized category to approve, not allow", () => {
    const bot = makeBot();
    // A descriptor from a future manifest/plugin with a bad category must not
    // run ungated just because the lookup missed.
    const rogue = makeTool("totally-made-up" as ActionCategory, "rogue");
    expect(decide(bot, rogue, {})).toBe("approve");
  });

  it("still hides a tool the bot denied by name", () => {
    const bot = makeBot({ tools: { rogue: "deny" } });
    const rogue = makeTool("totally-made-up" as ActionCategory, "rogue");
    expect(isVisible(bot, rogue)).toBe(false);
  });
});

describe("decideForChain — delegation cannot launder permission", () => {
  const emailTool = makeTool("external-comms", "send_email");

  it("applies the most restrictive bot in the chain", () => {
    // Requester blocks external comms; the teammate allows it. Before the
    // fix the teammate's policy won and the restriction evaporated.
    const requester = makeBot({ categories: { "external-comms": "deny" } });
    const teammate = makeBot({ categories: { "external-comms": "allow" } });
    expect(decide(teammate, emailTool, {})).toBe("allow");
    expect(decideForChain(teammate, [requester], emailTool, {})).toBe("deny");
  });

  it("keeps the tighter answer when the requester merely wants approval", () => {
    const requester = makeBot({ categories: { "external-comms": "approve" } });
    const teammate = makeBot({ categories: { "external-comms": "allow" } });
    expect(decideForChain(teammate, [requester], emailTool, {})).toBe("approve");
  });

  it("is a no-op for a direct user-initiated run", () => {
    const bot = makeBot({ categories: { "external-comms": "allow" } });
    expect(decideForChain(bot, [], emailTool, {})).toBe("allow");
  });

  it("intersects across a multi-hop chain", () => {
    const origin = makeBot({ categories: { "external-comms": "approve" } });
    const middle = makeBot({ categories: { "external-comms": "allow" } });
    const actor = makeBot({ categories: { "external-comms": "allow" } });
    expect(decideForChain(actor, [origin, middle], emailTool, {})).toBe("approve");
  });
});

describe("tightest", () => {
  it("orders deny over approve over allow", () => {
    expect(tightest("allow", "approve")).toBe("approve");
    expect(tightest("approve", "deny")).toBe("deny");
    expect(tightest("allow", "allow")).toBe("allow");
    expect(tightest("deny", "allow")).toBe("deny");
  });
});
