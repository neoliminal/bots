# Add Personal Host

## Why

The user owns an always-on mini-PC — exactly the persistent machine that makes always-on bots valuable (persistent logins, no idle cloud cost, a physically-owned security perimeter). Today sessions are only local-Mac or ephemeral Fly micro-VMs, and no bot can browse the web at all: the biggest capability gap ("bots that surf for you") needs both a persistent host and a browsing toolset.

## What Changes

- **Personal host session provider**: a third `SessionProvider` ("host") that runs sessions on a user-owned machine over SSH — per-bot workspace directories under one root, files moved as base64 over exec, no daemon or open ports beyond sshd.
- **Host provisioning package**: a `host/` directory the user copies onto the mini-PC and runs once (`provision.sh`) — installs the browse runtime (Node + Playwright Chromium), creates the workspace/profile layout, and is idempotent.
- **DOM-driven browse toolset**: `browse_goto` / `browse_read` / `browse_click` / `browse_fill` engine tools backed by a persistent Chromium profile on the host (Playwright over the DevTools protocol — no vision model). Page state lives in a small localhost-only daemon on the host, auto-started on first use.
- **Persistent logins with human handoff**: the browser profile persists cookies, so a site logged into once stays logged in for every bot; login/2FA screens pause for the user per the platform invariant (`credential` category tools are never auto-approved).
- **Policy gating**: navigation/reading is `read`; clicking/filling in a logged-in browser is `external-comms` (approve by default).

## Capabilities

### New Capabilities

_None — this extends the agent-computer capability rather than introducing a new one._

### Modified Capabilities

- `agent-computer`: new requirements for a user-owned persistent host provider (explicitly exempt from ephemeral-by-default, with its persistence stated to the user) and for the DOM-driven browsing tool surface with a persistent profile.

## Impact

- `app/src/lib/sessions/` — new `host.ts` provider + `browse.ts` toolset (+ tests); `types.ts` gains kind "host"; exports.
- `app/src/lib/native/` + `app/src-tauri/src/host.rs` — one new `host_exec` command (ssh spawn with output cap/timeout, reusing session.rs runner).
- `app/src/app/sessionGlue.ts` / `SessionSettings.tsx` — provider choice gains "host" with an SSH target field; browse tools registered for the host provider.
- New top-level `host/` package (provision.sh, browse.mjs daemon, package.json, README) — loaded onto the mini-PC by the user.
- Sync-back continues to apply: the local workspace stays the source of truth for files; only browser state (profile) is host-persistent.
