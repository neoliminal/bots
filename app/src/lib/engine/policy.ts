// Tool policy: visibility filtering + per-call gating decisions.
// Specs: openspec/specs/tool-extensibility/spec.md (per-bot visibility,
//        policy-hook gating, floors), human-handoff (autonomy matrix).
//
// Every tool declares an ActionCategory; a bot's ToolPolicy (bot-management
// config) can tighten the category defaults per tool or per category, but
// the hard-floor categories can never be loosened below require-approval.
import type { Bot } from "./types";
import type { EngineTool } from "./tools";

/**
 * What kind of action a tool performs. Categories — not individual tools —
 * are the unit the human-handoff autonomy matrix configures.
 */
export type ActionCategory =
  /** Read-only LOCAL lookups: workspace/session file reads, listings. */
  | "read"
  /**
   * Reads that reach the internet (web fetch, browsing). Separate from
   * "read" because a request carrying bot-composed data is also an EGRESS
   * channel — the URL is the exfiltration path. Escalates to approval once
   * untrusted content has entered the run (see ESCALATE_WHEN_TAINTED).
   */
  | "external-read"
  /** Reversible, user-visible writes: workspace/session files. */
  | "workspace-mutate"
  /**
   * Writes that change the bot's OWN future instructions: memory notes and
   * anything under `skills/`. Distinguished from workspace-mutate because
   * the content is spliced into every later system prompt, so injected text
   * that lands here becomes durable, self-reinforcing instruction.
   */
  | "self-modify"
  /** Irreversible deletions. HARD FLOOR: always requires approval. */
  | "bulk-delete"
  /** Arbitrary shell on a machine the USER owns (their Mac, their host). */
  | "shell-local"
  /** Shell inside a disposable, isolated compute session (agent-computer). */
  | "shell-session"
  /** Outbound external effects: email, MCP/connector calls, posting anywhere. */
  | "external-comms"
  /** Bot-to-bot delegation (multi-bot-collaboration). */
  | "delegation"
  /** Credential handling. HARD FLOOR: always requires approval. */
  | "credential"
  /** Payment confirmation. HARD FLOOR: always requires approval. */
  | "payment";

/** Per-tool or per-category rule in a bot's policy. */
export type PolicyRule = "allow" | "approve" | "deny";

/** Outcome of the policy hook for one tool call. */
export type PolicyDecision = "allow" | "approve" | "deny";

/**
 * A bot's tool policy (bot-management spec, "Bot configuration"). Absent
 * policy (or absent entries) fall through to the category defaults below.
 * Tool-name rules win over category rules.
 */
export interface ToolPolicy {
  /** Rules keyed by exact tool name. */
  tools?: Record<string, PolicyRule>;
  /** Rules keyed by action category. */
  categories?: Partial<Record<ActionCategory, PolicyRule>>;
}

/**
 * Categories that always pause for a human (the platform's sensitive-action
 * invariant; human-handoff "Hard floor cannot be disabled"). No policy,
 * tool, skill, or plugin can loosen these below "approve" — only "deny"
 * (tighter) is honored.
 */
export const HARD_FLOOR_CATEGORIES: readonly ActionCategory[] = [
  "bulk-delete",
  "credential",
  "payment",
];

/**
 * Platform defaults per category. Gates guard EFFECTS, not syntax: work
 * confined to a bot's own workspace runs unasked wherever that workspace
 * lives (task-execution spec, "Workspace-scoped work needs no per-action
 * approval"), while the effects worth stopping for stay gated no matter how
 * a bot reaches them.
 *
 * `shell-local` is "allow" for the same reason `shell-session` is: the local
 * runner locks cwd to the bot's workspace, sanitizes the environment, caps
 * output at 256KB and kills the process group on timeout. Asking per command
 * put a raw shell line in front of a user who cannot evaluate it, which
 * bought no safety and taught them to click through gates — the habit that
 * makes the floors below less effective. Every call is still recorded in the
 * audit log whether or not it needed a human (security spec).
 */
