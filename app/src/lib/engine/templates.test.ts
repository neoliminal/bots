import { describe, expect, it } from "vitest";
import {
  buildTemplateFromBot,
  MAX_STARTER_FILES,
  parseTemplate,
  serializeTemplate,
  TEMPLATE_VERSION,
  templatePrefill,
  type PersonaTemplate,
} from "./templates";
import type { Bot } from "./types";

const template: PersonaTemplate = {
  version: 1,
  role: "Landing Page Bot",
  description: "Keeps the landing page fresh.",
  instructions: "Review copy weekly and draft improvements.",
  starterFiles: [],
};

describe("buildTemplateFromBot", () => {
  it("builds from name + roleDescription only — nothing else can leak in", () => {
    // A full bot record with everything a bot accumulates. The builder's
    // parameter type only admits name/roleDescription, so memories, threads,
    // and credentials are structurally absent from the output.
    const bot: Bot & { memories: string[]; apiKey: string } = {
      id: "b1",
      name: "  Scout ",
      color: "#14b8a6",
      roleDescription: " Research accounts overnight. ",
      createdAt: 123,
      paused: false,
      workspacePath: "/private/stuff",
      memories: ["secret memory"],
      apiKey: "sk-should-never-appear",
    };
    const built = buildTemplateFromBot(bot);
    expect(built).toEqual({
      version: TEMPLATE_VERSION,
      role: "Scout",
      description: "",
      instructions: "Research accounts overnight.",
      starterFiles: [],
    });
    // Exactly the schema keys, nothing more.
    expect(Object.keys(built).sort()).toEqual([
      "description",
      "instructions",
      "role",
      "starterFiles",
      "version",
    ]);
    const json = serializeTemplate(built);
    expect(json).not.toContain("secret memory");
    expect(json).not.toContain("sk-should-never-appear");
    expect(json).not.toContain("/private/stuff");
  });
});

describe("serialize / parse round-trip", () => {
  it("round-trips a template exactly", () => {
    const parsed = parseTemplate(serializeTemplate(template));
    expect(parsed).toEqual({ ok: true, template });
  });

  it("round-trips starter files", () => {
    const withFiles: PersonaTemplate = {
      ...template,
      starterFiles: [
        { path: "skills/landing/SKILL.md", contents: "# Landing skill" },
        { path: "notes.md", contents: "start here" },
      ],
    };
    const parsed = parseTemplate(serializeTemplate(withFiles));
    expect(parsed).toEqual({ ok: true, template: withFiles });
  });

  it("serializes to stable, human-readable JSON (no starterFiles key when empty)", () => {
    const json = serializeTemplate(template);
    expect(json).toBe(
      `${JSON.stringify(
        {
          version: 1,
          role: "Landing Page Bot",
          description: "Keeps the landing page fresh.",
          instructions: "Review copy weekly and draft improvements.",
        },
        null,
        2,
      )}\n`,
    );
  });
});

