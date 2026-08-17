# Design — Add Personal Host

## Context

`SessionProvider` is a clean 7-method seam with local and Fly implementations. The mini-PC becomes a third implementation. Browsing needs page state to survive across tool calls, but the app must not require any new open port on the host.

## Goals / Non-Goals

**Goals:** SSH provider; one-command host provisioning; DOM-driven browse tools with persistent profile; everything testable without a real host.

**Non-Goals:** pixel/vision computer use; screen streaming/live view (separate spec); Windows hosts in v1 (Linux/macOS with sshd); multi-user hosts.

## Decisions

- **SSH as the only transport, one Rust command.** `host_exec(target, cmd, timeoutMs)` spawns `ssh -o BatchMode=yes` reusing session.rs's capped/timed runner (extracted into `run_capped`). Target is strictly validated (`user@host` charset) so no ssh option injection is possible. No daemon on the host for exec; files move as base64 through exec (chunked appends for large writes). Alternatives (host HTTP agent, mosh) rejected: sshd is already there, already authenticated, already encrypted.
- **BatchMode + user key material.** The app never prompts for or stores SSH passwords; if the key needs an agent/passphrase, ssh fails fast and the error surfaces. `HOME` and `SSH_AUTH_SOCK` are passed through (unlike sanitized local exec) because ssh needs the user's keys — the command still gets no app secrets.
- **Browse state lives in a localhost-only daemon on the host, reached through SSH exec.** `browse.mjs` runs as client-or-daemon: each tool call execs `node browse.mjs <b64-request>`; the client POSTs to `127.0.0.1:8377`, auto-spawning the detached daemon on first use. The daemon holds one Playwright persistent context + page. No listener beyond loopback; reachability is inherited from SSH. Alternative (fresh browser per call) rejected: page state must survive between goto/read/click; (SSH port-forwarding to the app) rejected: more moving parts for no capability gain.
- **DOM-driven, not vision.** Read = title/URL/main text + interactive elements (role + accessible name); click/fill resolve by role+name via Playwright locators and return candidate lists on ambiguity/miss. An order of magnitude more reliable than pixels and needs no model round-trips.
- **Provider stays dumb; browse tools are separate.** `HostSessionProvider` implements only the 7 methods (reusing fly's exported `LIST_FILES_CMD`/`parseListOutput`). Browse tools are their own `createBrowseTools` registered by sessionGlue only when the host provider is active, keeping the provider seam unchanged.
- **Injected exec for testability.** The provider takes an exec function defaulting to the native binding, so vitest exercises the full command grammar (quoting, chunked writes, parse) with a fake host and zero Tauri.

## Risks / Trade-offs

- [Mini-PC off → tools fail] → fail-plain per spec; status probe marks the host unavailable; no queuing in v1.
- [Logged-in browser is a powerful effector] → click/fill are `external-comms` (approve-default); logins always human-performed; profile clearable per site from the app.
- [Chunked base64 writes are slow for big files] → fine under the existing 5MB cap; revisit with sftp if it ever matters.
- [Daemon can die/leak] → idle self-exit after 30 min; client restarts it on demand; provision.sh is re-runnable.

## Migration Plan

Purely additive third provider; default stays "local". Rollback = switch provider back; host keeps only its workspace dirs and browser profile, both deletable.

## Open Questions

- Profile-clearing UI placement (SessionSettings vs GrantsView integration) — v1 ships a "clear browsing state" action in SessionSettings.
- Should Fly sessions get the browse toolset too (installing the package in the VM)? Deferred.
