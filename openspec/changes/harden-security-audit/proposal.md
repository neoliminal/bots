# Proposal: Harden the platform against the security audit findings

## Why

A five-surface security audit (Rust host, policy pipeline, session providers,
personal-host package, renderer) found 27 issues, four critical. The renderer
was clean and the path-validation, quoting, and SSRF work held up under
attack. The gap was structural: **the approval gate guarded outbound
communication and deletion, and nothing else.**

Three consequences, all confirmed against the source:

1. The personal-host provider was categorized by "is it local?", so a shell on
   the user's own persistent machine — holding their SSH keys and a
   logged-in browser — ran with no approval, while the model was told the
   machine was a disposable micro-VM.
2. `credential` and `payment` were declared hard floors but **no tool ever
   declared either category**, so two thirds of the platform's sensitive-action
   invariant was dead code. `decide()` discarded its arguments, so it could
   classify a tool but never an action — and no tool is inherently a payment,
   only a call is.
3. Nothing labelled third-party text as untrusted, and the tools that let
   injected content escalate (write to the bot's own memory or skills, delegate
   to a teammate under a different policy, reach the network again) all
   defaulted to allow.

## What Changes

- **Categorize shells by whose machine they run on**, not by locality: the
  personal host becomes `shell-local` (approval), and its tool description
  stops claiming ephemerality.
- **Make the floors reachable**: tools may declare a per-call `classify(args)`;
  the policy hook takes the *tighter* of declared and classified category, so
  classification can only add friction. Password/OTP/card fields and
  payment-shaped connector calls now land on the floors they always claimed.
- **Two new categories.** `external-read` separates reading the internet (also
  an egress channel) from reading local files. `self-modify` separates writes
  that become part of the bot's own system prompt (memory, `skills/`) from
  ordinary file writes.
- **Untrusted-content taint.** Tools whose output is third-party controlled are
  marked; their results are wrapped in a delimiter-stripped envelope labelled
  as data, and once such content enters a run, `self-modify`, `delegation`, and
  `external-read` escalate to approval. A clean run is unaffected.
- **Delegation intersects policy along the chain** — a delegated run may do no
  more than the most restricted bot upstream of it.
- **Stop actually stops**: the loop checks its abort signal before each tool
  call and after a parked approval resolves, and tools receive the signal.
- **Sync-back refuses `skills/`** — the one direction where remote-chosen
  filenames land on the user's machine.
- **An append-only audit log** records every tool decision and outcome,
  including the ungated ones the user cannot otherwise see, and exports as text.
- **Host-side defense in depth** (Rust): the dev key command is compiled out of
  release builds; SSH targets are pinned to the configured host; Fly machine
  commands are bound to the owning bot; `mcp_connect` validates command and
  env-key shape; workspace listing is depth/entry capped; SSRF blocklist gains
  CGNAT and the missing IPv6 forms; several TOCTOU and unbounded-read fixes.
- **Personal-host package**: the browsing daemon requires a per-install token
  and rejects cross-origin and rebinding requests; display adoption verifies
  the process against the kernel-recorded name and a system path; profile and
  workspace directories are `0700`; signing out of all sites is reachable from
  Settings.

## Impact

- Specs: `security` (untrusted content, audit log), `human-handoff` (reachable
  floors, chain intersection, Stop), `agent-computer` (personal host is the
  user's machine; browse daemon auth; sign-out control),
  `tool-extensibility` (new categories, argument-aware policy, classify).
- Code: `lib/engine/{policy,loop,tools,memory,skills,audit}.ts`,
  `lib/sessions/{tools,browse,sync,fly}.ts`, `lib/native`, `app/{tools,
  chatGlue,sessionGlue,bootstrap,ApprovalCard,BotEditor,SessionSettings}.tsx`,
  `src-tauri/src/*`, `host/*`.
- **Behavior change to note:** a packaged release build has no API key source,
  because reading `keys/.env` is now development-only. A key-entry path in
  Settings is required before shipping.
