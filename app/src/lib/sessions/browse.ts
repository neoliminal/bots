// DOM-driven browse tools for the personal-host provider.
// Spec: openspec/specs/agent-computer/spec.md — "DOM-driven browsing tools"
// and "Persistent browser profile as shared login state".
//
// Each tool call execs `node ~/.bots-host/browse.mjs <b64-request>` on the
// host through the session provider; the runner talks to (and auto-starts)
// the localhost-only Playwright daemon that holds the persistent profile.
// Categories per spec: goto/read = "read"; click/fill act inside a
// logged-in browser, so they are "external-comms" (approve-gated default).
import { classifyFormField } from "../engine/policy";
import type { EngineTool, ToolContext } from "../engine/tools";
import type { SessionProvider } from "./types";
import type { SessionManager } from "./store";
import { HOST_ROOT, shQuote } from "./host";

export interface BrowseToolsDeps {
  provider: SessionProvider;
  manager: SessionManager;
}

/** Names of the browse tools (used by the glue for (un)registration). */
export const BROWSE_TOOL_NAMES = [
  "browse_goto",
  "browse_read",
  "browse_click",
  "browse_fill",
] as const;

/**
 * Generous timeout: the first call may cold-start Chromium on the host
 * (the runner retries the daemon for up to ~20s before answering).
 */
const BROWSE_TIMEOUT_MS = 120_000;

interface BrowseResponse {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  elements?: { role: string; name: string }[];
  candidates?: { role: string; name: string }[];
  error?: string;
  [key: string]: unknown;
}

