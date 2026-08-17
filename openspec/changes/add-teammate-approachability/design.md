# Design — Add Teammate Approachability Features

## Context

This change covers features missing from our specs. One (cursor-following gaze) is already implemented in `app/src/features/avatars/` and only needs its spec delta archived. The other four span the engine (`lib/engine/`), the tool layer (`lib/engine/tools` + MCP client), and the chat UI (`src/features/chat/`). All must respect existing invariants: the OpenRouter client stays injected, `lib/` stays React-free, sensitive actions pause for human involvement, and secrets never enter specs/code/logs.

## Goals / Non-Goals

**Goals:**
- Spec + implement choice chips and inline draft actions in threads.
- Persona template import/export as plain files.
- Account-scoped authorization registry for connectors/MCP grants with a grants view.
- A minimal, opt-in proactive-work loop that only ever produces drafts.
- Archive the cursor-gaze delta into `bot-avatars`.

**Non-Goals:**
- No template marketplace/sharing service — templates are files the user moves themselves.
- No new external services or model calls beyond the existing injected `chatStream`.
- Proactive work does not get scheduling infrastructure of its own — it rides the existing routines/engine loop.
- No mobile surface (separate change).

## Decisions

- **Choice chips as a message content block, not a new message type.** Extend the chat store's message model with an optional `choices` / `draftActions` block; rendering lives in `ThreadView`, selection posts a plain user message. Alternative (special system message type) rejected: it would fork delivery, retry, and persistence paths for no gain. Engine emits the block via a structured marker in the assistant stream, parsed in `chatGlue`.
- **Draft actions reuse the approvals pipeline.** The post/tweak/discard buttons wrap existing approval objects (`ApprovalCard` logic) so in-thread action and approvals-inbox action are literally the same code path. Alternative (parallel in-thread action handler) rejected: two approval paths would drift and break the human-handoff audit invariant.
- **Templates are JSON files with a versioned schema** (`{version, role, description, instructions, starterFiles[]}`), imported/exported through the existing BotEditor. Export builds from the bot store only — memories, threads, and credentials are structurally absent, not filtered out. Alternative (zip bundles with binary assets) deferred until starter files need binaries.
- **Account-scoped grants live in a new `lib/engine/grants` registry**, persisted via `lib/storage/`, consulted by the tool loop before offering connector/MCP tools. Per-bot visibility filtering and the policy hook remain the gate on *use*; grants only answer "is this integration authorized at all". This keeps the two concerns (authorized vs. allowed) independent and testable.
- **Grants are multi-account from day one.** The grants registry keys on `(integration, accountLabel)` rather than integration alone, so the single-account case is just a registry with one row per integration and no migration is needed when a second account arrives. Tool-call routing carries the account label explicitly; ambiguity resolves by asking the user, never by defaulting.
- **Self-correction rides the run-record pipeline.** The post-run critique is generated from the run record the engine already produces; a proposed amendment is a structured diff object attached to the run summary, applied through the same routine-update path as user corrections. This guarantees the "never silently rewritten" invariant because there is no second write path. Scope-widening detection compares the amendment's action categories against the routine's existing ones.
- **Proactive work is a per-bot flag plus an engine-side discovery pass** that runs on the existing run loop, feeds inferred deliverables through the normal task pipeline with a hard `draftOnly` constraint, and tags outputs with their motivating signals. Rejections are stored in bot memory as exclusions. Alternative (separate daemon/scheduler) rejected: routines already owns "when things run"; proactive work only owns "what to notice".

## Risks / Trade-offs

- [Chips could be abused to hide free text] → chips always accompany, never replace, the composer; spec requires free text to remain available.
- [Proactive inference produces unwanted noise] → opt-in per bot, digest-first surfacing, rejection-with-feedback stored as exclusions; draft-only boundary caps the blast radius.
- [Account-scoped grants widen the effective perimeter of a compromised bot] → visibility filtering + policy hook still gate use per bot; grants view gives one-stop revocation; audit log records grant creation/use per `security`.
- [Template import could smuggle instructions the user didn't read] → import is inert (nothing executes), full contents shown before creation; no code or tool definitions in templates, instructions only.

## Migration Plan

Additive throughout; no data migration. Grants registry starts empty and existing per-flow authorizations keep working until re-recorded as grants on next use. Rollback is feature-flag removal per area.

## Open Questions

- Should proactive discovery frequency be user-tunable or fixed conservative (start fixed)?
- Do starter workspace files ship in v1 of templates, or does v1 cover role+instructions only? (Lean v1: role+instructions.)
