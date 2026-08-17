# Tasks — Trust Local Shell

## 1. The default

- [x] 1.1 `lib/engine/policy.ts`: `DEFAULT_CATEGORY_RULES["shell-local"]` → `"allow"`; the "reproduce pre-policy behavior" comment replaced with why local shell is trusted (gates guard effects not syntax; workspace-locked, capped; floors unmoved; every call still audited)
- [x] 1.2 `policy.test.ts` expectations updated. `loop.test.ts` / `skills.test.ts` use explicit per-bot rules and needed no change (verified — full suite green)
- [x] 1.3 Tests: hard floors stay `approve` even when a bot's policy tries to allow them; `external-comms` still gated; taint escalation unchanged
- [x] 1.4 Test: a per-bot `shell-local: "approve"` still prompts, plus a test that the two shell categories never diverge ("location does not change the answer")

## 2. Quieting the thread

- [x] 2.1 `app/sessionGlue.ts`: `session_exec` timeline post dropped; the wrapper keeps its `lastSessionThread` bookkeeping so lifecycle events still route correctly
- [x] 2.2 Lifecycle events (provisioned / warm-resumed / stopped) and sync-back warnings verified still posting; a new test asserts one lifecycle line per *session*, not per command
- [x] 2.3 `sessionGlue.test.ts` rewritten for the new behavior; module header comment corrected. Also removed the now-dead `"exec"` `SessionEventKind` and `MessageMeta.command` (nothing emitted them), with `ThreadView`'s exec-specific mono styling and the two tests that used them repointed at sync-warnings

## 3. Activity log

- [x] 3.1 New `app/src/app/ActivityLog.tsx`: newest-first list over `auditLog` — time, bot, delegation chain when present, what ran, and the decision, with "Ran on its own" deliberately unremarkable and denials/refusals visually distinct
- [x] 3.2 Filter by bot as chips, offering only bots that actually appear in the log
- [x] 3.3 Export wired to `exportAuditLog` + `saveTextFile`, exporting the *filtered* view; the entry cap and count stated on screen
- [x] 3.4 Rendered as its own section in `SessionSettings`, with an empty state
- [x] 3.5 Tests (8): ordering, autonomous-call presence, decision rendering, bot filter, filter list construction, delegation chain, export contents, cap/count line, empty state

## 4. Copy

- [x] 4.1 `computeOptions.ts`: local option no longer promises per-command approval — own folder on this Mac, stops when the Mac sleeps, sensitive actions still pause, everything in the Activity log
- [x] 4.2 `onboardingCompute.ts`: all three "I'll ask before each command" confirmations rewritten
- [x] 4.3 `SessionSettings.tsx` module header comment
- [x] 4.4 No test changes needed — the existing assertions key on `This Mac —` and `Right here it is`, both of which survived the rewrite (verified)

## 5. Verification

- [x] 5.1 `npm test` (901 passing, 59 files) + `tsc --noEmit` for app and e2e — clean
- [x] 5.2 E2E `e2e/trusted-shell.spec.ts`: shell runs with no approval card and no command anywhere in the thread; the Activity log holds it, attributed and marked "Ran on its own". Full e2e suite 17/17
- [x] 5.3 Walked all three delta specs' scenarios against the implementation — each maps to a passing test (unit for the policy scenarios, e2e for the thread/log scenarios, ThreadView test for the sync-warning scenario)
- [ ] 5.4 Manual pass in `npm run tauri dev`: real workspace work with no prompts, commands present in the Activity log afterwards — user-run
