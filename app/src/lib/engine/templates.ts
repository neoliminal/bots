// Persona templates (bot-management spec, "Persona templates" / "Export Bot
// as template"; design: openspec/changes/add-teammate-approachability/design.md):
// plain, inspectable JSON files with a versioned schema. Import is inert —
// parsing never executes anything — and export is built exclusively from a
// bot's shareable fields, so memories, threads, and credentials are
// structurally absent rather than filtered out.

import type { Bot } from "./types";

/** Only schema version this build reads or writes. */
export const TEMPLATE_VERSION = 1;

/** Per-file size cap (bytes of text) for starter workspace files. */
export const MAX_STARTER_FILE_BYTES = 256 * 1024;

/** Maximum number of starter files a template may bundle. */
export const MAX_STARTER_FILES = 32;

/**
 * One optional starter workspace file bundled in a template. Files are plain
 * text and land in the created bot's workspace; paths are workspace-relative
 * and validated on import (no absolute paths, no `..` escapes).
 */
export interface TemplateFile {
  path: string;
  contents: string;
}

/**
 * Versioned persona template (delta spec: role title, role description,
 * standing instructions, and optional starter workspace files).
 *
 * - `role`: role title; doubles as the name suggestion on import.
 * - `description`: optional short human-readable summary. Bots don't store a
 *   separate summary, so exports leave it empty; hand-authored templates may
 *   fill it in.
 * - `instructions`: standing instructions; prefills the role description on
 *   import (bots use the role description as standing context).
 * - `starterFiles`: optional starter workspace files, created in the new
 *   bot's workspace when the template is applied ([] when absent).
 */
export interface PersonaTemplate {
  version: typeof TEMPLATE_VERSION;
  role: string;
  description: string;
  instructions: string;
  starterFiles: TemplateFile[];
}

export type TemplateParseResult =
  | { ok: true; template: PersonaTemplate }
  | { ok: false; error: string };

/**
 * Build a template from a bot. The parameter type is the whole export
 * surface: nothing beyond `name` and `roleDescription` can reach a template,
 * which is what keeps memories/threads/credentials structurally excluded.
 * Exports carry no starter files (the export requirement covers role,
 * description, and instructions only); hand-authored templates may add them.
 */
export function buildTemplateFromBot(
  bot: Pick<Bot, "name" | "roleDescription">,
): PersonaTemplate {
  return {
    version: TEMPLATE_VERSION,
    role: bot.name.trim(),
    description: "",
    instructions: bot.roleDescription.trim(),
    starterFiles: [],
  };
}

/** Stable, human-diffable JSON with a fixed key order. */
export function serializeTemplate(template: PersonaTemplate): string {
  return `${JSON.stringify(
    {
      version: template.version,
      role: template.role,
      description: template.description,
      instructions: template.instructions,
      // Omitted entirely when empty: exports stay minimal and diff-friendly.
      ...(template.starterFiles.length > 0
        ? {
            starterFiles: template.starterFiles.map((f) => ({
              path: f.path,
              contents: f.contents,
            })),
          }
        : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * A starter-file path must be a non-empty relative path with no `..`
 * component, no backslashes, and no NUL — the same shape the workspace fs
 * accepts. Returns an error string or null.
 */
function starterPathError(path: string): string | null {
  if (path.trim() === "") return "a starter file has an empty path";
  if (path.includes("\0")) return `starter file path ${JSON.stringify(path)} contains a NUL byte`;
  if (path.includes("\\")) return `starter file path ${JSON.stringify(path)} must use "/" separators`;
  if (path.startsWith("/") || path.startsWith("~")) {
    return `starter file path ${JSON.stringify(path)} must be relative`;
  }
  if (path.split("/").some((part) => part === "..")) {
    return `starter file path ${JSON.stringify(path)} must not contain ".."`;
  }
  return null;
}

/** Validate the raw starterFiles value. Returns the files or an error. */
function parseStarterFiles(
  raw: unknown,
): { ok: true; files: TemplateFile[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, files: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Template starterFiles must be a list of files." };
  }
  if (raw.length > MAX_STARTER_FILES) {
    return {
      ok: false,
      error: `Template bundles too many starter files (max ${MAX_STARTER_FILES}).`,
    };
  }
  const files: TemplateFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "Each starter file must be an object with path and contents." };
    }
    const { path, contents } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof contents !== "string") {
      return { ok: false, error: "Each starter file needs a text path and text contents." };
    }
    const pathError = starterPathError(path);
    if (pathError !== null) return { ok: false, error: `Invalid template: ${pathError}.` };
    if (contents.length > MAX_STARTER_FILE_BYTES) {
      return {
        ok: false,
        error: `Starter file ${JSON.stringify(path)} is too large (max ${MAX_STARTER_FILE_BYTES / 1024}KB).`,
      };
    }
    if (seen.has(path)) {
      return { ok: false, error: `Starter file ${JSON.stringify(path)} appears twice.` };
    }
    seen.add(path);
    // Rebuilt field-by-field: only path + contents survive parsing.
    files.push({ path, contents });
  }
  return { ok: true, files };
}

/**
 * Parse + validate template JSON. Never throws and never executes imported
 * content; unknown keys are dropped so foreign fields can't ride along into
 * a created bot. Unknown versions are rejected outright (never coerced), and
 * malformed starter files reject the template rather than being silently
 * dropped — everything a template carries is surfaced or refused.
 */
export function parseTemplate(json: string): TemplateParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Template must be a JSON object." };
  }
  const record = raw as Record<string, unknown>;

  if (record["version"] !== TEMPLATE_VERSION) {
    const got = record["version"];
    return {
      ok: false,
      error:
        got === undefined
          ? "Missing template version."
          : `Unsupported template version ${JSON.stringify(got)} — this app reads version ${TEMPLATE_VERSION}.`,
    };
  }

  const role = record["role"];
  if (typeof role !== "string" || role.trim() === "") {
    return { ok: false, error: "Template is missing a role title." };
  }
  const description = record["description"] ?? "";
  const instructions = record["instructions"] ?? "";
  if (typeof description !== "string" || typeof instructions !== "string") {
    return {
      ok: false,
      error: "Template description and instructions must be text.",
    };
  }
  const starterFiles = parseStarterFiles(record["starterFiles"]);
  if (!starterFiles.ok) return { ok: false, error: starterFiles.error };

  // Rebuilt field-by-field: only the schema keys survive parsing.
  return {
    ok: true,
    template: {
      version: TEMPLATE_VERSION,
      role: role.trim(),
      description,
      instructions,
      starterFiles: starterFiles.files,
    },
  };
}

/**
 * What an imported template prefills in the create-bot flow: the role title
 * as a name suggestion, description + instructions (whichever are non-empty)
 * as the editable role description, and the starter files to create in the
 * new bot's workspace.
 */
export function templatePrefill(template: PersonaTemplate): {
  name: string;
  roleDescription: string;
  starterFiles: TemplateFile[];
} {
  return {
    name: template.role,
    roleDescription: [template.description, template.instructions]
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .join("\n\n"),
    starterFiles: template.starterFiles,
  };
}
