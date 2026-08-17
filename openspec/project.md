# Project Context

## Purpose

**Bots** is a persistent AI teammate platform. Each user creates one or more named, durable Bots that chat like teammates, remember, and do real work: they call tools, get OS access through on-demand compute sessions (a lightweight VM that exists only while a task needs a shell — see `agent-computer`), collaborate with each other transparently by capability, learn multi-step workflows from a single demonstration, and deliver finished work *inside* the system of record (the email is in Drafts, the CRM is updated, the ticket is filed) rather than as a draft for the user to act on. Files live locally on the user's machine (the source of truth); compute is disposable. A future hosted phase adds always-on desktop sessions with persistent browser logins, live view, and takeover.

The client is a **cross-platform desktop app (macOS and Windows)**. On each platform it must look, feel, and behave like a first-class native app (menu bar / system tray presence, native notifications, signed, auto-updating), even though it is not built with purely native tooling. macOS remains the design-reference platform; Windows is a fully supported peer (the Rust host abstracts the platform shell, process management, and paths — see `app/src-tauri`).


## Tech Stack

### Desktop client ("Bots" — macOS & Windows)
- **Tauri 2** (Rust host + system webview: WKWebView on macOS, WebView2 on Windows) — chosen over Electron for small footprint (~15 MB vs ~150 MB), lower memory, native OS integration (menu bar/tray, dock badges on macOS, native notifications, deep links, OS credential store), and a Rust core for performant local work. Distributed signed (+ notarized on macOS) with auto-update (Tauri updater). Platform-specific behavior lives behind small per-OS branches in the Rust host: `/bin/sh` vs `cmd.exe` for session commands, Unix process groups vs `taskkill /T` for cleanup, per-OS sanitized PATHs.
- **React 18 + TypeScript + Vite** for the UI layer; TailwindCSS for styling.
- **WebRTC** (via LiveKit client SDK) for the live session view — deferred to the future desktop phase alongside `live-view`.
- **Rive** for the Bot ball avatars — a single state-machine-driven animation asset (color as an input, one state per Bot activity), GPU-composited, cheap enough for 8+ concurrent avatars and scalable down to menu-bar size.
- **SQLite** (via Tauri plugin) for the local message/outbox cache and offline reads.
- **OS credential store** (Keychain on macOS, Credential Manager on Windows) for local secrets (session tokens); no plaintext secrets on disk.

### Compute (Agent Computer = on-demand sessions)
- **On-demand compute sessions**, not an always-on cloud desktop: a lightweight Linux VM provisions when a bot's task needs OS-level tools (shell, filesystem, package install), and auto-stops when idle. The user's **local workspace is the source of truth** — modified files sync back after each modifying tool call and at mid-process checkpoints, so sessions are disposable and nothing persists overnight.
- **Provider:** Fly.io Machines (Firecracker; sub-second warm starts from stopped, storage-only cost while stopped) as the primary target; a plain cheap VPS (e.g., Hetzner) as an interchangeable alternative behind the same session interface. Provider-agnostic session API so this can change.
- **Orchestration:** the desktop app is the orchestrator for the personal-use phase — task state, schedules, and retries are checkpointed locally (no server-side workflow engine required). A cloud orchestration tier (Temporal, Postgres, WebSocket fanout) remains the path for a future multi-device/hosted phase.
- **Deferred to a future desktop phase:** persistent per-Bot screens, browser profiles/logins, desktop streaming (LiveKit/WebRTC) and input takeover — see `live-view` and `human-handoff` for the specs that activate then.

### AI layer
- **User-configurable model per Bot** (see `model-configuration`): each Bot's LLM is chosen by the user. Model access is routed through **OpenRouter** initially (one integration, many providers/models), behind an internal provider-agnostic routing layer keyed by (provider, model, credential) so direct provider keys and non-OpenRouter endpoints plug in later without redesign.
- **Bring-your-own keys:** users supply their own API keys (OpenRouter now; direct provider keys as added). Keys live in the credential vault, are injected server-side at egress, are never visible to Bots/model context/logs, and any key can serve any Bot.
- **Self-hosted agent loop** — the platform owns the VMs and the tool runtime, and drives whichever model the Bot is configured with via tool/function calling. Computer-use work requires a vision + tool-calling capable model (enforced by the model picker's capability guardrails). Recommended defaults surfaced in the picker: a frontier agentic model as primary, a small fast model as the utility model for triage/routing/summarization.
- **Computer use**: screenshots from the Bot's virtual display + actions injected into the VM, alongside dedicated tools (bash, file editor) and MCP connectors for services with official integrations.
- **Long-session hygiene:** prompt caching on stable prefixes where the provider supports it, transcript compaction for multi-day sessions, memory tool backed by the Bot's memory store.

## Design Pillars

- **Minimize the human's typing and mental load — even when it costs the AI more work.** Typing is cheap for a Bot and expensive for a person: every keystroke we ask of the user is mental load. Whenever an interaction *can* be a click, a chip, a prefilled field, an inferred default, or work the Bot simply does itself, it SHALL be — even where asking the user to type would make the implementation simpler. Free-text always remains *available* (never trapped in a menu), but it must never be *required* when the system could have offered the answer. This pillar governs UI decisions (question cards over "please reply with…", prefilled editors over blank forms, one-click approvals over typed confirmations) and agent behavior (infer, propose, and prepare rather than interrogate; ask one well-formed question with options rather than three open-ended ones).

## Project Conventions

- Specs live in `openspec/specs/<capability>/spec.md`; one capability per directory. Changes go through `openspec/changes/<change-id>/` and are archived on deployment.
- Requirements use RFC-2119 keywords (SHALL/MUST). Every requirement has at least one `#### Scenario:` in WHEN/THEN form.
- "User" means the human account owner; "Bot" means a persistent AI teammate instance; "Agent Computer" means an on-demand compute session (ephemeral VM) a Bot uses for OS/tool access; the "workspace" is the local, synced source of truth for files.
- Sensitive actions (credentials, 2FA, payments, irreversible deletions) always pause for human involvement — this is a platform invariant, restated in the `human-handoff` capability.
- Local development secrets live in `keys/` (plain-text `.env`, `OPENROUTER_API_KEY=...`), which is gitignored along with all `.env*` files. Key values never appear in specs, code, commits, or logs; production key handling is specified in `security` and `model-configuration`.

## Capability Map

| Capability | Covers |
|---|---|
| `mac-app-shell` | The desktop app shell (macOS & Windows): window, menu bar / tray, notifications, updates, offline |
| `messaging` | Chat with Bots: threads, group chats, attachments, delivery |
| `bot-management` | Creating, configuring, pausing, and deleting named Bots |
| `bot-memory` | Persistent memory, preferences, voice/tone, context compounding |
| `agent-computer` | On-demand compute sessions: OS/tool access, local-first file sync, ephemeral by default |
| `task-execution` | End-to-end task ownership: planning, tools, connectors, checkpointed continuity |
| `live-view` | Watching a Bot's session live from the app (future desktop phase) |
| `human-handoff` | Takeover for sensitive steps; approvals |
| `multi-bot-collaboration` | Bot↔Bot messaging, task handoff, shared files/context |
| `routines` | Learn-by-demonstration, saved routines, schedules |
| `notifications` | What surfaces to the user, when, and through which channel |
| `security` | Credential handling, isolation, audit, data protection |
| `model-configuration` | Per-Bot LLM selection, OpenRouter catalog, BYO keys, fallbacks, usage/cost |
| `bot-avatars` | Animated ball avatars: colors, expressive eyes, state-driven animations |
