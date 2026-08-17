# Tasks — Add Personal Host

## 1. Host package (loaded onto the mini-PC)

- [x] 1.1 `host/package.json` + `host/browse.mjs`: client-or-daemon Playwright runner (goto/read/click/fill/status), persistent profile, localhost-only, idle self-exit
- [x] 1.2 `host/provision.sh`: idempotent — check node ≥ 20, npm install, install Chromium, create `~/.bots-host/{workspace,profile}`, print summary
- [x] 1.3 `host/README.md`: how to copy to the mini-PC, enable sshd, run provision, test from the Mac

## 2. App: SSH exec plumbing

- [x] 2.1 Extract session.rs runner into reusable `run_capped`; add `src-tauri/src/host.rs` with `host_exec` (target validation, BatchMode ssh, HOME/SSH_AUTH_SOCK passthrough) + Rust tests
- [x] 2.2 Register `host::host_exec` in lib.rs; add `hostExec` native binding (throws outside Tauri)

## 3. App: HostSessionProvider

- [x] 3.1 `lib/sessions/host.ts`: kind "host", per-bot workspace dirs, exec/read/write/list via ssh (base64 files, chunked writes, fly list parser), status probe, injected exec for tests (+ tests)
- [x] 3.2 `types.ts` kind "host"; exports; sessionGlue buildProvider + storage key for the SSH target; timeline label
- [x] 3.3 SessionSettings: "Personal host" option with SSH target field + validation + plain persistence statement

## 4. App: browse toolset

- [x] 4.1 `lib/sessions/browse.ts`: browse_goto/browse_read/browse_click/browse_fill wrapping session exec of browse.mjs; categories read/read/external-comms/external-comms; candidate-list errors on miss (+ tests)
- [x] 4.2 Register browse tools in sessionGlue when host provider is active; audit exec commands on the timeline as today

## 5. Verification

- [x] 5.1 Full unit suite + tsc + cargo test green (753 TS / 66 Rust)
- [x] 5.2 Walk delta scenarios; manual end-to-end against the real mini-PC (user-run) — verified 2026-08-15 against NucBox G3 (Ubuntu 24.04): full chain green, bot browsed successfully
