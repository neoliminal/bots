# Multi-Bot Collaboration Specification

## Purpose

The user is not the router — and collaboration requires no administration. Every Bot on an Agent Computer sees its teammates as callable agents: each Bot publishes a **capability card** (role + auto-updating experience summary + live availability), and any Bot that hits work matching a teammate's skills contacts that teammate directly, the way it would call a tool. There are no group chats to create; delegation happens transparently when the need arises, is fully visible where it happened, and surfaces to the human only for judgment or approvals. An "Executive Assistant" is not a mechanism — it is simply a Bot whose role is being the user's interface, benefiting from the same peer delegation as everyone else.

## Requirements

### Requirement: Capability cards
Every Bot SHALL publish a capability card visible to its teammates, composed of: name; the user-authored role description; an **experience summary** automatically maintained by the platform from the Bot's actual completed work (task types finished, tools used, corrections learned, artifacts produced) — never self-authored free text; and live availability (idle/busy/paused/waiting-on-human). Cards SHALL be bounded in size (they ride in peers' model context) and are the reference peers use to decide whom to contact.

#### Scenario: Experience accrues into the card
- **WHEN** a Bot completes its tenth invoice-processing run, including a learned correction about cost centers
- **THEN** its card's experience summary reflects invoice-processing competence (derived from the completed runs, within the card's size budget) and teammates routing invoice work select it accordingly

#### Scenario: Cards are grounded in completed work
- **WHEN** a Bot has never completed research work
- **THEN** its card cannot claim research experience — the summary is derived from the task record, not generated self-description

#### Scenario: User visibility and control
- **WHEN** the user opens a Bot's capability card
- **THEN** they see the current card, its change history (versioned), and can edit or pin the experience summary — with reverts taking effect for the next delegation decision

### Requirement: Transparent peer delegation
The platform SHALL let any Bot contact any teammate when the work at hand matches that teammate's card — without a pre-created group thread, without a designated coordinator, and without user setup. The contact carries a self-contained brief (the target does not see the originating thread); the reply resolves back to the requester, which continues its work. Per-Bot settings MAY restrict this (can-contact / can-be-contacted), defaulting to open within the team.

#### Scenario: Delegation without setup
- **WHEN** the user asks their assistant Bot for a briefing that requires deep account research, and a Research Bot's card shows that skill
- **THEN** the assistant contacts the Research Bot with a self-contained brief, receives its report, and synthesizes the answer — the user never created a team, group chat, or workflow

