// Role-description first guesses for Bot creation (spec:
// openspec/specs/bot-management, "Role description first guess").
//
// The creation form never starts blank: the first suggestion is always the
// Personal Assistant generalist (unless an existing bot already covers it),
// followed by roles that complement the current roster, boosted by what the
// user has actually been asking bots to do recently.

export interface RoleSuggestion {
  title: string;
  description: string;
}

export interface SuggestRolesArgs {
  /** Active bots in the roster (name + roleDescription are matched). */
  existingBots: ReadonlyArray<{ name: string; roleDescription: string }>;
  /** Recent user-authored messages across threads, newest first. */
  recentUserMessages: readonly string[];
}

interface RoleDefinition extends RoleSuggestion {
  /**
   * Lowercase keywords matched (substring) against existing bot names and
   * role descriptions; a hit means the role is already covered and is
   * dropped from the suggestions.
   */
  coverageKeywords: readonly string[];
  /**
   * Lowercase keywords matched (substring) against recent user messages;
   * each matching message boosts the role toward the top.
   */
  usageKeywords: readonly string[];
}

const PERSONAL_ASSISTANT_TITLE = "Personal Assistant";

/** Built-in role library, in default presentation order. */
export const ROLE_LIBRARY: readonly RoleDefinition[] = [
  {
    title: PERSONAL_ASSISTANT_TITLE,
    description:
      "A general-purpose helper for whatever comes up day to day. Handles " +
      "scheduling, reminders, quick lookups, drafting, and small errands " +
      "across your tools. When a request is ambiguous, proposes a " +
      "best-guess plan with a couple of options to pick from rather than " +
      "asking open-ended questions, and keeps track of loose ends so " +
      "nothing slips.",
    coverageKeywords: ["personal assistant", "general assistant", "generalist"],
    usageKeywords: [],
  },
  {
    title: "Research",
    description:
      "Digs into topics, companies, and markets, then delivers concise, " +
      "sourced summaries. Gathers information from the web and your " +
      "documents, separates facts from speculation, and highlights what " +
      "matters for your decision. Flags open questions instead of guessing.",
    coverageKeywords: ["research", "analyst"],
    usageKeywords: ["research", "investigate", "look into", "look up", "compare", "sources"],
  },
  {
    title: "Sales Outreach",
    description:
      "Finds and contacts prospects, drafts personalized outreach emails, " +
      "and keeps follow-ups on schedule. Tracks who has replied, nudges cold " +
      "threads at the right cadence, and hands warm conversations back to " +
      "you. Keeps every message consistent with your voice and offer.",
    coverageKeywords: ["sales", "outreach", "prospect", "lead gen"],
    usageKeywords: [
      "outreach",
      "prospect",
      "cold email",
      "follow up",
      "follow-up",
      "leads",
      "pipeline",
      "email",
    ],
  },
  {
    title: "Support Triage",
    description:
      "Watches incoming support requests and sorts them by urgency and " +
      "topic. Answers common questions from your knowledge base, drafts " +
      "replies for review, and escalates anything sensitive or novel to " +
      "you. Keeps the queue tidy so customers never wait longer than they " +
      "should.",
    coverageKeywords: ["support", "triage", "helpdesk", "customer service"],
    usageKeywords: ["support", "ticket", "customer issue", "bug report", "complaint"],
  },
  {
    title: "Expense & Invoice Manager",
    description:
      "Keeps invoices and expenses organized and moving. Extracts details " +
      "from receipts and bills, categorizes spending, chases missing " +
      "paperwork, and prepares clean summaries for approval or accounting. " +
      "Flags anomalies like duplicates or unusual amounts before they " +
      "become problems.",
    coverageKeywords: ["expense", "invoice", "bookkeep", "accounting", "billing"],
    usageKeywords: ["invoice", "expense", "receipt", "reimburs", "billing"],
  },
  {
    // The EA is a ROLE, not a mechanism (multi-bot-collaboration spec):
    // being the user's interface needs no coordinator flag — this bot
    // delegates by capability card like every other bot.
    title: "Executive Assistant",
    description:
      "Your interface to the team: take anything the user asks and get it " +
      "done. Handles what fits your own skills, and hands the rest to the " +
      "teammate whose capabilities match — then follows the work to " +
      "completion and reports back in one place. Keeps the user's context " +
      "(calendar, priorities, open threads) at hand, and escalates only " +
      "what genuinely needs their judgment.",
    coverageKeywords: ["executive assistant", "chief of staff", "interface to the team"],
    usageKeywords: ["schedule", "calendar", "meeting", "agenda", "coordinate"],
  },
  {
    title: "Content & Comms Writer",
    description:
      "Drafts and polishes the words you send into the world: posts, " +
      "newsletters, announcements, and internal updates. Matches your tone, " +
      "adapts one message for different channels, and turns rough notes " +
      "into publishable copy. Always presents drafts for sign-off before " +
      "anything ships.",
    coverageKeywords: ["writer", "content", "copywrit", "comms", "communications", "marketing"],
    usageKeywords: ["blog", "newsletter", "announcement", "social post", "copy for"],
  },
  {
    title: "Data & Reporting",
    description:
      "Turns raw numbers into recurring reports and clear answers. Pulls " +
      "data from spreadsheets and tools, computes the metrics you care " +
      "about, and delivers scheduled summaries with notable changes called " +
      "out. Explains its calculations so every figure can be checked.",
    coverageKeywords: ["data", "report", "analytics", "dashboard", "metrics"],
    usageKeywords: ["report", "metrics", "dashboard", "spreadsheet", "csv", "chart", "data"],
  },
];

