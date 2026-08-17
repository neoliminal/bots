## Context

`runLoop(bot, threadHistory, deps)` builds one local array:

```ts
const messages: ChatMessage[] = [
  { role: "system", content: systemContent },
  ...threadHistory.map(...),
];
```

and then pushes assistant-with-tool_calls and tool-result messages into it as the run proceeds (`loop.ts:571`, `583`). Two of those three sources are already durable — the system prompt is recomposed deterministically from the bot and its memory, and `threadHistory` is derived from the persisted chat store by `threadHistoryFor`. Only the tool steps are ephemeral, and they are exactly the part a resumed run cannot re-derive.

Everything needed to fix this already has a shape to copy. `RunLoopDeps` takes an injected `audit?: AuditSink`; the engine's storage abstraction is already wired through `configureEngineStorage`; and tool execution already funnels through one `executeCall` choke point, so recording needs no new interception layer and no refactor of how tools run.

## Goals / Non-Goals

**Goals:**

- A run's completed steps survive the app dying, at the moment they complete.
- A resumed run re-enters with full context and repeats only the interrupted step.
- The invariant is enforced by a test, not by discipline.
- Resumption is legible to the user, not a bot that mysteriously starts working.

**Non-Goals:**

- Idempotency for side effects already performed by the in-flight step. This change makes resumption *possible* and *honest*; making a retried step provably safe is a different problem, and the delta spec says so rather than promising it.
- Persisting streamed deltas or partial assistant text. A run interrupted mid-stream resumes from its last completed step; half a sentence is not context worth restoring.
- Replacing the audit log. It answers "what did my bots do"; the run log answers "what was this run's context". Different lifetimes, different consumers, and merging them would compromise both.
- Cross-device sync of in-flight runs.

## Decisions

### 1. A separate store from the audit log

The audit log is a user-facing, summary-only, secret-free, capped record. The run log holds verbatim tool output — the actual bytes the model saw — which is none of those things. Merging them would either pollute the user's activity view with payloads or truncate the model's context. Two stores, two lifetimes: run-log entries are dropped when their run completes; audit entries persist for the user.

### 2. Keyed by run, cleared on completion

Entries key on a `runId` (already minted per run) with the `botId`/`threadId` alongside. A completed run drops its entries — the value of the log is entirely in the window between "step done" and "run done", so keeping it past that is storage cost for nothing. This also means the store stays small and needs no cap of its own.

*Alternative considered.* Keeping run logs indefinitely as a debugging aid. Rejected: verbatim tool output is the most sensitive material the app holds, and holding it forever to serve a hypothetical is the wrong default.

### 3. Recording at the existing choke point, not a new seam

`executeCall` is already where policy, approval and audit meet; the assistant-with-tool_calls message is appended in one place immediately before the call loop. Both recordings go exactly there. This deliberately does **not** introduce a generic pre/post-execute middleware chain: the seam that would justify one (multiple independent consumers) does not exist yet, and adding it now would be the framework instinct rather than the product need.

### 4. Resume seeds `messages`, it does not replay execution

`runLoop` gains `resumeFrom?: RunLogEntry[]`. Seeded entries are appended after the derived thread history in recorded order, and the loop then proceeds normally — meaning the model itself decides what to do next, seeing exactly what it saw before the interruption. No step-replay engine, no execution state machine: the recorded steps *are* the state.

### 5. Conservative, visible resumption at launch

Bootstrap hydrates the log and resumes runs that are (a) younger than 24 hours and (b) not blocked on an approval that was never answered. Each resumed run posts one line in its thread first. Three reasons this is deliberately timid: a bot that silently resumes work is indistinguishable from a bot that spontaneously started work; local shell now runs unasked, so resumed work has real effects; and a day-old task has usually been overtaken by events. Runs that don't qualify are left in the log, not discarded — the user's choice to revive them is a later change if it's wanted.

### 6. The invariant test is the point

A test reconstructs a run's messages from the thread store plus the run log and asserts equality with what the live run assembled. This is the mechanism DeepSeek's `deriveMessages()` design makes routine: it converts "did we remember to persist that?" from a code-review question into a failing test.

## Risks / Trade-offs

- **Verbatim tool output at rest** → bounded to in-flight runs and dropped on completion (decision 2); it lives in the same local storage as the thread history, which already holds model-visible content.
- **A poison run resumes forever** — a run whose in-flight step crashes the app would retry on every launch → resumption records an attempt count; a run that has already been resumed twice is left alone.
- **A resumed run surprises the user** → the thread line (decision 5) plus the 24-hour bound. Worth watching in practice; the conservative direction is the reversible one.
- **Storage growth from long-running runs** → entries are per-run and dropped at completion, so the ceiling is the concurrent in-flight work, not history.
- **The invariant test cements the current message shape** → that is the intent. A change to what the model sees should have to say so out loud.

## Migration Plan

Additive. No existing data to migrate; a fresh install has an empty run log and behaves exactly as today until a run is interrupted. Rollback is dropping the `runLog` dep — the loop's behavior without it is unchanged, which is also what keeps every existing test passing untouched.

## Open Questions

- Should a run that fails to qualify for auto-resume be surfaced to the user at all ("Scout didn't finish this yesterday — pick it up?"), or is silence the right answer for stale work? Leaning toward a later change rather than deciding it here.
- Does the delegation path (a run spawned by another bot) resume as its own run, or should resumption be the delegating bot's decision? Treated as its own run for now, since that is how it executes.

## Implementation Notes

Two things the work surfaced that the design did not anticipate:

**Dangling tool calls.** If the app dies *during* a call, the log ends with an assistant message whose `tool_calls` have no answering tool messages — a shape providers reject. `reconstructMessages` now emits a tool result for any unanswered call saying the step did not finish and its effect is unknown. Stating what happened is honest; inventing a plausible result would not be, and simply dropping the assistant entry would discard the sibling calls that did complete. This is exactly the class of bug the invariant was adopted to catch, and it surfaced within an hour of adopting it.

**The thread history was debounced; the run log was not** — since fixed here rather than deferred, because it made the invariant only half true. The chat store supplies the *conversation* half of a resumed run's context, and it wrote on a debounce that **reset on every change**: a Bot streaming for thirty seconds never wrote at all, so the exposure was not 250ms but the whole length of the reply. Settled messages — a sent user message, a finished reply, a timeline event — now write through immediately, while streaming deltas still debounce (half a sentence is not worth a write), and a max wait bounds the debounce so a talkative Bot cannot starve it. The e2e proves it: the interruption is now an abrupt reload with no flush window, and the run still resumes.
