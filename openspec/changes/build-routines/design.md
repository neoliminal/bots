# Design: Build Routines (first slice)

## Data model (`app/src/lib/engine/routines.ts`)

```ts
interface RoutineSchedule {
  /** "manual" = on-demand only; "daily" fires at time on the listed days. */
  kind: "manual" | "daily";
  /** "HH:MM" 24h local wall-clock (daily only). */
  time?: string;
  /** Days 0(Sun)–6(Sat); absent = every day (daily only). */
  days?: number[];
}

interface RoutineRunRecord {
  id: string;
  status: "ok" | "error" | "cancelled";
  summary: string;             // report text or error message
  invokedBy: "user" | "schedule" | "trigger";
  late?: boolean;              // catch-up run for a missed slot
  startedAt: number;
  finishedAt?: number;
}

interface Routine {
  id: string;
  botId: string;
  name: string;
  steps: string[];             // human-readable intent steps
  schedule: RoutineSchedule;
  enabled: boolean;
  mode: "supervised" | "autonomous";   // trust progression (display + prompt)
  createdAt: number;
  lastFiredAt?: number;        // slot bookkeeping for missed-run catch-up
  runs: RoutineRunRecord[];    // newest first, capped at RUN_HISTORY_LIMIT (20)
}
```

Store: zustand + `StorageLike` persistence at `engine.routines`, hydrate/CRUD
mirroring `bots.ts`. `listRoutines(botId?)` excludes nothing (no soft delete —
routines delete hard; history dies with the routine, per spec "delete").

## Schedule math (pure, injected clock)

- `describeSchedule(s)` → "every day at 8:00 AM", "weekdays at 7:00", "on demand".
- `nextRunAt(s, from)` → next timestamp ≥ `from` matching time+days (local
  time; DST-correct because computed via `Date` fields, not offsets). Manual → undefined.
- `isDue(routine, now)`: enabled, daily, and the most recent slot ≤ now is
  after `lastFiredAt`. Missed-while-closed slots therefore read as due on next
  tick → exactly one catch-up run, flagged `late` when the slot is >5 min old.

## Run rail (`app/src/app/routineGlue.ts`)

`runRoutineNow(routineId, invokedBy)` mirrors `runDelegatedNow`:

1. Post a `kind: "routine-run"` card (status "in-progress", routine name) in
   the owning bot's direct thread.
2. `startRun(botId, threadId, runId, ...)` — the bot's serial queue, so
   concurrent fires queue rather than race, and Stop/pause cancels normally.
3. Brief: routine name + numbered steps + mode framing (supervised: "the user
   is still validating this routine — prefer asking approval for anything
   external"; autonomous: act within normal gates). Category policy and hard
   floors apply regardless — mode never weakens `human-handoff`.
4. On settle: patch the card (done/failed + report) and append the run record
   (`ok`/`error`/`cancelled` via AbortError), stamp `lastFiredAt` for
   schedule/trigger invocations.

`notifyTrigger(routineId)` = `runRoutineNow(id, "trigger")` — the rail future
integrations call; nothing emits events in this slice.

## Scheduler

`createRoutineScheduler({ list, fire, now })` (engine, pure) exposes
`tick()`; glue wires a 30s interval started from `bootstrap.ts` after
hydration (idempotent, cleared on re-bootstrap). Each tick: for each due
routine, stamp `lastFiredAt` (before the async run — no double-fire) and
fire. Client-closed reliability is explicitly out of scope (local-first
slice); the delta narrows the spec scenario accordingly.

## `save_routine` tool

Engine tool (registered in glue like `contact_bot`): args `name`,
`steps: string[]`, `schedule` (`kind`/`time`/`days`), validated (name
non-empty, time HH:MM, days 0–6). Creates the routine for the calling bot,
enabled + supervised, and returns a confirmation naming the schedule in
words. Category: local state mutation — no approval gate (creating a routine
performs no external action; its runs are gated normally).

## DetailPanel inspector

Replace the placeholder list with real rows (name, `describeSchedule`, next
run / last run status dot), per-row actions: Run now, Enable/disable toggle,
Delete (confirm), expandable run history (last 5, status + summary first
line + relative time). Empty state keeps the current teaching copy. No
creation form — creation flows through chat (`save_routine`), per the
typing-minimization pillar; the section hints "Ask {bot} to do something on
a schedule".

## Testing

- `routines.test.ts`: schedule math (DST-safe day boundaries, days mask,
  missed-slot due-once), store CRUD/persistence/history cap, scheduler
  single-fire per slot.
- `routineGlue.test.ts`: run rail posts card → report + run record; failure
  and abort paths; disable cancels nothing mid-run but blocks future fires.
- `DetailPanel.test.tsx`: rows render, Run now calls the rail, toggle
  persists.
- Tool test in engine: `save_routine` validation + creation.