/**
 * Starter tasks offered in a new bot's introduction card (bot-management
 * spec, "Bot introduction with starter options"; design pillar: onboarding
 * without typing). Keyed by library role title; custom role descriptions
 * borrow the closest library role's options via coverage keywords.
 */
const STARTER_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  [PERSONAL_ASSISTANT_TITLE]: [
    "Help me plan my day",
    "Draft a reply I've been putting off",
    "Keep a running to-do list for me",
  ],
  Research: [
    "Research a topic and summarize it",
    "Compare a few options for a decision",
    "Dig into a company or market",
  ],
  "Sales Outreach": [
    "Draft a personalized outreach email",
    "Plan a follow-up cadence",
    "Review my current pipeline",
  ],
  "Support Triage": [
    "Sort my open requests by urgency",
    "Draft replies to the common questions",
    "Show me what needs escalation",
  ],
  "Expense & Invoice Manager": [
    "Organize my recent receipts",
    "Prepare an expense summary",
    "Chase the missing paperwork",
  ],
  "Executive Assistant": [
    "Take something off my plate",
    "Review what the team is working on",
    "Plan my week",
  ],
  "Content & Comms Writer": [
    "Turn my rough notes into a draft",
    "Draft a post about something I shipped",
    "Adapt one message for two channels",
  ],
  "Data & Reporting": [
    "Build a recurring summary report",
    "Answer a question from my data",
    "Set up the metrics I care about",
  ],
};

/** Floor for hand-written roles matching no library role. */
const GENERIC_STARTER_OPTIONS: readonly string[] = [
  "Tell me what you can do",
  "Start with something small",
  "Help me plan how to use you",
];

/**
 * Starter options for a bot's introduction card: exact library description
 * first, then coverage-keyword match, then the generic floor.
 */
export function starterOptionsFor(roleDescription: string): string[] {
  const exact = ROLE_LIBRARY.find((r) => r.description === roleDescription);
  if (exact !== undefined) return [...(STARTER_OPTIONS[exact.title] ?? GENERIC_STARTER_OPTIONS)];
  const haystack = roleDescription.toLowerCase();
  const matched = ROLE_LIBRARY.find((r) =>
    r.coverageKeywords.some((kw) => haystack.includes(kw)),
  );
  if (matched !== undefined) return [...(STARTER_OPTIONS[matched.title] ?? GENERIC_STARTER_OPTIONS)];
  return [...GENERIC_STARTER_OPTIONS];
}

function isCovered(
  role: RoleDefinition,
  existingBots: SuggestRolesArgs["existingBots"],
): boolean {
  return existingBots.some((bot) => {
    const haystack = `${bot.name} ${bot.roleDescription}`.toLowerCase();
    return role.coverageKeywords.some((kw) => haystack.includes(kw));
  });
}

/** Number of recent messages that mention any of the role's usage keywords. */
function usageScore(role: RoleDefinition, messages: readonly string[]): number {
  if (role.usageKeywords.length === 0) return 0;
  let score = 0;
  for (const message of messages) {
    const text = message.toLowerCase();
    if (role.usageKeywords.some((kw) => text.includes(kw))) score += 1;
  }
  return score;
}

/**
 * Ordered role suggestions for the Bot editor.
 *
 * - Personal Assistant is always first and is only removed when an existing
 *   bot's name/role already matches it.
 * - Roles substantially covered by an existing bot are dropped.
 * - Remaining roles are boosted by how often recent user messages mention
 *   their keyword cluster, ties broken by library order.
 */
export function suggestRoles({
  existingBots,
  recentUserMessages,
}: SuggestRolesArgs): RoleSuggestion[] {
  const available = ROLE_LIBRARY.filter((role) => !isCovered(role, existingBots));

  const scored = available.map((role, index) => ({
    role,
    index,
    score: usageScore(role, recentUserMessages),
  }));

  scored.sort((a, b) => {
    const aIsDefault = a.role.title === PERSONAL_ASSISTANT_TITLE;
    const bIsDefault = b.role.title === PERSONAL_ASSISTANT_TITLE;
    if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map(({ role }) => ({ title: role.title, description: role.description }));
}

/**
 * Pure helper for the call site: the last `limit` user-authored messages
 * across all threads, newest first, blank messages excluded.
 */
export function collectRecentUserMessages(
  threads: Record<
    string,
    ReadonlyArray<{ role: string; text: string; createdAt: number }>
  >,
  limit = 50,
): string[] {
  return Object.values(threads)
    .flat()
    .filter((m) => m.role === "user" && m.text.trim() !== "")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((m) => m.text);
}
