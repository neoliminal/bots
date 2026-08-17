import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInfo } from "../lib/openrouter";
import {
  buildTemplateFromBot,
  serializeTemplate,
  type PersonaTemplate,
} from "../lib/engine";
import { BotEditor } from "./BotEditor";
import { suggestRoles } from "./roleSuggestions";

const models: ModelInfo[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    contextLength: 200000,
    pricing: { prompt: 0.000003, completion: 0.000015 },
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "some/text-only-model",
    name: "Text Only",
    provider: "some",
    contextLength: 8192,
    pricing: { prompt: 0.0000001, completion: 0.0000002 },
    supportsTools: false,
    supportsVision: false,
  },
];

vi.mock("../lib/openrouter", () => ({
  listModels: vi.fn(async () => models),
}));

const initial = {
  name: "Scout",
  color: "#14b8a6",
  roleDescription: "Research things",
  primaryModelId: "anthropic/claude-sonnet-4.5",
};

describe("BotEditor model picker", () => {
  it("renders models without tool calling as unselectable with the reason", async () => {
    // Spec (model-configuration, "OpenRouter as the initial model catalog"):
    // incompatible models (no tool calling) must be unselectable with the reason.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    // Non-featured models live behind the "Browse all" expander.
    await user.click(
      await screen.findByRole("button", { name: /browse all 2 models/i }),
    );
    const incompatible = await screen.findByRole("option", { name: /Text Only/ });
    expect(incompatible).toBeDisabled();
    expect(
      screen.getByText("No tool calling — Bots require tool support"),
    ).toBeInTheDocument();

    await user.click(incompatible);
    await user.click(screen.getByRole("button", { name: "Create Bot" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ primaryModelId: "anthropic/claude-sonnet-4.5" }),
    );
  });

  it("gives initial focus to the Name field, not the picker search box", async () => {
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={initial}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
    await screen.findByRole("option", { name: /Claude Sonnet 4.5/ });
  });

  it("allows selecting a tool-capable model", async () => {
    const user = userEvent.setup();
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={{ ...initial, primaryModelId: "some/other" }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const compatible = await screen.findByRole("option", { name: /Claude Sonnet 4.5/ });
    expect(compatible).toBeEnabled();
    await user.click(compatible);
    expect(screen.getByText("anthropic/claude-sonnet-4.5")).toBeInTheDocument();
  });
});

// Spec: openspec/specs/bot-management, "Role description first guess".
describe("BotEditor role suggestions", () => {
  const suggestions = [
    { title: "Personal Assistant", description: "A generalist helper role." },
    { title: "Research", description: "A research-focused role." },
  ];
  const createInitial = { ...initial, name: "", roleDescription: "" };
  const roleField = () => screen.getByLabelText("Role description") as HTMLTextAreaElement;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-fills create mode with the top suggestion's description", () => {
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={createInitial}
        suggestions={suggestions}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(roleField().value).toBe("A generalist helper role.");
    // Chips for all suggestions sit beneath the textarea.
    expect(screen.getByRole("button", { name: "Personal Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Research" })).toBeInTheDocument();
  });

  it("defaults to the live suggestion wiring when no suggestions prop is given", () => {
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={createInitial}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const expected = suggestRoles({ existingBots: [], recentUserMessages: [] });
    expect(roleField().value).toBe(expected[0]?.description);
    expect(expected[0]?.title).toBe("Personal Assistant");
  });

  it("replaces the textarea content when a chip is tapped (no confirm before typing)", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={createInitial}
        suggestions={suggestions}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Research" }));
    expect(roleField().value).toBe("A research-focused role.");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("never clobbers manually typed text without confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={createInitial}
        suggestions={suggestions}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.clear(roleField());
    await user.type(roleField(), "My own bespoke role");

    // Declined confirm: the typed text stays.
    await user.click(screen.getByRole("button", { name: "Research" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(roleField().value).toBe("My own bespoke role");

    // Accepted confirm: the chip replaces the text.
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Research" }));
    expect(roleField().value).toBe("A research-focused role.");
  });

  it("does not pre-fill in edit mode but still offers chips, confirming before replacing", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <BotEditor
        title="Scout settings"
        submitLabel="Save changes"
        initial={initial}
        suggestions={suggestions}
        onSubmit={() => {}}
        onCancel={() => {}}
        onTogglePause={() => {}}
        onDelete={() => {}}
      />,
    );
    // Edit mode keeps the bot's own description, even though suggestions exist.
    expect(roleField().value).toBe("Research things");
    // Chips are still available; replacing an existing description asks first.
    await user.click(screen.getByRole("button", { name: "Personal Assistant" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(roleField().value).toBe("Research things");
  });
});

describe("BotEditor tool access policy", () => {
  it("submits a category rule chosen in the Tool access section", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="Scout settings"
        submitLabel="Save changes"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Shell on your own machines access" }),
      "deny",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPolicy: { categories: { "shell-local": "deny" } },
      }),
    );
  });

  it("omits toolPolicy entirely when every group is left on Default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create Bot" }));
    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("toolPolicy");
  });

  it("hard-floor groups offer no 'Allowed' option (human-handoff floor)", () => {
    render(
      <BotEditor
        title="New Bot"
        submitLabel="Create Bot"
        initial={initial}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const floorSelect = screen.getByRole("combobox", {
      name: "Permanent deletion access",
    });
    const options = [...floorSelect.querySelectorAll("option")].map((o) => o.value);
    expect(options).not.toContain("allow");
    expect(options).toEqual(expect.arrayContaining(["", "approve", "deny"]));

    // A non-floor group does offer Allowed.
    const shellSelect = screen.getByRole("combobox", {
      name: "Shell in cloud session access",
    });
    const shellOptions = [...shellSelect.querySelectorAll("option")].map((o) => o.value);
    expect(shellOptions).toContain("allow");
  });

  it("lists workspace skills in edit mode and submits the enabled subset", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="Scout settings"
        submitLabel="Save changes"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={() => {}}
        onTogglePause={() => {}}
        availableSkills={[
          {
            name: "weekly-report",
            description: "Compile the weekly metrics report",
            body: "Steps…",
            path: "skills/weekly-report/SKILL.md",
          },
          {
            name: "triage",
            description: "Sort the inbox",
            body: "Steps…",
            path: "skills/triage/SKILL.md",
          },
        ]}
      />,
    );

    // Both skills start enabled (default: all workspace skills on).
    const weekly = screen.getByRole("checkbox", { name: "Skill weekly-report enabled" });
    const triage = screen.getByRole("checkbox", { name: "Skill triage enabled" });
    expect(weekly).toBeChecked();
    expect(triage).toBeChecked();

    // Disabling one submits an explicit enabled list with the other only.
    await user.click(triage);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ enabledSkills: ["weekly-report"] }),
    );
  });

  it("re-enabling every skill collapses back to the all-enabled default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="Scout settings"
        submitLabel="Save changes"
        initial={{ ...initial, enabledSkills: [] }}
        onSubmit={onSubmit}
        onCancel={() => {}}
        onTogglePause={() => {}}
        availableSkills={[
          { name: "solo", description: "", body: "B", path: "skills/solo/SKILL.md" },
        ]}
      />,
    );
    const solo = screen.getByRole("checkbox", { name: "Skill solo enabled" });
    expect(solo).not.toBeChecked();
    await user.click(solo);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("enabledSkills");
  });

  it("resets a group back to Default, dropping the policy", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <BotEditor
        title="Scout settings"
        submitLabel="Save changes"
        initial={{ ...initial, toolPolicy: { categories: { "external-comms": "allow" } } }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByRole("combobox", {
      name: "External messages & connectors access",
    });
    expect((select as HTMLSelectElement).value).toBe("allow");
    await user.selectOptions(select, "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("toolPolicy");
  });
});

