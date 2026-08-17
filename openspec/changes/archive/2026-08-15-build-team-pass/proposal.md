# Build Team Pass

## Why

The MVP proves single-bot chat works. This pass makes it a *team*: bots talk to each other with an Executive Assistant coordinating, bots remember things, bots get real (gated) capabilities, and the app behaves like an always-on Mac citizen. Exercises `multi-bot-collaboration` (local subset), `bot-memory` (lite), `task-execution`/`human-handoff` (tool + approval subset), `messaging` (group threads), `notifications` (native subset), and `mac-app-shell` (menu bar extra).

## What Changes

- **Group threads + bot-to-bot + EA lite**: thread model reworked (direct + group threads with participants); a coordinator-designated Bot can delegate to other bots via a send-to-bot tool, with the exchange visible in the group thread; avatars play talkingToBot/handoff states during delegation.
- **Memory lite**: per-Bot persistent memory entries; remember/forget via tool calls in chat; editable memory panel; memory composed into the bot's system context.
- **Tools + approvals**: OpenRouter tool-calling loop in the engine; tool registry with sandboxed per-bot file workspace (Rust, path-guarded), web fetch (Rust, size/time-limited), and a mock send-email tool gated behind approval; gated calls pause the bot (waitingOnUser avatar state) until approved/denied in the thread or the new Waiting-on-you inbox.
- **Mac polish**: native notifications (task complete / waiting on you, only when unfocused), menu bar tray with per-bot status + Pause All, dock badge = pending count.
- **E2E tests**: Playwright harness against the Vite app with the Tauri bridge mocked; core flows covered. Live streamed-completion smoke added.

## Out of Scope

Cloud Agent Computer, computer use, live view, routines, funnel-mode notifications.

## Impact

- `app/src/features/chat` (thread model migration), `app/src/lib/engine` (tool loop, memory, delegation), `app/src-tauri` (workspace fs, web fetch, tray, notifications), new `app/src/lib/native`, new `app/e2e/`, App wiring.
- New deps (preinstalled): @playwright/test, @tauri-apps/plugin-notification (+ Rust crate added during the pass).
