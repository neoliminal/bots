# Tasks — Build Transparent Delegation + Compute Sessions

## 1. Capability cards (multi-bot-collaboration)

- [x] 1.1 Per-bot append-only work record store (`engine/worklog.ts`): completed deliveries with tools used, deliverables, learned corrections; bounded retention; category taxonomy
- [x] 1.2 Deterministic (non-LLM) experience compiler + size-bounded, versioned capability card store (`engine/cards.ts`), with user pin/edit/revert and availability derivation
- [x] 1.3 Card UI (`app/CapabilityCardPanel.tsx`): current card, version history, pin/edit controls
- [x] 1.4 Completed deliveries (direct and delegated, instance runs included) accrue to the canonical bot's work record and re-publish its card (`app/chatGlue.ts`)

## 2. Delegation v2 (multi-bot-collaboration)

- [x] 2.1 `contact_bot` engine tool for EVERY bot with teammates; per-bot description embeds teammates' live capability cards (`engine/delegation.ts`)
- [x] 2.2 Structural safeguards: ancestry-chain cycle refusal, depth cap 2, per-run fan-out cap, paused/not-contactable refusals with exact model-facing texts
- [x] 2.3 Delegation works from ANY thread: inline collapsible delegation cards in the originating thread (target avatar/name, brief, live status, expandable report, instance badge) — `features/chat/ThreadView.tsx`
- [x] 2.4 Coordinator toggle removed (EA is a role template, not a mechanism); group threads remain optional UI
- [x] 2.5 Run tracker (`engine/runs.ts`): delegation trees with parentRunId; Stop cancels the entire tree; bot deletion cancels all its runs and withdraws parked approvals
- [x] 2.6 Approval provenance chains carried through delegated runs

## 3. Ephemeral instances (multi-bot-collaboration, bot-memory)

- [x] 3.1 Instance registry (`engine/instances.ts`): busy targets spawn an instance from a memory snapshot, cap 3 per bot, visibly badged ("copy")
- [x] 3.2 Instance runs execute concurrently (never queued behind the busy canonical bot)
- [x] 3.3 Atomic newest-wins memory merge-back on success, conflicts flagged in merge history (memory panel); failed/cancelled instance runs merge nothing
- [x] 3.4 Pause/delete of the canonical bot halts its instances at safe boundaries

## 4. Compute sessions — provider layer (agent-computer)

- [x] 4.1 Provider-agnostic session API (`lib/sessions/types.ts`): provision/exec/readFile/writeFile/listFiles/stop/status
- [x] 4.2 Local sandboxed provider (default): Rust `session_local_exec` — /bin/sh -c locked to the bot's workspace, sanitized env, 256KB output cap, 30s default / 300s max timeout, process-group kill (`src-tauri/src/session.rs`)
- [x] 4.3 Fly Machines provider over REST, Rust-side (`src-tauri/src/fly.rs`): find/create/start machine per bot, warm restart of stopped machines, exec/read/write/stop/status; FLY_API_TOKEN read from keys/.env and never exposed to the webview; mock-tested
- [x] 4.4 Session lifecycle store (`lib/sessions/store.ts`): one session per bot, transparent provision on first acquire, coalesced concurrent provisions, idle auto-stop timer (default 10 min) reset on use
- [x] 4.5 Sync-back engine (`lib/sessions/sync.ts`): local workspace as source of truth — modified files copied back after each modifying call and at 60s checkpoints during long execs; write-through for session file writes

## 5. Compute sessions — app wiring (agent-computer, task-execution)

- [x] 5.1 Session tools registered in the app tool registry per gating rules: `session_exec` GATED on local (runs on the user's Mac), NOT gated on Fly (disposable micro-VM); file ops never gated (`app/sessionGlue.ts`)
- [x] 5.2 Provider selection in Settings (`app/SessionSettings.tsx`): Local (default) / Fly Machines; Fly shows its unconfigured state with instructions to add FLY_API_TOKEN to keys/.env; choice persisted and re-applied at bootstrap
- [x] 5.3 Transparent provisioning: nothing spins up until a bot's first session tool call; the only user-visible trace is the timeline indicator
- [x] 5.4 Thread/task timeline: subtle in-thread session indicators (provisioned / warm-resumed / stopped) routed to the thread the work ran in
- [x] 5.5 Audit: every `session_exec` command recorded in the task record as a timeline entry (`$ <cmd>`), excluded from model context
- [x] 5.6 Idle auto-stop wired app-side (per-session timer, reset on every session tool use); app quit stops all sessions best-effort (`App.tsx` beforeunload)

## 6. Tests + verification

- [x] 6.1 Unit coverage for worklog, cards, delegation safeguards, instances, runs, session providers/store/sync/tools, session glue, settings surface, chat store timeline events, ThreadView session rendering (545 tests green)
- [x] 6.2 Rust tests for workspace validation, local exec sandbox, and the Fly client against a mock server (57 tests green)
- [x] 6.3 Playwright e2e updated for the redesigns (no coordinator toggle; group threads optional) — 7 baseline specs green
- [x] 6.4 New e2e: mocked model triggers `contact_bot`; the inline delegation card appears in the originating direct thread, resolves to done, and expands to the target's report (8 e2e green)
- [x] 6.5 Full checks green: `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `cargo check`, `cargo test`, `npx playwright test`
