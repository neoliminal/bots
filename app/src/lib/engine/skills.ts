// Authored skills: markdown instruction packs a bot follows without gaining
// any new capability (tool-extensibility spec, "Authored skills"; design
// D5). A skill lives in the bot's workspace at skills/<name>/SKILL.md with
// `---` frontmatter (name, description) and a markdown body. Enabled skills
// are injected into the system prompt under a SKILLS section, bounded by a
// character budget; over budget, bodies are elided (deterministic order)
// and the bot is told it can read the full text with workspace_read.
//
// Filesystem access is injected (the engine never imports lib/native), so
// tests supply fakes and integration wires the workspace tools' backend.
import type { Bot } from "./types";

/** One parsed skill pack. */
export interface SkillPack {
  /** Frontmatter `name:` (falls back to the skills/<dir> name). */
  name: string;
  /** Frontmatter `description:` one-liner. */
  description: string;
  /** Markdown body below the frontmatter. */
  body: string;
  /** Workspace-relative path of the SKILL.md (for workspace_read pointers). */
  path: string;
}

/** Total character budget for the SKILLS section (design D5). */
export const SKILLS_CHAR_BUDGET = 8000;

const SKILL_PATH_RE = /^skills\/([^/]+)\/SKILL\.md$/;

/**
 * True for a workspace path whose contents can become part of the bot's own
 * system prompt. Anything under `skills/` qualifies, not just a well-formed
 * SKILL.md, because a write there is a write toward the prompt — the policy
 * hook has to decide before the file exists to be parsed.
 *
 * Matched leniently on purpose (leading `./`, backslashes, any case): this
 * guards a security boundary, so near-misses must land on the safe side.
 */
export function isSkillPath(path: string): boolean {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  return normalized === "skills" || normalized.startsWith("skills/");
}

/**
 * Parse one SKILL.md. Returns null when the frontmatter is malformed
 * (missing/unterminated `---` block) — the file is skipped rather than
 * injecting garbage into the prompt.
 */
export function parseSkillMd(path: string, raw: string): SkillPack | null {
  const match = SKILL_PATH_RE.exec(path);
  if (!match) return null;
  const dirName = match[1]!;

  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return null;

  let name = dirName;
  let description = "";
  for (const line of lines.slice(1, end)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "name" && value !== "") name = value;
    if (key === "description") description = value;
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { name, description, body, path };
}

/** Filesystem surface the discovery needs (workspace-tool backed). */
export interface SkillsFs {
  /** List workspace-relative file paths (directories excluded). */
  listPaths(botId: string): Promise<string[]>;
  readFile(botId: string, path: string): Promise<string>;
}

/**
 * Discover every well-formed skill in a bot's workspace (each
 * skills/<dir>/SKILL.md). Malformed packs are skipped; read errors skip the
 * file rather than throw.
 */
export async function discoverSkills(fs: SkillsFs, botId: string): Promise<SkillPack[]> {
  const paths = (await fs.listPaths(botId)).filter((p) => SKILL_PATH_RE.test(p));
  const packs: SkillPack[] = [];
  for (const path of paths.sort()) {
    try {
      const parsed = parseSkillMd(path, await fs.readFile(botId, path));
      if (parsed) packs.push(parsed);
    } catch {
      // Unreadable file — skip; skills must never break the run.
    }
  }
  return packs;
}

/**
 * The skills a bot has enabled, in deterministic priority order: the bot's
 * explicit enabledSkills list order when present (unknown names ignored),
 * else every discovered skill in discovery (path-sorted) order — dropping
 * a SKILL.md into the workspace enables it by default.
 */
export function enabledSkills(bot: Bot, discovered: SkillPack[]): SkillPack[] {
  const list = bot.enabledSkills;
  if (list === undefined) return discovered;
  const byName = new Map(discovered.map((s) => [s.name, s]));
  return list.map((name) => byName.get(name)).filter((s): s is SkillPack => s !== undefined);
}

/**
 * Render the SKILLS prompt section within the character budget. Skills are
 * included in order; once a skill's full text would cross the budget, that
 * skill and all later ones are elided to name+description lines with an
 * explicit notice that the full text is readable via workspace_read.
 * Returns "" when nothing is enabled.
 */
export function renderSkillsSection(
  skills: SkillPack[],
  budget: number = SKILLS_CHAR_BUDGET,
): string {
  if (skills.length === 0) return "";
  const header =
    "SKILLS — documented procedures you follow. They never grant new tools " +
    "or permissions; your tool policy always applies:";
  const parts: string[] = [];
  const elided: SkillPack[] = [];
  let used = header.length;
  let overflowed = false;
  for (const skill of skills) {
    const block = `## ${skill.name}${skill.description ? ` — ${skill.description}` : ""}\n${skill.body}`;
    if (!overflowed && used + block.length <= budget) {
      parts.push(block);
      used += block.length;
    } else {
      overflowed = true;
      elided.push(skill);
    }
  }
  if (elided.length > 0) {
    const lines = elided
      .map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""} (read: ${s.path})`)
      .join("\n");
    parts.push(
      "The following enabled skills were elided for space. Read the full " +
        `text with workspace_read before relying on them:\n${lines}`,
    );
  }
  return `${header}\n\n${parts.join("\n\n")}`;
}
