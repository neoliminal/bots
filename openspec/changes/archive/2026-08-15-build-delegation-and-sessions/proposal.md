# Build Transparent Delegation + Compute Sessions

## Why

Two spec redesigns are unimplemented: `multi-bot-collaboration` (transparent peer delegation via capability cards + ephemeral instances, replacing coordinator/group-chat mechanics) and `agent-computer` (on-demand compute sessions with local-first file sync, replacing the always-on VM concept).

## What Changes

- **Capability cards**: per-bot work log of completed deliveries; deterministic (non-LLM) experience summary compiled from it; card = role + experience + availability, size-bounded, versioned, user-editable/pinnable.
- **Delegation v2**: every bot gets `contact_bot` (teammates' cards in its context); structural ancestry-chain cycle refusal, depth cap 2, fan-out caps; inline collapsible delegation cards in any thread (group threads now optional); coordinator toggle removed (EA = role template); stop cancels the delegation tree; approval provenance chains.
- **Ephemeral instances**: busy target bot spawns an instance from a memory snapshot (cap 3/bot), runs concurrently, atomic memory merge-back (newest-wins, conflicts flagged in history); instances visibly badged; pause/delete halts instances.
- **Compute sessions**: provider-agnostic session API (provision/exec/read/write/stop); local sandboxed provider (default; exec gated); Fly Machines provider (REST, mock-tested, activates with FLY_API_TOKEN in keys/.env); local workspace source of truth with sync-back after modifying calls and at checkpoints; idle auto-stop; session events on the thread timeline.

## Impact

`app/src/lib/engine` (major), new `app/src/lib/sessions`, `app/src-tauri` (local exec + Fly provider + sync), `app/src/features/chat` (delegation cards), App wiring, E2E updates.
