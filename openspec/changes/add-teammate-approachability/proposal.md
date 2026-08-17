# Add Teammate Approachability Features

## Why

A handful of features make agent teammates dramatically more approachable for non-technical users, and our specs don't cover them yet. The headline capabilities (routines, teach-by-demonstration, live takeover, autonomy levels, MCP connectors) are already spec'd; this change closes the remaining gaps so Bots keeps its "install an app, get a teammate" promise.

## What Changes

- **Persona template packs**: Bots can be created from shareable role templates (e.g. a research-assistant or small-business-operations persona) bundling role description, standing instructions, and starter workspace files; any existing Bot can be exported as a template with secrets stripped.
- **Proactive work discovery**: a new capability letting an opted-in Bot infer concrete deliverables from the user's world (calendar, email, workspace) and start producing drafts unprompted — always draft-don't-send, never crossing safe-action boundaries.
- **Chat choice chips and inline draft actions**: when a Bot offers options or produces an outward-facing draft, the chat renders one-click choices (options, post/tweak/rewrite) instead of making the user type; selections are recorded as normal user messages.
- **Cursor-following idle gaze**: the active conversation's avatar tracks the user's cursor while idle instead of gaze-wandering (already implemented in `BotAvatar`; this syncs the spec).
- **Account-scoped connector authorization**: an integration authorized once in any conversation is available to every Bot (still subject to per-bot tool visibility and policy hooks), with a single place to review and revoke grants — including multiple named accounts per integration (e.g. a "default" and a "work" Slack).
- **Post-run skill self-correction**: after a routine/skill run, the Bot may critique its own execution and propose an amendment to the routine's instructions; amendments follow the existing review-and-correction and trust-progression rules rather than silently rewriting behavior. (External event triggers are already covered by the routines spec's trigger-event requirement — no delta needed.)

## Capabilities

### New Capabilities

- `proactive-work`: opt-in inference of real deliverables from the user's connected context, producing reviewable drafts without a user request, with strict draft-only boundaries and notification-spec surfacing.

### Modified Capabilities

- `bot-management`: new requirement for creating Bots from persona templates and exporting Bots as templates (secrets and memories excluded).
- `messaging`: new requirement for structured choice prompts (clickable chips) and inline draft action buttons in threads.
- `bot-avatars`: ambient eye life gains cursor-following gaze for the active conversation's avatar while idle (reduced-motion and non-idle states unaffected).
- `tool-extensibility`: connector/MCP authorizations become account-scoped (authorize once, all Bots), with a reviewable, revocable grant list and support for multiple named accounts per integration; per-bot visibility filtering and policy hooks still gate actual use.
- `routines`: new requirement for post-run self-correction (Bot-proposed routine amendments gated by the existing review/trust rules).

## Impact

- `app/src/features/chat/` — choice-chip and draft-action message rendering (Composer/ThreadView + chat store message types).
- `app/src/app/BotEditor.tsx` + `lib/engine/` bot store — template import/export.
- `lib/engine/` — proactive-work loop (behind opt-in flag), account-scoped authorization registry in the tool/MCP layer.
- `app/src/features/avatars/` — already shipped (`useCursorGaze`, `followCursor` prop); spec delta only.
- No breaking changes; all features are additive and default-off where they touch autonomy (proactive work is opt-in per Bot).