#### Scenario: Direct addressing still works
- **WHEN** the user messages a specific Bot directly
- **THEN** that Bot owns the request itself (delegating only if it genuinely needs a teammate's skill), and the user can always bypass delegation by talking to any Bot directly

#### Scenario: Paused or restricted teammates
- **WHEN** a Bot attempts to contact a teammate that is paused or has can-be-contacted disabled
- **THEN** the contact fails immediately with the reason, and the requester proceeds without it (or surfaces the gap to the user if the skill was essential)

### Requirement: Delegation visibility without group chats
Every delegation SHALL be visible where the need arose: the originating thread renders a delegation card (target Bot, brief, live status, report) expandable to the full exchange, and the target Bot's own thread records its side. Nothing about bot-to-bot traffic is hidden from the user; an activity view SHALL aggregate all cross-bot traffic chronologically.

#### Scenario: Following a delegation inline
- **WHEN** the user's assistant delegates research mid-conversation
- **THEN** the user sees a delegation card in that same conversation — collapsed to "asked Scout for account research — in progress", expandable to the full brief and report — and never needs to hunt through a separate chat

### Requirement: Delegation chain safeguards
Delegation SHALL be structurally bounded: each request carries its full ancestry chain, and a Bot SHALL refuse a contact that would create a cycle; chain depth is capped (default 2 hops from the originating request); fan-out per request is capped; and the entire delegation tree SHALL cancel when the originating request is stopped. Delegated runs inherit the originating request's budget envelope, and usage attribution records which top-level request caused which delegated spend.

#### Scenario: Cycle refused
- **WHEN** Bot A delegates to Bot B, and B's work would delegate back to A
- **THEN** the contact is refused structurally (the request's ancestry shows A), B handles the work itself or reports the limitation, and no deadlock occurs

#### Scenario: Stop cancels the tree
- **WHEN** the user stops a request whose delegation tree is three bots deep in work
- **THEN** every delegated run in that tree halts at its next safe boundary, and no orphaned work continues or posts reports afterward

#### Scenario: Attributed spend
- **WHEN** the user reviews usage after a delegated request
- **THEN** the delegated bots' model spend is attributed to the originating request, not just to the bots that happened to run

### Requirement: Ephemeral instances instead of blocking
A busy teammate SHALL never block a delegation. When a contacted Bot is mid-work, the platform SHALL spawn an **ephemeral instance** of it for that conversation: a copy running from the same role, capability card, and a snapshot of the Bot's memory, executing the delegation concurrently with the canonical Bot's work. When the instance finishes, its new learnings are **merged back** into the canonical Bot's memory (see `bot-memory`), its completed work accrues to the Bot's experience summary, and the instance is destroyed. Instances are bounded (default max 3 concurrent per Bot, counting toward chain depth/fan-out caps), cannot outlive their delegation, and are visibly marked as instances everywhere they appear (delegation cards, approvals, avatars). Pausing or deleting the canonical Bot halts and cleans up its instances. A per-Bot setting MAY disable instancing, in which case delegations queue with a timeout.

#### Scenario: Busy bot, instant help
- **WHEN** a delegation targets a Research Bot that is an hour into a long task
- **THEN** an ephemeral Research Bot instance spawns from its current memory snapshot and handles the delegation in parallel, the canonical Bot's long task continues undisturbed, and the requester is never queued

#### Scenario: Learnings merge back
- **WHEN** the instance learns something during its delegation (a correction, a discovered fact) and completes
- **THEN** those memory entries merge into the canonical Bot's memory store (deduplicated, conflicts flagged per `bot-memory`), so the next run of the canonical Bot — or any future instance — benefits

#### Scenario: Instances are visible and bounded
- **WHEN** three delegations hit a busy Bot simultaneously and a fourth arrives
- **THEN** three instances run (each marked as an instance in its delegation card and approval provenance), and the fourth delegation waits or adapts — the per-Bot instance cap is never exceeded

#### Scenario: Canonical pause halts instances
- **WHEN** the user pauses a Bot that has two live instances
- **THEN** both instances halt at their next safe boundary with their delegations reported as interrupted, and pending memory merges from completed work still apply

### Requirement: Task ownership handoff
A task SHALL have exactly one owning Bot at a time. Bots SHALL be able to transfer ownership (with full task context and state) or delegate subtasks while retaining ownership. Handoffs SHALL appear in the task timeline.

#### Scenario: Transfer with context
- **WHEN** an Engineering Bot reproduces a bug and hands the fix-it task to a second Bot
- **THEN** the receiving Bot gets the reproduction steps, artifacts, and environment state, ownership shows the new Bot, and the timeline records the handoff

### Requirement: Shared artifacts and context
Bots SHALL share work products through the shared local workspace (the source of truth, mirrored into compute sessions as needed — see `agent-computer`) and through structured task context (not by copy-pasting into chat). A delegation brief referencing an artifact SHALL guarantee the artifact is readable by the recipient.

#### Scenario: Structured handoff payload
- **WHEN** a Research Bot hands off scored contacts
- **THEN** the payload is a structured file (e.g., CSV/JSON in the shared workspace) plus a summary message, and the receiving Bot consumes the file directly

### Requirement: Event-driven cross-bot triggers
A Bot SHALL be able to register interest in events (an email reply arrives, a CRM stage changes, a file appears) and react by starting work or contacting the teammate whose card matches, without the user initiating each reaction.

#### Scenario: Reply detected, teammates looped in
- **WHEN** a prospect replies to outreach that a Sales Bot sent
- **THEN** the Account Health Bot (subscribed to reply events) updates the CRM record and contacts the Comms Bot to prepare a response draft, surfacing to the user only the draft approval

### Requirement: Coordination without collision
When multiple Bots' work touches the same external resource (same CRM record, same inbox), the platform SHALL serialize conflicting actions and make Bots aware of each other's in-flight work to prevent duplicate or contradictory side effects.

#### Scenario: Same record, two bots
- **WHEN** two Bots both need to update the same CRM opportunity within seconds
- **THEN** the updates are applied in a serialized order, the second Bot sees the first's change before acting, and no update is silently lost

### Requirement: Executive Assistant as a role, not a mechanism
Being the user's interface SHALL require no special machinery: an Executive Assistant is a Bot whose role description makes it the user's primary contact, using the same transparent peer delegation as every Bot. Approvals and human-floor gates (per `human-handoff`) always go to the user regardless of who delegated — no Bot can approve for the user. Approval requests arising from delegated work SHALL show the full provenance chain (who asked whom, ending in the gated action).

#### Scenario: EA is just a well-described Bot
- **WHEN** the user gives one Bot the role "my interface — take anything I ask and get it done with the team"
- **THEN** that Bot fields broad requests and delegates by capability card, with no coordinator designation, team creation, or special configuration anywhere

#### Scenario: Provenance on delegated approvals
- **WHEN** a Bot two hops down a delegation chain needs approval to send an email
- **THEN** the approval card shows the chain (user asked EA → EA asked Mailer → Mailer requests send) so the user can judge the request in context

### Requirement: Escalation funneling through an interface Bot
The user MAY enable funnel mode on any Bot (typically the Executive Assistant): non-blocking questions and status pings from other Bots route to it first; it resolves what it can and escalates to the user only what genuinely requires human judgment — batched and prioritized. Blocking events with a human floor (takeovers, gated approvals, security events) SHALL always reach the user directly per `notifications`, funnel mode or not.

#### Scenario: Fewer pings, same control
- **WHEN** funnel mode is on and three Bots each hit a minor ambiguity the interface Bot can resolve from team context
- **THEN** the interface Bot resolves all three, the user receives no interruption, and the resolutions appear in the daily digest

#### Scenario: Human-floor events skip the funnel
- **WHEN** a Bot needs a 2FA takeover while funnel mode is on
- **THEN** the takeover request notifies the user directly and immediately, not via the funnel

### Requirement: Stalled-delegation detection
The platform SHALL detect delegations and handoffs not picked up or not progressing within a configurable window (default 30 minutes during active hours) and notify the user, so dropped threads between Bots never silently stall.

#### Scenario: Receiver blocked
- **WHEN** a delegation targets a Bot the user paused, and it sits unclaimed past the window
- **THEN** the user is notified the delegation is stalled, with actions to resume the Bot, reassign, or cancel
