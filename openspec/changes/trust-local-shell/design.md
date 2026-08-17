## Context

Three facts about the code as it stands:

1. `DEFAULT_CATEGORY_RULES` in `lib/engine/policy.ts` sets `shell-local: "approve"` and `shell-session: "allow"`. The comment above the table says these defaults were chosen to "reproduce the pre-policy behavior of every existing tool exactly" — they are a migration artifact, not a risk judgement made about local shell on its merits.
2. `sessionGlue.ts` wraps `session_exec` to post `$ <cmd>` into the thread timeline before each call. That is the only place the raw command reaches the UI.
3. `loop.ts:438` already records **every** tool call to the audit store (`tool.allowed` / `approved` / `denied` / `refused` / `blocked`) with bot, thread, delegation chain, summary and detail; `audit.ts` already has `exportAuditLog` and a 5000-entry cap. No component in `src/app` or `src/features` reads any of it.

So the trail this change relies on already exists and is already complete. What is missing is a door to it — and that gap is the reason the change has to add a view rather than only delete things.

Local exec is not unguarded: `session_local_exec` locks cwd to the Bot's workspace, sanitizes the environment, caps output at 256KB, and kills the process group at 30s (300s max). The gates that carry the actual risk — `bulk-delete`, `credential`, `payment` — are hard floors that `isHardFloor` prevents any per-bot policy from loosening, and they are unaffected here.

## Goals / Non-Goals

**Goals:**

- A Bot doing ordinary work in its own workspace never interrupts the user.
- Approval prompts become rare enough that seeing one carries information.
- Everything a Bot ran stays answerable after the fact, in the app, without a terminal.
- The thread reads as a conversation with a colleague, not a console.

**Non-Goals:**

- Touching the sensitive-action floor, the approval pipeline, or the taint-escalation rule. Fewer things route into approvals; approvals themselves are untouched.
- Removing the per-bot ability to demand approval for shell.
- Building log search, retention policy, or a diffing/undo feature over the audit log. Newest-first, filter-by-bot, and export are the scope.
- Recording command *output* in the audit log. Entries name what ran and what decided it; output can be large and can contain user data, and the summary field is explicitly secret-free.

## Decisions

### 1. Flip the default rather than special-casing the provider

`shell-local` becomes `allow`, so the table reads the same for both shell categories. The alternative — keep `approve` but auto-allow when the workspace is local — would make the effective policy depend on a Settings choice made elsewhere, which is exactly the kind of invisible coupling that makes a security posture hard to reason about. One table, one answer per category, still overridable per Bot.

The honest framing for the spec and the changelog: **this lowers a default gate.** It is defensible because the gate was guarding the wrong noun (a command, rather than an effect) and because the effects worth guarding are floors that don't move.

### 2. Delete the timeline post outright, don't demote it

The `session_exec` wrapper in `sessionGlue.ts` stops posting. Not "collapsed by default", not "behind a toggle" — the thread carries no command entries at all. A collapsed-by-default line is still a line: it occupies vertical space between the user's request and the Bot's answer, and every design conversation about it turns into how many pixels it deserves. The activity log is the place; the thread is not a second, worse place.

Kept in the thread: session lifecycle indicators (provisioned / warm-resumed / stopped — one per session, not per command) and sync-back warnings, which name files that did *not* make it back to the Mac and are therefore actionable.

### 3. The activity log is a Settings view over the store as it is

`ActivityLog.tsx` renders `auditLog`'s events newest first, with a filter by Bot and the existing `exportAuditLog` text output saved through the `saveTextFile` native binding. No new persistence, no schema change, no migration: the store has been recording all along, so the log is populated with real history the moment the view ships.

Each row shows time, Bot (with delegation chain when the actor was delegated to), what ran, and the decision — with allowed/approved/denied visually distinct, because "what did it do without asking me" is the question the view exists to answer.

*Alternative considered.* A per-thread "show the commands for this task" affordance in the detail panel. Rejected for this change: it re-couples commands to conversation, and the cross-cutting question ("what has anything done lately?") is the one that has no home today. The detail panel can grow a link into the filtered log later.

### 4. Copy has to move with the behavior

`computeOptions.ts` currently sells the local option as "I ask before every command, and nothing runs while it sleeps", and `onboardingCompute.ts` confirms with "I'll ask you before each command". Both become false the moment the default flips. They are rewritten around what the local option actually means: work stays in the Bot's own folder on this Mac, nothing runs while the Mac sleeps, everything is logged. The Settings body gets the same treatment.

This is not cosmetic — it is the user-facing statement of the security posture, and a stale promise there is worse than no promise.

## Risks / Trade-offs

- **A Bot does something destructive inside its workspace with no prompt** → the workspace is the Bot's own directory, deletion outside it is a hard floor, and the local workspace is the *source of truth* that sessions sync back to, so damage is bounded to files the Bot itself owns. Accepted deliberately: this is the trade the change is making.
- **The user loses the ambient sense of what their Bot is doing** → partly real. Mitigated by the Bot's own narration (which is what a user actually reads) plus the activity log; the live-view capability remains the answer for watching work in progress.
- **A prompt-injected Bot now runs shell without a pause** → unchanged by this design in the direction that matters: the taint rule escalates the categories injected text uses to *escalate* (self-modify, delegation, external-read — the exfiltration leg), and injected content could already drive `shell-session` freely on host/cloud providers. Worth stating plainly in review rather than discovering later.
- **The activity log becomes the only trail and it is capped at 5000 entries** → a Bot doing heavy shell work will roll entries off faster than before, silently. Out of scope to fix here, but the view must state the cap and the range it covers (`exportAuditLog` already does this in its header) so nobody reads a truncated log as complete.
- **Users who liked the prompts** → the per-bot "Ask first" rule still exists and the change does not touch it; the Bot editor already exposes it.

## Migration Plan

No data migration. Existing Bots with an explicit `shell-local` rule keep it, since per-bot policy overrides the platform default — only Bots relying on the default change behavior. Rollback is a one-line revert of the default plus restoring the timeline post; the activity log is additive and can stay either way.

## Open Questions

- Should the first Bot's introduction mention the activity log once, so the user knows the trail exists before they need it? Leaning yes, but it competes with the compute-location card for the same moment.
- Does `external-read` (web fetch) deserve the same treatment as part of this change, or is reaching the network genuinely different from touching your own folder? Left alone here — it is the exfiltration leg the taint rule is built around.