export const DEFAULT_CATEGORY_RULES: Readonly<Record<ActionCategory, PolicyRule>> = {
  read: "allow",
  "external-read": "allow",
  "workspace-mutate": "allow",
  "self-modify": "allow",
  "bulk-delete": "approve",
  "shell-local": "allow",
  "shell-session": "allow",
  "external-comms": "approve",
  delegation: "allow",
  credential: "approve",
  payment: "approve",
};

/**
 * Categories whose "allow" becomes "approve" once untrusted third-party
 * content has entered the run (security spec, "Injection cannot unlock
 * gated actions"). The threat is a page/email/tool result talking the model
 * into an action, so the categories that let injected text ESCALATE are the
 * ones that pause: persisting instructions to itself, handing work to a
 * teammate under a fresh policy, and reaching the network again (the
 * exfiltration leg — the first read is free, the read AFTER ingesting
 * untrusted content is not).
 *
 * `shell-session` deliberately stays allow: it is a disposable isolated VM
 * whose only escape routes (network egress, sync-back of prompt-influencing
 * files) are themselves covered above.
 */
export const ESCALATE_WHEN_TAINTED: readonly ActionCategory[] = [
  "self-modify",
  "delegation",
  "external-read",
];

/** Run-scoped signals the policy hook consults alongside the bot's policy. */
export interface DecisionContext {
  /**
   * True once any tool whose output is third-party controlled has returned
   * in this run (loop.ts sets it from `EngineTool.untrustedOutput`).
   */
  untrustedContent?: boolean;
}

function isHardFloor(category: ActionCategory): boolean {
  return HARD_FLOOR_CATEGORIES.includes(category);
}

const DECISION_RANK: Readonly<Record<PolicyDecision, number>> = {
  allow: 0,
  approve: 1,
  deny: 2,
};

