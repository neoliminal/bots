// Modal for creating and editing a bot: name, color (curated palette +
// custom), role description, and primary model. Edit mode adds
// pause/resume and soft delete (with inline confirmation).
//
// Role description first guess (spec: openspec/specs/bot-management): in
// create mode the role textarea is pre-filled with the top suggestion and
// suggestion chips beneath it swap in alternative roles; edit mode keeps
// the chips but never pre-fills over the bot's existing description.

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ModelPicker } from "../features/models";
import { AVATAR_PALETTE, BotAvatar } from "../features/avatars";
import { chatStore } from "../features/chat";
import {
  buildTemplateFromBot,
  DEFAULT_CATEGORY_RULES,
  discoverSkills,
  parseTemplate,
  serializeTemplate,
  templatePrefill,
  useBotsStore,
  type ActionCategory,
  type PersonaTemplate,
  type PolicyRule,
  type SkillPack,
  type TemplateFile,
  type ToolPolicy,
} from "../lib/engine";
import { saveTextFile, workspaceList, workspaceRead } from "../lib/native";
import { CapabilityCardPanel } from "./CapabilityCardPanel";
import { MemoryPanel } from "./MemoryPanel";
import {
  collectRecentUserMessages,
  suggestRoles,
  type RoleSuggestion,
} from "./roleSuggestions";

/**
 * Curated avatar palette (owned by the avatars feature — the juicy gradient
 * set from docs/design/visual-style.md); a custom color input sits alongside.
 */
export const BOT_PALETTE = AVATAR_PALETTE;

// Note: there is no coordinator toggle — the multi-bot-collaboration
// redesign made the Executive Assistant a ROLE (see roleSuggestions.ts),
// not a mechanism. Every bot can delegate via contact_bot.
export interface BotEditorValues {
  name: string;
  color: string;
  roleDescription: string;
  primaryModelId: string;
  /** Per-bot tool policy; undefined means platform defaults (allow all). */
  toolPolicy?: ToolPolicy;
  /**
   * Enabled authored skills (edit mode only): undefined = every workspace
   * skill enabled (default); an explicit list enables only those names.
   */
  enabledSkills?: string[];
  /**
   * Starter workspace files from an applied persona template (create mode):
   * written into the new bot's workspace after creation. Each is removable
   * before submitting.
   */
  starterFiles?: TemplateFile[];
}

/**
 * Tool groups surfaced in the policy section (bot-management "Bot
 * configuration"; enforcement per tool-extensibility). `floor` marks
 * hard-floor categories that can never be loosened below "Ask first".
 */
export const POLICY_CATEGORIES: Array<{
  category: ActionCategory;
  label: string;
  floor?: boolean;
}> = [
  { category: "read", label: "Read local files" },
  { category: "external-read", label: "Look things up on the web" },
  { category: "workspace-mutate", label: "Write files & notes" },
  { category: "self-modify", label: "Change its own memory & skills" },
  { category: "shell-local", label: "Shell on your own machines" },
  { category: "shell-session", label: "Shell in cloud session" },
  { category: "external-comms", label: "External messages & connectors" },
  { category: "delegation", label: "Delegate to teammates" },
  { category: "bulk-delete", label: "Permanent deletion", floor: true },
  { category: "credential", label: "Enter passwords & codes", floor: true },
  { category: "payment", label: "Confirm payments", floor: true },
];

const RULE_LABELS: Record<PolicyRule, string> = {
  allow: "Allowed",
  approve: "Ask first",
  deny: "Blocked",
};

export interface BotEditorProps {
  title: string;
  submitLabel: string;
  initial: BotEditorValues;
  reduceMotion?: boolean;
  onSubmit: (values: BotEditorValues) => void;
  onCancel: () => void;
  /** Edit-mode extras; omitted in create mode. */
  /** Bot being edited; renders the memory panel when set. */
  botId?: string;
  paused?: boolean;
  onTogglePause?: () => void;
  onDelete?: () => void;
  /**
   * Role suggestion chips. Defaults to suggestRoles() wired to the live
   * bots roster and the last ~50 user messages from the chat store.
   */
  suggestions?: RoleSuggestion[];
  /**
   * Workspace skills shown in the Skills section (edit mode). Defaults to
   * discovering skills/<dir>/SKILL.md in the bot's workspace; tests inject.
   */
  availableSkills?: SkillPack[];
}

