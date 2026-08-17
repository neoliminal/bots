# Proposal: Build Routines (first slice)

## Why

The `routines` capability is fully specified but entirely unimplemented — the
DetailPanel shows a placeholder. It is the keystone gap in the roadmap: the
post-run self-correction loop (`add-teammate-approachability` group 4b) needs run
records to correct against, and proactive work discovery (group 5) needs a
scheduler rail to execute on. The category standard is "give your bot a
recurring job"; today Bots cannot hold one.

## What Changes

A first, local-first slice of the routines spec:

- **Engine `routines.ts`** — a persisted routines store (zustand, same
  pattern as `bots.ts`): routine definitions (name, owning bot, intent steps,
  schedule, enabled, trust mode) plus per-routine run records (status,
  summary, invoker, timestamps; capped history). Pure schedule math
  (`nextRunAt`, due detection) with an injected clock.
- **Run rail** — `runRoutineNow` in new `app/src/app/routineGlue.ts`,
  mirroring the delegation rail: a routine-run card in the owning bot's
  direct thread (live status → report), executed via `runLoop` on the bot's
  serial queue (concurrent fires queue rather than race), producing a run
  record either way.
- **Scheduler** — `startRoutineScheduler` (bootstrap-wired, injected timer):
  periodic tick fires due enabled routines; one catch-up run when a
  scheduled time was missed while the app was closed (marked late).
- **`save_routine` engine tool** — bots can persist a routine from
  conversation ("do this every weekday at 7"), the pillar-aligned creation
  path: the user asks once in chat instead of filling a form.
- **DetailPanel inspector** — the Routines section lists the bot's routines
  (schedule in words, next/last run), with Run now, enable/disable, and
  delete; run history on expand.

Out of scope for this slice (unchanged in the spec, future changes):
learn-by-demonstration capture, intent-resilient UI adaptation, external
event triggers (the trigger API lands, but nothing emits events yet),
offline/cloud scheduled execution, and bot-invoked routines via delegation.

## Impact

- Specs: `routines` (delta narrows scheduled-run reliability to
  client-running for this slice; adds the chat-creation requirement),
  `task-execution` (run records feed the thread).
- Code: `app/src/lib/engine/routines.ts` (+ index exports),
  `app/src/app/routineGlue.ts`, `app/src/app/bootstrap.ts`,
  `app/src/app/DetailPanel.tsx`, tool registration in glue.
- No changes to the OpenRouter client, sessions, or the Rust host.
