# Tasks — Harden the platform against the security audit findings

## 1. Policy core

- [x] 1.1 `policy.ts`: `external-read` + `self-modify` categories, argument-aware
  `decide` (tighter-of-declared-and-classified), `ESCALATE_WHEN_TAINTED`,
  `decideForChain`, unknown category fails closed, `classifyFormField` /
  `classifyConnectorTool` (+ tests)
- [x] 1.2 `tools.ts`: `classify`, `untrustedOutput`, `signal` on ToolContext
- [x] 1.3 `loop.ts`: abort checks before each call and after a parked approval,
  taint tracking, `wrapUntrusted` envelope, chain intersection via `getBot`
  (+ tests)
- [x] 1.4 `engine.ts`: untrusted-content rule in the system prompt

## 2. Tool declarations

- [x] 2.1 Session shells categorized by whose machine (host → `shell-local`),
  honest host description, untrusted output (+ tests)
- [x] 2.2 `web_fetch` / `browse_goto` / `browse_read` → `external-read`;
  browse fill/click classify onto the floors (+ tests)
- [x] 2.3 Memory tools → `self-modify`; `skills/` writes classified via
  `isSkillPath` (+ tests)
- [x] 2.4 MCP tools classified by name; server responses marked untrusted

## 3. Integration

- [x] 3.1 Sync-back refuses `skills/` and reports it once (+ tests)
- [x] 3.2 `chatGlue` supplies `getBot` to both run loops
- [x] 3.3 Audit log module, hydrated at bootstrap, recorded from the loop,
  exportable (+ tests)
- [x] 3.4 Approval card renders unnamed arguments; draft actions show the
  summary beside the button (+ tests)
- [x] 3.5 Bot editor lists the new categories and marks all three floors
- [x] 3.6 Native bindings for pinned SSH target, bot-bound Fly commands,
  truncation-aware workspace listing (+ tests)
- [x] 3.7 Sign-out-of-all-sites reachable from session settings (+ tests)

## 4. Rust host

- [x] 4.1 `get_dev_api_key` compiled out of release; no path disclosure
- [x] 4.2 `host_set_target` pin; `host_exec` refuses every other target
- [x] 4.3 Fly commands bound to the owning bot
- [x] 4.4 `mcp_connect` command/env validation; sanitized child env
- [x] 4.5 SSRF blocklist: CGNAT, IPv4-in-IPv6 forms, benchmarking, multicast
- [x] 4.6 Workspace walk depth/entry caps with truncation flag
- [x] 4.7 `save_text_file` symlink refusal; canonical-path read/write; capped
  MCP line reads; per-server locks; process-group kill

## 5. Personal-host package

- [x] 5.1 Daemon token auth, method/path/Origin/Host checks, body cap
- [x] 5.2 Display adoption verified against `comm` + system exe path
- [x] 5.3 `0700` install directories; dependencies copied, not symlinked
- [x] 5.4 `--clear` reachable from the CLI; README updated

## 6. Verification

- [x] 6.1 `tsc` clean; 869 unit tests green; `cargo test` 87 green;
  `cargo check --release` clean
- [ ] 6.2 Follow-up (NOT in this change): key entry in Settings, without which
  a packaged release build has no API key source
- [ ] 6.3 Follow-up: host-key fingerprint confirmation on first connect
  (target pinning reduces but does not remove first-connect TOFU risk)
- [ ] 6.4 Follow-up: move the approval decision host-side so a renderer
  compromise cannot bypass it