/** Call-site wiring: suggestions from the live roster and recent chat history. */
function defaultSuggestions(): RoleSuggestion[] {
  return suggestRoles({
    existingBots: useBotsStore.getState().bots.filter((b) => !b.deletedAt),
    recentUserMessages: collectRecentUserMessages(chatStore.getState().threads),
  });
}

const inputClass =
  "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm " +
  "outline-none focus:border-[#007aff] focus:ring-2 focus:ring-[#007aff]/20 " +
  "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

export function BotEditor({
  title,
  submitLabel,
  initial,
  reduceMotion,
  onSubmit,
  onCancel,
  botId,
  paused,
  onTogglePause,
  onDelete,
  suggestions: suggestionsProp,
  availableSkills,
}: BotEditorProps) {
  const isEditMode = Boolean(onTogglePause || onDelete);
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [suggestions] = useState<RoleSuggestion[]>(
    () => suggestionsProp ?? defaultSuggestions(),
  );
  // Create mode never starts from a blank role description: pre-fill with
  // the top suggestion. Edit mode always shows the bot's own description.
  const [roleDescription, setRoleDescription] = useState(() =>
    !isEditMode && initial.roleDescription === ""
      ? (suggestions[0]?.description ?? "")
      : initial.roleDescription,
  );
  // True when the textarea holds user-authored text (typed here, or an
  // existing description in edit mode); chips then confirm before replacing.
  const [roleEdited, setRoleEdited] = useState(
    () => isEditMode && initial.roleDescription.trim() !== "",
  );
  const [primaryModelId, setPrimaryModelId] = useState(initial.primaryModelId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy | undefined>(
    initial.toolPolicy,
  );

  const [enabledSkills, setEnabledSkills] = useState<string[] | undefined>(
    initial.enabledSkills,
  );
  const [skills, setSkills] = useState<SkillPack[]>(availableSkills ?? []);

  // Persona templates (bot-management spec, "Persona templates" / "Export Bot
  // as template"). Export previews the exact file contents before any write;
  // import is inert — pasted/loaded JSON is only parsed and shown, and
  // touches the form fields only when the user applies it.
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [exportSavedTo, setExportSavedTo] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Paste is the secondary path (design pillar: minimize typing) — the
  // Import button goes straight to the file picker.
  const [pasteOpen, setPasteOpen] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importedTemplate, setImportedTemplate] =
    useState<PersonaTemplate | null>(null);
  // Starter files from an applied template, pending until the bot is created;
  // each can be removed before submitting (spec: everything stays editable).
  const [starterFiles, setStarterFiles] = useState<TemplateFile[]>(
    initial.starterFiles ?? [],
  );

  // Built from the editor's shareable fields only (name + role description);
  // memories, threads, and credentials are structurally absent.
  const exportJson = serializeTemplate(
    buildTemplateFromBot({ name, roleDescription }),
  );

  const downloadTemplateFile = async () => {
    const slug =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "bot";
    const fileName = `${slug}.template.json`;
    setExportError(null);
    setExportSavedTo(null);
    // Desktop app (the primary surface): WKWebView ignores anchor
    // `download` clicks, so the file is written natively to Downloads.
    try {
      const savedPath = await saveTextFile(fileName, exportJson);
      if (savedPath !== null) {
        setExportSavedTo(savedPath);
        return;
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      return;
    }
    // Browser fallback (dev server / tests): a plain anchor download.
    const url = URL.createObjectURL(
      new Blob([exportJson], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const previewImport = (text: string) => {
    const result = parseTemplate(text);
    if (result.ok) {
      setImportedTemplate(result.template);
      setImportError(null);
    } else {
      setImportedTemplate(null);
      setImportError(result.error);
    }
  };

  const handleTemplateFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setImportText(text);
      previewImport(text);
    };
    reader.readAsText(file);
  };

  const applyTemplate = (template: PersonaTemplate) => {
    const prefill = templatePrefill(template);
    if (
      roleEdited &&
      roleDescription.trim() !== "" &&
      !window.confirm(
        `Replace your role description with the "${template.role}" template?`,
      )
    ) {
      return;
    }
    if (name.trim() === "") setName(prefill.name);
    setRoleDescription(prefill.roleDescription);
    setRoleEdited(false);
    setStarterFiles(prefill.starterFiles);
  };

  // Edit mode discovers the bot's workspace skills unless injected.
  useEffect(() => {
    if (availableSkills !== undefined || botId === undefined) return;
    let cancelled = false;
    void discoverSkills(
      {
        listPaths: async (id) =>
          (await workspaceList(id)).filter((e) => !e.isDir).map((e) => e.path),
        readFile: (id, path) => workspaceRead(id, path),
      },
      botId,
    )
      .then((packs) => {
        if (!cancelled) setSkills(packs);
      })
      .catch(() => {
        // Discovery is best-effort; an empty list just hides the section.
      });
    return () => {
      cancelled = true;
    };
  }, [availableSkills, botId]);

  const skillEnabled = (name: string): boolean =>
    enabledSkills === undefined || enabledSkills.includes(name);

  const toggleSkill = (name: string) => {
    const effective = skills.filter((s) => skillEnabled(s.name)).map((s) => s.name);
    const next = effective.includes(name)
      ? effective.filter((n) => n !== name)
      : [...effective, name];
    // Back to "all enabled" collapses to the default (undefined).
    setEnabledSkills(next.length === skills.length ? undefined : next);
  };

  const setCategoryRule = (category: ActionCategory, rule: PolicyRule | "") => {
    const categories = { ...toolPolicy?.categories };
    if (rule === "") delete categories[category];
    else categories[category] = rule;
    const next: ToolPolicy = {
      ...(toolPolicy?.tools !== undefined ? { tools: toolPolicy.tools } : {}),
      ...(Object.keys(categories).length > 0 ? { categories } : {}),
    };
    setToolPolicy(Object.keys(next).length > 0 ? next : undefined);
  };

  const applySuggestion = (suggestion: RoleSuggestion) => {
    if (roleDescription === suggestion.description) return;
    if (
      roleEdited &&
      roleDescription.trim() !== "" &&
      !window.confirm(
        `Replace your role description with the "${suggestion.title}" role?`,
      )
    ) {
      return;
    }
    setRoleDescription(suggestion.description);
    setRoleEdited(false);
  };

  const canSubmit = name.trim() !== "";

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      color,
      roleDescription: roleDescription.trim(),
      primaryModelId,
      ...(toolPolicy !== undefined ? { toolPolicy } : {}),
      ...(enabledSkills !== undefined ? { enabledSkills } : {}),
      ...(starterFiles.length > 0 ? { starterFiles } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="flex items-center gap-4">
              <BotAvatar
                color={color}
                state="idle"
                size={56}
                reduceMotion={reduceMotion}
                label={name.trim() === "" ? "New bot" : name.trim()}
              />
              <div className="flex-1">
                <label
                  htmlFor="bot-name"
                  className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400"
                >
                  Name
                </label>
                <input
                  id="bot-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Scout"
                  autoFocus
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Color
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {BOT_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                      color === c
                        ? "border-[#007aff] ring-2 ring-[#007aff]/30"
                        : "border-transparent"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  <input
                    type="color"
                    aria-label="Custom color"
                    value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#888888"}
                    onChange={(e) => setColor(e.target.value)}
                    className="h-7 w-7 cursor-pointer rounded border border-neutral-300 bg-transparent p-0.5 dark:border-neutral-700"
                  />
                  Custom
                </label>
              </div>
            </div>

            <div>
              <label
                htmlFor="bot-role"
                className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400"
              >
                Role description
              </label>
              <textarea
                id="bot-role"
                value={roleDescription}
                onChange={(e) => {
                  setRoleDescription(e.target.value);
                  setRoleEdited(true);
                }}
                rows={3}
                placeholder="What is this bot's job? e.g. Research accounts overnight and summarize buying intent."
                className={`${inputClass} resize-none`}
              />
              {suggestions.length > 0 && (
                <div
                  role="group"
                  aria-label="Role suggestions"
                  className="mt-2 flex flex-wrap gap-1.5"
                >
                  {suggestions.map((s) => (
                    <button
                      key={s.title}
                      type="button"
                      onClick={() => applySuggestion(s)}
                      aria-pressed={roleDescription === s.description}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                        roleDescription === s.description
                          ? "border-[#007aff] bg-[#007aff]/10 text-[#007aff] dark:bg-sky-950/40 dark:text-sky-300"
                          : "border-neutral-200 text-neutral-600 hover:bg-[#f2f2f7] dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!isEditMode && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Start from a template
                </span>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json,application/json"
                  aria-label="Load template file"
                  onChange={(e) => {
                    setImportOpen(true);
                    handleTemplateFile(e);
                  }}
                  className="hidden"
                />
                {!importOpen ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => importFileRef.current?.click()}
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      Import template…
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setImportOpen(true);
                        setPasteOpen(true);
                      }}
                      className="text-xs text-neutral-400 underline-offset-2 hover:underline dark:text-neutral-500"
                    >
                      paste JSON instead
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                    <p className="text-xs text-neutral-400 dark:text-neutral-500">
                      Nothing runs on import — review the contents below, then
                      choose whether to use them.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => importFileRef.current?.click()}
                        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                      >
                        Choose file…
                      </button>
                      {!pasteOpen && (
                        <button
                          type="button"
                          onClick={() => setPasteOpen(true)}
                          className="text-xs text-neutral-400 underline-offset-2 hover:underline dark:text-neutral-500"
                        >
                          paste JSON instead
                        </button>
                      )}
                    </div>
                    {pasteOpen && (
                      <>
                        <textarea
                          aria-label="Template JSON"
                          value={importText}
                          onChange={(e) => {
                            setImportText(e.target.value);
                            setImportError(null);
                            setImportedTemplate(null);
                          }}
                          rows={4}
                          placeholder='{"version": 1, "role": "…", "instructions": "…"}'
                          className={`${inputClass} resize-none font-mono text-xs`}
                        />
                        <button
                          type="button"
                          onClick={() => previewImport(importText)}
                          disabled={importText.trim() === ""}
                          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                        >
                          Preview template
                        </button>
                      </>
                    )}
                    {importError !== null && (
                      <p role="alert" className="text-xs text-red-500">
                        {importError}
                      </p>
                    )}
                    {importedTemplate !== null && (
                      <div
                        role="group"
                        aria-label="Imported template contents"
                        className="space-y-1.5 rounded-lg border border-neutral-200 bg-[#f2f2f7] p-3 dark:border-neutral-700 dark:bg-neutral-800/60"
                      >
                        <p className="text-sm text-neutral-700 dark:text-neutral-200">
                          <span className="font-medium">Role:</span>{" "}
                          {importedTemplate.role}
                        </p>
                        {importedTemplate.description !== "" && (
                          <p className="whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-200">
                            <span className="font-medium">Description:</span>{" "}
                            {importedTemplate.description}
                          </p>
                        )}
                        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                          Instructions:
                        </p>
                        <p className="whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300">
                          {importedTemplate.instructions === ""
                            ? "(none)"
                            : importedTemplate.instructions}
                        </p>
                        {importedTemplate.starterFiles.length > 0 && (
                          <>
                            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                              Starter files:
                            </p>
                            <ul
                              aria-label="Template starter files"
                              className="space-y-0.5"
                            >
                              {importedTemplate.starterFiles.map((file) => (
                                <li
                                  key={file.path}
                                  className="font-mono text-xs text-neutral-600 dark:text-neutral-300"
                                >
                                  {file.path}{" "}
                                  <span className="text-neutral-400 dark:text-neutral-500">
                                    ({file.contents.length} chars)
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => applyTemplate(importedTemplate)}
                          className="mt-1 rounded-full bg-[#007aff] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#0a66d0]"
                        >
                          Use template
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isEditMode && starterFiles.length > 0 && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Starter files
                </span>
                <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                  From the applied template — created in the new bot&apos;s
                  workspace. Remove any you don&apos;t want.
                </p>
                <ul
                  aria-label="Starter files"
                  className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
                >
                  {starterFiles.map((file) => (
                    <li
                      key={file.path}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-neutral-600 dark:text-neutral-300">
                        {file.path}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove starter file ${file.path}`}
                        onClick={() =>
                          setStarterFiles((files) =>
                            files.filter((f) => f.path !== file.path),
                          )
                        }
                        className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Primary model
              </span>
              <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                Current: <code className="font-mono">{primaryModelId}</code>
              </p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <ModelPicker
                  selectedModelId={primaryModelId}
                  onSelect={(model) => setPrimaryModelId(model.id)}
                  requireTools
                  autoFocusSearch={false}
                />
              </div>
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Tool access
              </span>
              <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                What this bot may do, by tool group. Tools in a blocked group
                are hidden from the bot entirely. Sensitive groups always ask
                first — they can be blocked, but never set to run silently.
              </p>
              <div
                role="group"
                aria-label="Tool access"
                className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
              >
                {POLICY_CATEGORIES.map(({ category, label, floor }) => {
                  const explicit = toolPolicy?.categories?.[category];
                  const effectiveDefault = RULE_LABELS[DEFAULT_CATEGORY_RULES[category]];
                  return (
                    <div
                      key={category}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="text-sm text-neutral-700 dark:text-neutral-200">
                        {label}
                      </span>
                      <select
                        aria-label={`${label} access`}
                        value={explicit ?? ""}
                        onChange={(e) =>
                          setCategoryRule(category, e.target.value as PolicyRule | "")
                        }
                        className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                      >
                        <option value="">Default ({effectiveDefault})</option>
                        {!floor && <option value="allow">Allowed</option>}
                        <option value="approve">Ask first</option>
                        <option value="deny">Blocked</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {isEditMode && skills.length > 0 && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Skills
                </span>
                <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                  Documented procedures from this bot&apos;s workspace
                  (skills folder). Enabled skills guide how the bot works —
                  they never grant new tools or permissions.
                </p>
                <div
                  role="group"
                  aria-label="Skills"
                  className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
                >
                  {skills.map((skill) => (
                    <label
                      key={skill.name}
                      className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-neutral-700 dark:text-neutral-200">
                          {skill.name}
                        </span>
                        {skill.description !== "" && (
                          <span className="block truncate text-xs text-neutral-400 dark:text-neutral-500">
                            {skill.description}
                          </span>
                        )}
                      </span>
                      <input
                        type="checkbox"
                        aria-label={`Skill ${skill.name} enabled`}
                        checked={skillEnabled(skill.name)}
                        onChange={() => toggleSkill(skill.name)}
                        className="h-4 w-4 accent-[#007aff]"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {isEditMode && botId !== undefined && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Capability card
                </span>
                <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                  What teammates see when deciding whom to hand work to. The
                  experience summary is compiled from this bot&apos;s completed
                  work — you can pin your own wording or revert to the
                  auto-summary.
                </p>
                <CapabilityCardPanel botId={botId} />
              </div>
            )}

            {isEditMode && botId !== undefined && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Memory
                </span>
                <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                  Durable notes this bot has saved. Edits and deletions apply
                  immediately.
                </p>
                <MemoryPanel botId={botId} />
              </div>
            )}

            {isEditMode && (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Template
                </span>
                <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">
                  Share this bot&apos;s persona as a plain JSON file. Templates
                  carry the role and instructions only — never memories,
                  threads, or credentials.
                </p>
                {!showExportPreview ? (
                  <button
                    type="button"
                    onClick={() => setShowExportPreview(true)}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    Export as template…
                  </button>
                ) : (
                  <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                    <p className="text-xs text-neutral-400 dark:text-neutral-500">
                      Exactly what the template file will contain:
                    </p>
                    <pre
                      aria-label="Template contents"
                      className="max-h-48 overflow-auto rounded-lg bg-[#f2f2f7] p-3 font-mono text-xs text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200"
                    >
                      {exportJson}
                    </pre>
                    {exportSavedTo !== null && (
                      <p
                        role="status"
                        className="break-all text-xs text-emerald-600 dark:text-emerald-400"
                      >
                        Saved to {exportSavedTo}
                      </p>
                    )}
                    {exportError !== null && (
                      <p role="alert" className="text-xs text-red-500">
                        Could not save the template file: {exportError}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void downloadTemplateFile()}
                        className="rounded-full bg-[#007aff] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#0a66d0]"
                      >
                        Save template file
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowExportPreview(false)}
                        className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        Close preview
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {(onTogglePause || onDelete) && (
              <div className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
                {onTogglePause && (
                  <button
                    type="button"
                    onClick={onTogglePause}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    {paused ? "Resume bot" : "Pause bot"}
                  </button>
                )}
                {onDelete &&
                  (confirmingDelete ? (
                    <span className="flex items-center gap-2 text-sm">
                      <span className="text-red-500">Delete this bot?</span>
                      <button
                        type="button"
                        onClick={onDelete}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(false)}
                        className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(true)}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      Delete…
                    </button>
                  ))}
              </div>
            )}
          </div>

          <footer className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-full bg-[#007aff] px-4 py-2 text-sm font-medium text-white hover:bg-[#0a66d0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
