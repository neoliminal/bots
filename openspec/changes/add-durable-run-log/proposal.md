# Add Durable Run Log

## Why

`task-execution` requires that "interrupted tasks SHALL resume from the last checkpoint automatically", and `agent-computer` promises that after an interruption "only the in-flight step re-runs". Neither is true today. A run's model context — the assistant messages carrying tool calls and the tool results answering them — lives in a local `messages` array inside `runLoop` (`loop.ts:387`) and nowhere else; `runs.ts` is an in-memory tracker with no persistence. Quit the app while a bot is six commands into a task and every one of those steps is unrecoverable: the thread holds the user's request and perhaps a partial reply, and nothing records what already ran.

The gap became sharper when commands stopped appearing in the thread. Their trail is now the audit log, which is a *record* — deliberately summary-only, secret-free, and capped — not resumable state.

DeepSeek's Harness names the invariant that closes this cleanly: **model-visible means logged** — anything reaching a model request must be recoverable from an append-only log, with history rebuilt from it rather than accumulated in memory. Bots already honors half of it: `threadHistoryFor` derives conversation history from the persisted thread store. Tool steps are the half that escapes.

## What Changes

- **A durable run log**: an append-only, per-run record of the steps that make up a run — each assistant message that requested tool calls, and each tool result — persisted through the existing engine storage abstraction as the run proceeds, not at its end.
- **The loop records and resumes**: `runLoop` gains an injected `runLog` sink (alongside the existing `audit` sink) written at the single place tool calls already funnel through, and accepts recorded steps to seed `messages` on resume. A resumed run re-enters with its completed steps intact and re-runs only the step that was in flight.
- **The invariant is testable**: reconstructing a run's messages from the log SHALL produce what the live run held. A new kind of model-visible input that is not logged fails that test.
- **Interrupted runs resume on launch**, visibly and conservatively: the bot posts one line saying it is picking up where it left off, runs interrupted more than 24 hours ago are not auto-resumed (they are left resumable by the user), and a run whose in-flight step was a gated tool call re-parks the approval rather than assuming it.
- **Not included**: idempotency checks on already-completed *side effects*. Re-running only the in-flight step is what this change buys; proving that step is safe to retry is a separate problem, and the spec text is qualified accordingly rather than left promising more than the code does.

## Capabilities

### New Capabilities

_None — this makes two existing requirements true._

### Modified Capabilities

- `task-execution`: "Durable, resumable execution" restated in terms of the run log — what is checkpointed, what resumption actually restores, and the honest boundary on duplicate side effects. New requirement for the model-visible-means-logged invariant.

## Impact

- `app/src/lib/engine/runLog.ts` (new) — the append-only store, its persistence, and the reconstruction function (+ tests).
- `app/src/lib/engine/loop.ts` — `RunLoopDeps.runLog` and `resumeFrom`; recording at the existing tool-call choke point; seeding `messages` from recorded steps.
- `app/src/lib/engine/index.ts` — exports.
- `app/src/app/chatGlue.ts` — pass the real run log into `runLoop`; a `resumeInterruptedRuns` entry point.
- `app/src/app/bootstrap.ts` — hydrate the run log and resume what qualifies.
- No change to the audit log, the approvals pipeline, the policy layer, or the Rust host.