describe("parseTemplate validation", () => {
  it("rejects unknown versions instead of coercing them", () => {
    for (const version of [2, 0, "1", null]) {
      const result = parseTemplate(JSON.stringify({ ...template, version }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/version/i);
    }
  });

  it("rejects a missing version", () => {
    const { version: _v, ...rest } = template;
    const result = parseTemplate(JSON.stringify(rest));
    expect(result).toEqual({ ok: false, error: "Missing template version." });
  });

  it("rejects malformed JSON and non-object payloads without throwing", () => {
    expect(parseTemplate("{nope").ok).toBe(false);
    expect(parseTemplate('"just a string"').ok).toBe(false);
    expect(parseTemplate("[1,2]").ok).toBe(false);
    expect(parseTemplate("null").ok).toBe(false);
  });

  it("rejects a missing or empty role title", () => {
    expect(parseTemplate(JSON.stringify({ version: 1 })).ok).toBe(false);
    expect(parseTemplate(JSON.stringify({ version: 1, role: "  " })).ok).toBe(false);
    expect(parseTemplate(JSON.stringify({ version: 1, role: 42 })).ok).toBe(false);
  });

  it("rejects non-string description/instructions", () => {
    const result = parseTemplate(
      JSON.stringify({ version: 1, role: "R", instructions: { evil: true } }),
    );
    expect(result.ok).toBe(false);
  });

  it("defaults missing description/instructions/starterFiles", () => {
    const result = parseTemplate(JSON.stringify({ version: 1, role: "R" }));
    expect(result).toEqual({
      ok: true,
      template: {
        version: 1,
        role: "R",
        description: "",
        instructions: "",
        starterFiles: [],
      },
    });
  });

  it("drops unknown keys so foreign fields never ride along", () => {
    const result = parseTemplate(
      JSON.stringify({
        ...template,
        memories: ["smuggled"],
        credentials: { token: "x" },
        toolPolicy: { categories: { "bulk-delete": "allow" } },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).toEqual(template);
      expect(Object.keys(result.template).sort()).toEqual([
        "description",
        "instructions",
        "role",
        "starterFiles",
        "version",
      ]);
    }
  });

  it("never silently drops starter files: malformed ones reject the template", () => {
    // Non-array
    expect(
      parseTemplate(JSON.stringify({ version: 1, role: "R", starterFiles: "x" })).ok,
    ).toBe(false);
    // Non-object entry
    expect(
      parseTemplate(JSON.stringify({ version: 1, role: "R", starterFiles: ["x"] })).ok,
    ).toBe(false);
    // Missing contents
    expect(
      parseTemplate(
        JSON.stringify({ version: 1, role: "R", starterFiles: [{ path: "a.md" }] }),
      ).ok,
    ).toBe(false);
  });

  it("rejects unsafe or duplicate starter-file paths", () => {
    const bad = (path: string) =>
      parseTemplate(
        JSON.stringify({
          version: 1,
          role: "R",
          starterFiles: [{ path, contents: "x" }],
        }),
      );
    expect(bad("../escape.md").ok).toBe(false);
    expect(bad("/etc/passwd").ok).toBe(false);
    expect(bad("a/../../b.md").ok).toBe(false);
    expect(bad("~/x.md").ok).toBe(false);
    expect(bad("  ").ok).toBe(false);

    const dup = parseTemplate(
      JSON.stringify({
        version: 1,
        role: "R",
        starterFiles: [
          { path: "a.md", contents: "1" },
          { path: "a.md", contents: "2" },
        ],
      }),
    );
    expect(dup.ok).toBe(false);
  });

  it("rejects templates bundling too many starter files", () => {
    const files = Array.from({ length: MAX_STARTER_FILES + 1 }, (_, i) => ({
      path: `f${i}.md`,
      contents: "x",
    }));
    const result = parseTemplate(
      JSON.stringify({ version: 1, role: "R", starterFiles: files }),
    );
    expect(result.ok).toBe(false);
  });

  it("rebuilds starter files field-by-field (foreign keys dropped)", () => {
    const result = parseTemplate(
      JSON.stringify({
        version: 1,
        role: "R",
        starterFiles: [{ path: "a.md", contents: "x", exec: "rm -rf /" }],
      }),
    );
    expect(result).toEqual({
      ok: true,
      template: {
        version: 1,
        role: "R",
        description: "",
        instructions: "",
        starterFiles: [{ path: "a.md", contents: "x" }],
      },
    });
  });
});

describe("templatePrefill", () => {
  it("suggests the role title as the name and joins description + instructions", () => {
    expect(templatePrefill(template)).toEqual({
      name: "Landing Page Bot",
      roleDescription:
        "Keeps the landing page fresh.\n\nReview copy weekly and draft improvements.",
      starterFiles: [],
    });
  });

  it("skips empty parts and passes starter files through", () => {
    const files = [{ path: "a.md", contents: "x" }];
    expect(
      templatePrefill({
        version: 1,
        role: "R",
        description: "",
        instructions: "Do X.",
        starterFiles: files,
      }),
    ).toEqual({ name: "R", roleDescription: "Do X.", starterFiles: files });
  });
});