/** The stricter of two decisions (deny > approve > allow). */
export function tightest(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

/**
 * Resolve the rule for one category under a bot's policy, before floor
 * clamping: tool-name rule > category rule > platform default.
 *
 * An unrecognized category resolves to "approve", never "allow" — a tool
 * descriptor with a missing or misspelled category (a future manifest,
 * plugin, or hand-written registration) must fail CLOSED.
 */
function resolveRule(
  toolName: string,
  category: ActionCategory,
  policy: ToolPolicy | undefined,
): PolicyRule {
  const byName = policy?.tools?.[toolName];
  if (byName !== undefined) return byName;
  const byCategory = policy?.categories?.[category];
  if (byCategory !== undefined) return byCategory;
  return DEFAULT_CATEGORY_RULES[category] ?? "approve";
}

/** Rule for one category, with the hard floor clamped in. */
function decideCategory(
  toolName: string,
  category: ActionCategory,
  policy: ToolPolicy | undefined,
): PolicyDecision {
  const rule = resolveRule(toolName, category, policy);
  if (isHardFloor(category) && rule === "allow") return "approve";
  return rule;
}

/**
 * The policy hook: decide one tool call for one bot.
 *
 * "allow"   — run it now.
 * "approve" — park a PendingApproval (human-handoff) and wait.
 * "deny"    — refuse without running (the tool should also have been
 *             invisible to the model; deciding again here is defense in
 *             depth for calls that arrive anyway).
 *
 * Hard-floor categories clamp any "allow" back to "approve"; "deny" is
 * honored because refusing entirely is tighter than asking.
 *
 * The decision is ARGUMENT-AWARE. A tool declaring `classify` re-categorizes
 * the individual call from its arguments (browse_fill typing into a password
 * field is `credential`; an MCP tool whose name is payment-shaped is
 * `payment`), and the result is the TIGHTER of the declared category and the
 * classified one — classification can only ever add friction, never remove
 * it. Without this, the credential and payment floors are unreachable: no
 * tool is inherently "a payment", only a call is.
 */
export function decide(
  bot: Bot,
  tool: EngineTool,
  args?: Record<string, unknown>,
  ctx?: DecisionContext,
): PolicyDecision {
  const policy = bot.toolPolicy;
  let decision = decideCategory(tool.name, tool.category, policy);

  const classified = tool.classify?.(args ?? {});
  if (classified !== undefined && classified !== tool.category) {
    decision = tightest(decision, decideCategory(tool.name, classified, policy));
  }

  if (
    decision === "allow" &&
    ctx?.untrustedContent === true &&
    (ESCALATE_WHEN_TAINTED.includes(tool.category) ||
      (classified !== undefined && ESCALATE_WHEN_TAINTED.includes(classified)))
  ) {
    return "approve";
  }
  return decision;
}

/**
 * Decide a call for a DELEGATED run: the acting bot plus every bot upstream
 * of it in the delegation chain, taking the tightest answer.
 *
 * Without this, delegation launders permission — a bot whose external-comms
 * are blocked writes the message into a brief and hands it to a teammate
 * whose policy permits sending, and the restriction evaporates. A delegated
 * run may do no more than the most restricted bot that asked for it.
 * Ancestors that can no longer be resolved (deleted mid-run) are skipped.
 */
export function decideForChain(
  bot: Bot,
  ancestors: readonly Bot[],
  tool: EngineTool,
  args?: Record<string, unknown>,
  ctx?: DecisionContext,
): PolicyDecision {
  let decision = decide(bot, tool, args, ctx);
  for (const ancestor of ancestors) {
    decision = tightest(decision, decide(ancestor, tool, args, ctx));
    if (decision === "deny") return decision;
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Sensitive-action detectors (shared by tool `classify` implementations)
// ---------------------------------------------------------------------------

const CREDENTIAL_HINTS = [
  "password",
  "passwd",
  "passphrase",
  "pin",
  "secret",
  "api key",
  "apikey",
  "api_key",
  "token",
  "otp",
  "one-time",
  "one time code",
  "2fa",
  "two-factor",
  "mfa",
  "verification code",
  "security code",
  "auth code",
  "authenticator",
  "recovery code",
  "private key",
  "seed phrase",
  "credential",
];

const PAYMENT_HINTS = [
  "card number",
  "cardnumber",
  "credit card",
  "debit card",
  "cvv",
  "cvc",
  "security code",
  "expiry",
  "expiration",
  "iban",
  "sort code",
  "routing number",
  "account number",
  "billing",
  "payment",
  "checkout",
  "purchase",
  "pay now",
  "place order",
  "invoice total",
  "charge",
  "transfer funds",
  "wire",
];

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  const text = haystack.toLowerCase();
  return needles.some((n) => text.includes(n));
}

/**
 * Classify a form field a bot is about to type into. Field labels are how a
 * login or payment screen announces itself, so this is what turns
 * "the Bot must never enter credentials" from prose in a tool description —
 * which injected content overrides by construction — into a floor the
 * policy hook enforces.
 */
export function classifyFormField(
  label: unknown,
  value?: unknown,
): ActionCategory | undefined {
  const text = typeof label === "string" ? label : "";
  if (text === "") return undefined;
  if (matchesAny(text, CREDENTIAL_HINTS)) return "credential";
  if (matchesAny(text, PAYMENT_HINTS)) return "payment";
  // A bare digit run of card length is a card number whatever the label says.
  const raw = typeof value === "string" ? value.replace(/[\s-]/g, "") : "";
  if (/^\d{13,19}$/.test(raw)) return "payment";
  return undefined;
}

/**
 * Classify a connector/MCP call by its tool name. The server supplies the
 * name; the platform — never the server — decides what that name means, so
 * a payments connector cannot opt itself out of the floor by declaring a
 * gentler category.
 */
export function classifyConnectorTool(toolName: string): ActionCategory | undefined {
  const name = toolName.toLowerCase();
  if (matchesAny(name, PAYMENT_HINTS)) return "payment";
  if (matchesAny(name, CREDENTIAL_HINTS)) return "credential";
  return undefined;
}

/**
 * Visibility half of the pipeline: should this bot's model requests include
 * the tool at all? Denied tools are hidden — the model never sees their
 * schema (tool-extensibility spec, "Per-bot tool visibility filtering").
 * Environment availability (`tool.available`) and per-bot offering probes
 * (`tool.availableFor`) are applied by the registry alongside this.
 */
export function isVisible(bot: Bot, tool: EngineTool): boolean {
  return resolveRule(tool.name, tool.category, bot.toolPolicy) !== "deny";
}
