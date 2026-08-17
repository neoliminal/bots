// App-level tool registry: the concrete tools every bot can call, wired to
// the native (Tauri) capability layer plus the engine's memory tools.
//
// Gating follows the safe-action boundaries specs (task-execution,
// human-handoff) via tool-extensibility action categories: reversible,
// user-visible actions run autonomously; sensitive or hard-to-reverse
// actions (sending external email, permanent deletes) resolve to
// require-approval and park a PendingApproval until the user decides.

import { isSkillPath, registerMemoryTools, ToolRegistry, type EngineTool } from "../lib/engine";
import {
  isTauri,
  webFetch,
  workspaceDelete,
  workspaceListDetailed,
  workspaceRead,
  workspaceWrite,
} from "../lib/native";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

const workspaceListTool: EngineTool = {
  name: "workspace_list",
  description:
    "List every file in your private workspace — your persistent scratch " +
    "space on this computer. Use this first, before reading or writing, to " +
    "see what already exists. Returns one line per entry (path and size).",
  parameters: { type: "object", properties: {} },
  category: "read",
  run: async (_args, ctx) => {
    const { entries, truncated } = await workspaceListDetailed(ctx.bot.id);
    if (entries.length === 0) return "Workspace is empty.";
    const lines = entries.map((e) =>
      e.isDir ? `${e.path}/ (dir)` : `${e.path} (${e.size} bytes)`,
    );
    // The walker stops at a depth/entry cap; say so rather than letting the
    // model conclude the workspace is smaller than it is.
    if (truncated) {
      lines.push(
        "(listing truncated — the workspace is deeper or larger than the " +
          "listing limit; narrow your search with session_exec if you need more)",
      );
    }
    return lines.join("\n");
  },
};

const workspaceReadTool: EngineTool = {
  name: "workspace_read",
  description:
    "Read a UTF-8 text file from your workspace. Use it to load notes, " +
    "drafts, or data you saved in earlier sessions. `path` is " +
    "workspace-relative, e.g. \"notes/plan.md\".",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
    },
    required: ["path"],
  },
  category: "read",
  // File contents are not authored by the user: sessions sync files back,
  // fetches get saved here, other tools write here. Treat as untrusted.
  untrustedOutput: true,
  run: async (args, ctx) => {
    const path = stringArg(args, "path").trim();
    if (path === "") return "Error: workspace_read requires a non-empty path.";
    const text = await workspaceRead(ctx.bot.id, path);
    return text.length > 0 ? text : `(${path} is empty)`;
  },
};

const workspaceWriteTool: EngineTool = {
  name: "workspace_write",
  description:
    "Create or overwrite a UTF-8 text file in your workspace. Use it to " +
    "save drafts, notes, and working data that should survive between " +
    "sessions. Parent folders are created automatically. Prefer this over " +
    "pasting long artifacts into chat.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  category: "workspace-mutate",
  // A write under skills/ is not an ordinary file write: authored skills are
  // auto-discovered and spliced into this bot's system prompt on every later
  // run, so the file IS an instruction to its future self. Classifying it
  // self-modify makes it pause once untrusted content is in the run.
  classify: (args) => (isSkillPath(stringArg(args, "path")) ? "self-modify" : undefined),
  run: async (args, ctx) => {
    const path = stringArg(args, "path").trim();
    if (path === "") return "Error: workspace_write requires a non-empty path.";
    const content = stringArg(args, "content");
    await workspaceWrite(ctx.bot.id, path, content);
    return `Wrote ${content.length} characters to ${path}.`;
  },
};

const workspaceDeleteTool: EngineTool = {
  name: "workspace_delete",
  description:
    "Permanently delete a file or folder (recursive) from your workspace. " +
    "This cannot be undone, so the user must approve it first — prefer " +
    "overwriting or renaming with workspace_write when that would do.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to delete." },
    },
    required: ["path"],
  },
  category: "bulk-delete",
  run: async (args, ctx) => {
    const path = stringArg(args, "path").trim();
    if (path === "") return "Error: workspace_delete requires a non-empty path.";
    await workspaceDelete(ctx.bot.id, path);
    return `Deleted ${path} from your workspace.`;
  },
};

const webFetchTool: EngineTool = {
  name: "web_fetch",
  description:
    "Fetch a public https:// URL with a GET request and return its text " +
    "content (HTML is stripped, ~1MB cap). Use it to look up current " +
    "information, documentation, or a page the user mentions. It cannot " +
    "log in or call APIs that need credentials.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute https:// URL to fetch." },
    },
    required: ["url"],
  },
  // Not "read": a fetch is also EGRESS — the URL carries whatever the bot
  // put in it. external-read escalates to approval once untrusted content
  // has entered the run, which closes the harvest-then-exfiltrate loop.
  category: "external-read",
  untrustedOutput: true,
  // Fetching goes through the Rust host; outside the desktop app the tool
  // is hidden entirely instead of failing at call time.
  available: () => isTauri(),
  run: async (args) => {
    const url = stringArg(args, "url").trim();
    if (!/^https:\/\//i.test(url)) {
      return "Error: web_fetch only supports absolute https:// URLs.";
    }
    const result = await webFetch(url);
    if (result.status === 0) {
      return "Error: web_fetch is unavailable outside the desktop app.";
    }
    return `HTTP ${result.status} (${result.contentType})\n\n${result.text}`;
  },
};

const sendEmailTool: EngineTool = {
  name: "send_email",
  description:
    "Send an email on the user's behalf. Sending is a sensitive external " +
    "action: the user is shown the exact recipient, subject, and body and " +
    "must approve before anything goes out. Use it only when the user asked " +
    "for an email to be sent; when exploring or drafting, show the draft in " +
    "chat instead.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address." },
      subject: { type: "string", description: "Subject line." },
      body: { type: "string", description: "Full plain-text email body." },
    },
    required: ["to", "subject", "body"],
  },
  category: "external-comms",
  run: (args) => {
    const to = stringArg(args, "to").trim();
    if (to === "") return "Error: send_email requires a 'to' recipient.";
    const subject = stringArg(args, "subject").trim();
    const body = stringArg(args, "body");
    return (
      `Email sent to ${to}` +
      (subject !== "" ? ` — "${subject}"` : "") +
      ` (${body.length} characters). ` +
      "[mock transport: recorded as sent; no real email left this machine]"
    );
  },
};

/** Register the full app tool set (idempotent — replaces by name). */
export function registerAppTools(registry: ToolRegistry): void {
  registry.register(workspaceListTool);
  registry.register(workspaceReadTool);
  registry.register(workspaceWriteTool);
  registry.register(workspaceDeleteTool);
  registry.register(webFetchTool);
  registry.register(sendEmailTool);
  registerMemoryTools(registry);
}

/** App-wide tool registry offered to every bot by the chat glue's run loop. */
export const appToolRegistry = new ToolRegistry();
registerAppTools(appToolRegistry);
