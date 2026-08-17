# Tasks — Add Teammate Approachability Features

## 1. Cursor-following idle gaze (spec sync — code already shipped)

- [x] 1.1 Implement `useCursorGaze` hook + `followCursor` prop on `BotAvatar`, wired to active-thread header avatars, with unit tests
- [x] 1.2 Verify implemented behavior against the `bot-avatars` delta scenarios (active-only, non-wander states, pointer-leave fallback, reduced motion)

## 2. Chat choice chips and inline draft actions

- [x] 2.1 Extend chat store message model with optional `choices` and `draftActions` blocks (+ store tests)
- [x] 2.2 Parse structured choice/draft markers from the assistant stream in `chatGlue` (+ tests with fake `chatStream`)
- [x] 2.3 Render choice chips in `ThreadView`: click posts a user message, chips go inert once answered, composer stays live (+ component tests)
- [x] 2.4 Render inline draft actions wired to the existing approvals pipeline (same path as `ApprovalCard`) (+ tests)
- [ ] 2.5 E2E: bot offers options → chip click sends selection; draft message → post action flows through approval

## 3. Persona templates

- [x] 3.1 Define versioned template JSON schema + load/validate/serialize module in `lib/engine` (+ tests, including reject-on-unknown-version)
- [x] 3.2 Export bot as template from BotEditor: role/description/instructions only, preview of exact contents before write (+ tests)
- [x] 3.3 Import template into the create-bot flow: prefill editable fields, inspectable contents, nothing executes on import (+ tests)
- [ ] 3.4 E2E: export a bot, re-import it, create a new bot from the template

## 4. Account-scoped connector authorization

- [x] 4.1 Add `lib/engine/grants` registry (create/list/revoke, storage-persisted) (+ tests)
- [x] 4.2 Consult grants in the tool loop before offering connector/MCP tools; keep visibility filter + policy hook as the per-bot gate (+ loop tests)
- [x] 4.3 Record a grant on successful authorization from any conversation; second bot needs no re-auth (+ tests)
- [x] 4.4 Grants view UI: list service/date/eligible bots, one-click revoke cuts off all bots (+ tests)
- [ ] 4.5 Audit-log grant creation, use, and revocation per `security`
- [x] 4.6 Multi-account grants: key registry on (integration, label), explicit account targeting in tool calls, ask-on-ambiguity, independent revocation (+ tests)

## 4b. Post-run self-correction

- [ ] 4b.1 Generate post-run critique from the run record; emit structured amendment proposals (step diff + observation) (+ tests)
- [ ] 4b.2 Apply amendments through the existing routine-update path: approval-gated when supervised, apply-and-report when autonomous (+ tests)
- [ ] 4b.3 Scope-widening detection: new action categories always require approval; amendments recorded and revertible in routine history (+ tests)

## 5. Proactive work discovery

- [ ] 5.1 Add per-bot `proactive` opt-in flag (bot store + BotEditor toggle), default off (+ tests)
- [ ] 5.2 Engine discovery pass: infer deliverables from connected context, tag with motivating signals, run through task pipeline with hard `draftOnly` constraint (+ tests)
- [ ] 5.3 Enforce draft-only boundary: outward-facing/destructive steps always convert to approval requests (+ tests)
- [ ] 5.4 Surface drafts via notifications urgency/digest rules; no "nothing to report" messages (+ tests)
- [ ] 5.5 Rejection-with-feedback stored as memory exclusions; excluded classes stop re-inferring (+ tests)
- [ ] 5.6 Disable-mid-flight: turning the flag off stops discovery and parks in-progress drafts (+ test)

## 6. Verification

- [ ] 6.1 Full unit suite + typecheck green; E2E specs for chips, templates, and grants pass
- [ ] 6.2 Walk every delta scenario in `specs/` against the implementation; fix gaps
