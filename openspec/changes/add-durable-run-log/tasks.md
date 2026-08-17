# Tasks — Add Durable Run Log

## 1. The store

- [x] 1.1 New `lib/engine/runLog.ts`: append-only entries (`assistant-calls`, `tool-result`) keyed by runId with botId/threadId/at, persisted through the engine storage abstraction on every append
- [x] 1.2 `record`, `entriesFor(runId)`, `openRuns()` (interrupted runs, newest first), `complete(runId)` (drops the run's entries), `hydrate`, plus an attempt counter per run
- [x] 1.3 `reconstructMessages(systemContent, threadHistory, entries)` — the single function both the live loop and a resume path use to build `messages`
- [x] 1.4 Tests: append/persist/hydrate roundtrip, entries scoped per run, completion drops them, attempt counter increments

## 2. The loop

- [x] 2.1 `RunLoopDeps.runLog?: RunLogSink` (mirroring the existing `audit?: AuditSink`) and `resumeFrom?: RunLogEntry[]`
- [x] 2.2 Build `messages` via `reconstructMessages` so the live path and the resume path cannot diverge
- [x] 2.3 Record the assistant-with-tool_calls message and each tool result at the existing choke point, as they complete
- [x] 2.4 Mark the run complete in the log on every terminal path (done, error, abort, pause)
- [x] 2.5 Tests: a run records what it ran; a resumed run's messages equal the interrupted run's; without a `runLog` dep the loop behaves exactly as before

## 3. The invariant

- [x] 3.1 Test: reconstructing from thread store + run log equals the live run's in-memory messages, in order — the check that fails when a new model-visible input skips the log

## 4. Resumption

- [x] 4.1 `chatGlue.ts`: pass the real run log into `runLoop`; `resumeInterruptedRuns()` that reconstructs and re-enters qualifying runs
- [x] 4.2 Qualification: younger than 24 hours, fewer than 2 prior resume attempts, bot not paused or deleted. An unanswered approval needs no check — approvals are per-run and in-memory, so re-entering re-parks the request by construction rather than inheriting an answer the user never gave (design decision 5 revised)
- [x] 4.3 Each resumed run posts one line in its thread before continuing
- [x] 4.4 `bootstrap.ts`: hydrate the run log, then resume what qualifies
- [x] 4.5 Tests (8): qualifying run resumes with context and posts the line; stale, twice-attempted, paused-bot and deleted-bot runs do not; boundary case pinned; multiple runs resume newest first

## 6. Durable thread history

- [x] 6.1 `features/chat/store.ts`: settled messages (user messages, finished replies, timeline events) write through immediately; only streaming deltas debounce
- [x] 6.2 Bound the debounce with a max wait, so a reset-on-every-change timer cannot be starved by a long stream
- [x] 6.3 Tests: write-through on settle, deltas still debounced, finalize writes through, a 20-delta stream still persists
- [x] 6.4 `e2e/resume-run.spec.ts` no longer needs its artificial flush window — an abrupt reload now resumes

## 5. Verification

- [x] 5.1 `npm test` + `tsc --noEmit` (app and e2e) green
- [x] 5.2 E2E `e2e/resume-run.spec.ts`: a run interrupted mid-tool-call (a hanging exec, via the new one-shot `hangNextExec` mock) resumes after a reload, posting the line and carrying its earlier step into the resumed request
- [x] 5.3 Walk the delta spec's scenarios
- [x] 5.4 Drive-by: `chatGlue.ts:103` comment still refers to "exec audit lines" that no longer exist