function encodeRequest(request: Record<string, unknown>): string {
  const json = JSON.stringify(request);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function listElements(
  label: string,
  elements: { role: string; name: string }[] | undefined,
): string {
  if (!elements || elements.length === 0) return "";
  const lines = elements.map((e) => `  - ${e.role}: ${e.name}`);
  return `\n${label}:\n${lines.join("\n")}`;
}

/** Model-readable rendering of a runner response. */
export function formatBrowseResponse(
  action: string,
  response: BrowseResponse,
): string {
  if (!response.ok) {
    const candidates = listElements(
      "Available elements",
      response.candidates,
    );
    return `Error: ${response.error ?? `${action} failed`}${candidates}`;
  }
  const where =
    response.url !== undefined
      ? `Now at ${response.url}${response.title ? ` — "${response.title}"` : ""}`
      : "OK";
  if (action === "read") {
    const text = response.text?.trim()
      ? `\n\nPage text:\n${response.text.trim()}`
      : "\n\n(page has no readable text)";
    return `${where}${text}${listElements("\nInteractive elements", response.elements)}`;
  }
  return where;
}

/**
 * Sign the host browser out of every site (or one site, by domain
 * substring) by clearing the persistent profile's cookies.
 *
 * This is a USER action, not a bot tool: every bot shares one logged-in
 * profile, so revoking that shared state has to be something the user can
 * reach from Settings. The daemon has always implemented `clear`; nothing in
 * the app ever sent it, which left the documented control unreachable.
 */
export async function clearBrowsingState(
  provider: SessionProvider,
  botId: string,
  site?: string,
): Promise<string> {
  const request: Record<string, unknown> = { action: "clear" };
  if (site !== undefined && site.trim() !== "") request.site = site.trim();
  const { sessionId } = await provider.provision(botId);
  const cmd = `node ${HOST_ROOT}/browse.mjs ${shQuote(encodeRequest(request))}`;
  const result = await provider.exec(sessionId, cmd, {
    timeoutMs: BROWSE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "the browse runner failed");
  }
  const parsed = JSON.parse(result.stdout.trim()) as BrowseResponse;
  if (parsed.ok !== true) {
    throw new Error(String(parsed.error ?? "clearing browsing state failed"));
  }
  return formatBrowseResponse("clear", parsed);
}

export function createBrowseTools(deps: BrowseToolsDeps): EngineTool[] {
  const { provider, manager } = deps;

  async function runAction(
    ctx: ToolContext,
    request: Record<string, unknown>,
  ): Promise<string> {
    const action = String(request.action);
    try {
      const sessionId = await manager.acquire(ctx.bot.id);
      const cmd = `node ${HOST_ROOT}/browse.mjs ${shQuote(encodeRequest(request))}`;
      const result = await provider.exec(sessionId, cmd, {
        timeoutMs: BROWSE_TIMEOUT_MS,
      });
      manager.touch(ctx.bot.id);
      if (result.timedOut) {
        return "Error: browse action timed out on the host";
      }
      if (result.exitCode !== 0) {
        return `Error: browse runner failed: ${result.stderr.trim() || "no error output"}`;
      }
      let parsed: BrowseResponse;
      try {
        parsed = JSON.parse(result.stdout.trim()) as BrowseResponse;
      } catch {
        return `Error: browse runner returned unparseable output: ${result.stdout.slice(0, 400)}`;
      }
      return formatBrowseResponse(action, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }

  const gotoTool: EngineTool = {
    name: "browse_goto",
    description:
      "Navigate the host browser to an http(s) URL. The browser runs on the " +
      "user's personal host with a persistent profile, so sites the user has " +
      "logged into stay logged in. Returns the resulting URL and page title. " +
      "If a login or 2FA screen appears, STOP and ask the user to complete " +
      "it — never attempt to enter credentials.",
    // Not "read": navigating a logged-in browser performs real actions on
    // arrival (confirm/unsubscribe/delete/OAuth-consent links are all GETs),
    // and the URL itself carries whatever the bot put in it. external-read
    // escalates to approval once untrusted content is in the run.
    category: "external-read",
    untrustedOutput: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
      },
      required: ["url"],
    },
    run: (args, ctx) => runAction(ctx, { action: "goto", url: args.url }),
  };

  const readTool: EngineTool = {
    name: "browse_read",
    description:
      "Read the current page in the host browser: URL, title, main text " +
      "(capped), and the interactive elements (role + accessible name) you " +
      "can pass to browse_click / browse_fill.",
    // Page text from an authenticated session, on its way to a cloud model.
    category: "external-read",
    untrustedOutput: true,
    parameters: { type: "object", properties: {} },
    run: (_args, ctx) => runAction(ctx, { action: "read" }),
  };

  const clickTool: EngineTool = {
    name: "browse_click",
    description:
      "Click an element on the current page by ARIA role and accessible " +
      "name (as listed by browse_read). This acts inside the user's " +
      "logged-in browser, so it can have real-world effects — use only for " +
      "actions the task genuinely requires. If multiple elements match, " +
      "pass nth (0-based); on a miss the result lists available elements.",
    category: "external-comms",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "ARIA role, e.g. link, button." },
        name: { type: "string", description: "Accessible name (substring ok)." },
        nth: {
          type: "number",
          description: "0-based index when several elements match.",
        },
      },
      required: ["role", "name"],
    },
    // Clicking "Pay now" or "Place order" IS the payment confirmation, so
    // the floor has to be reachable from the control's accessible name.
    classify: (args) => classifyFormField(args.name),
    run: (args, ctx) =>
      runAction(ctx, {
        action: "click",
        role: args.role,
        name: args.name,
        ...(typeof args.nth === "number" ? { nth: args.nth } : {}),
      }),
  };

  const fillTool: EngineTool = {
    name: "browse_fill",
    description:
      "Fill a form field on the current page by its label or placeholder. " +
      "Acts inside the user's logged-in browser. NEVER use this for " +
      "passwords, one-time codes, or payment details — pause and hand off " +
      "to the user instead.",
    category: "external-comms",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Field label or placeholder." },
        value: { type: "string", description: "Text to enter." },
      },
      required: ["label", "value"],
    },
    // The platform invariant ("Bots never enter credentials") was previously
    // only this tool's description — prose an injected page can talk the
    // model out of. Classifying the CALL puts it on the credential/payment
    // hard floor, which no policy can loosen below approval.
    classify: (args) => classifyFormField(args.label, args.value),
    run: (args, ctx) =>
      runAction(ctx, { action: "fill", label: args.label, value: args.value }),
  };

  return [gotoTool, readTool, clickTool, fillTool];
}