// Spec: openspec/changes/add-teammate-approachability/specs/bot-management
// ("Persona templates" / "Export Bot as template").
describe("BotEditor persona templates", () => {
  const editProps = {
    title: "Scout settings",
    submitLabel: "Save changes",
    initial,
    onSubmit: () => {},
    onCancel: () => {},
    onTogglePause: () => {},
  };
  const createProps = {
    title: "New Bot",
    submitLabel: "Create Bot",
    initial: { ...initial, name: "", roleDescription: "" },
    suggestions: [{ title: "Personal Assistant", description: "A helper." }],
    onSubmit: () => {},
    onCancel: () => {},
  };
  const template: PersonaTemplate = {
    version: 1,
    role: "Research Assistant",
    description: "Gets everything done.",
    instructions: "Draft first, ask before sending anything external.",
    starterFiles: [],
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the exact template contents before saving, and saves only on request", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:template");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<BotEditor {...editProps} />);
    await user.click(screen.getByRole("button", { name: "Export as template…" }));

    // The preview is the exact serialized file, built from bot fields only.
    const expected = serializeTemplate(
      buildTemplateFromBot({ name: "Scout", roleDescription: "Research things" }),
    );
    expect(screen.getByLabelText("Template contents")).toHaveTextContent(
      /"role": "Scout"/,
    );
    expect(screen.getByLabelText("Template contents").textContent).toBe(expected);
    // Nothing written yet — the preview comes first.
    expect(createObjectURL).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save template file" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:template");
    vi.unstubAllGlobals();
  });

  it("offers export in edit mode only, import in create mode only", () => {
    const { unmount } = render(<BotEditor {...editProps} />);
    expect(
      screen.getByRole("button", { name: "Export as template…" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import template…" }),
    ).not.toBeInTheDocument();
    unmount();

    render(<BotEditor {...createProps} />);
    expect(
      screen.getByRole("button", { name: "Import template…" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Export as template…" }),
    ).not.toBeInTheDocument();
  });

  it("pasted template is inspectable, then prefills editable fields on use", async () => {
    const user = userEvent.setup();
    render(<BotEditor {...createProps} />);

    await user.click(screen.getByRole("button", { name: "paste JSON instead" }));
    await user.click(screen.getByLabelText("Template JSON"));
    await user.paste(JSON.stringify(template));
    await user.click(screen.getByRole("button", { name: "Preview template" }));

    // Full contents readable in plain form before anything is applied.
    const preview = screen.getByRole("group", {
      name: "Imported template contents",
    });
    expect(preview).toHaveTextContent("Research Assistant");
    expect(preview).toHaveTextContent("Gets everything done.");
    expect(preview).toHaveTextContent(
      "Draft first, ask before sending anything external.",
    );
    // Not applied yet: the name field is still empty.
    expect(screen.getByLabelText("Name")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Use template" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Research Assistant");
    expect(screen.getByLabelText("Role description")).toHaveValue(
      "Gets everything done.\n\nDraft first, ask before sending anything external.",
    );
    // Everything stays editable after prefill.
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "My Own Name");
    expect(screen.getByLabelText("Name")).toHaveValue("My Own Name");
  });

  it("surfaces starter files in the preview, keeps them removable, and submits them", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<BotEditor {...createProps} onSubmit={onSubmit} />);

    const withFiles: PersonaTemplate = {
      ...template,
      starterFiles: [
        { path: "skills/research-assistant/SKILL.md", contents: "# How I work" },
        { path: "notes.md", contents: "kickoff notes" },
      ],
    };
    await user.click(screen.getByRole("button", { name: "paste JSON instead" }));
    await user.click(screen.getByLabelText("Template JSON"));
    await user.paste(JSON.stringify(withFiles));
    await user.click(screen.getByRole("button", { name: "Preview template" }));

    // Inspectability: the file list is readable before anything applies.
    const fileList = screen.getByRole("list", { name: "Template starter files" });
    expect(fileList).toHaveTextContent("skills/research-assistant/SKILL.md");
    expect(fileList).toHaveTextContent("notes.md");

    await user.click(screen.getByRole("button", { name: "Use template" }));
    // The pending files render with per-file removal.
    const pending = screen.getByRole("list", { name: "Starter files" });
    expect(pending).toHaveTextContent("skills/research-assistant/SKILL.md");
    await user.click(
      screen.getByRole("button", { name: "Remove starter file notes.md" }),
    );
    expect(pending).not.toHaveTextContent("notes.md");

    await user.click(screen.getByRole("button", { name: "Create Bot" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        starterFiles: [
          { path: "skills/research-assistant/SKILL.md", contents: "# How I work" },
        ],
      }),
    );
  });

  it("rejects a template with an unknown version and applies nothing", async () => {
    const user = userEvent.setup();
    render(<BotEditor {...createProps} />);

    await user.click(screen.getByRole("button", { name: "paste JSON instead" }));
    await user.click(screen.getByLabelText("Template JSON"));
    await user.paste(JSON.stringify({ ...template, version: 99 }));
    await user.click(screen.getByRole("button", { name: "Preview template" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/version/i);
    expect(
      screen.queryByRole("button", { name: "Use template" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("never clobbers a hand-typed role description without confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<BotEditor {...createProps} />);

    const roleField = screen.getByLabelText("Role description");
    await user.clear(roleField);
    await user.type(roleField, "My own bespoke role");

    await user.click(screen.getByRole("button", { name: "paste JSON instead" }));
    await user.click(screen.getByLabelText("Template JSON"));
    await user.paste(JSON.stringify(template));
    await user.click(screen.getByRole("button", { name: "Preview template" }));
    await user.click(screen.getByRole("button", { name: "Use template" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(roleField).toHaveValue("My own bespoke role");
  });

  it("loads a template from a file into the paste box and previews it", async () => {
    const user = userEvent.setup();
    render(<BotEditor {...createProps} />);

    await user.click(screen.getByRole("button", { name: "paste JSON instead" }));
    const file = new File([JSON.stringify(template)], "research-assistant.template.json", {
      type: "application/json",
    });
    await user.upload(screen.getByLabelText("Load template file"), file);

    const preview = await screen.findByRole("group", {
      name: "Imported template contents",
    });
    expect(preview).toHaveTextContent("Research Assistant");
    expect(screen.getByLabelText("Template JSON")).toHaveValue(
      JSON.stringify(template),
    );
  });
});
