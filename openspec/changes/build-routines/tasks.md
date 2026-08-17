# Tasks — Build Routines (first slice)

## 1. Engine

- [x] 1.1 `lib/engine/routines.ts`: Routine/RoutineRunRecord types, persisted
  zustand store (`engine.routines`, hydrate/CRUD/enable/toggle mode/delete,
  run-record append with 20-cap), schedule math (`describeSchedule`,
  `nextRunAt`, `isDue` with missed-slot semantics) — with tests
- [x] 1.2 `createRoutineScheduler` (pure tick, injected now/fire; stamps
  `lastFiredAt` before firing; late flag) — with tests
- [x] 1.3 `save_routine` engine tool factory + validation — with tests
- [x] 1.4 Export from `lib/engine/index.ts`

## 2. Integration

- [x] 2.1 `app/routineGlue.ts`: `runRoutineNow` (routine-run card → runLoop on
  serial queue → report + run record; error/cancel paths), `notifyTrigger`,
  scheduler start/stop — with tests
- [x] 2.2 Register `save_routine` in glue; wire scheduler in `bootstrap.ts`
  (idempotent)
- [x] 2.3 Chat rendering for the `routine-run` card kind (reuse
  delegation-card styling) — with test

## 3. UI

- [x] 3.1 DetailPanel Routines section: real rows (name, schedule words,
  next/last run), Run now / enable toggle / delete, run history expand,
  chat-first empty-state hint — with tests

## 4. Verification

- [x] 4.1 tsc + full suite green (952 unit, 18 e2e); walked delta scenarios

## 5. Notes

- Task 1.4 (engine exports) was missing despite §1 being committed — `routines.ts`
  existed but nothing was exported from `lib/engine/index.ts`, so the store, the
  scheduler and `save_routine` were unreachable outside the module. Added.
- `runRoutineNow` needed a run rail that isn't a user message. Rather than
  duplicate `deliverNow`, `chatGlue` gained one narrow export — `runBrief`
  (serial queue + model selection + usage accounting + the loop) — which
  routineGlue wraps with the card and the run record.
- `RoutineRunCard` is a sibling of `DelegationCard`, not a fork of it: same card
  language, its own words. `MessageMeta` gained `routineName` / `invokedBy`.
- The scheduler ticks once on start, so a slot missed while the app was closed
  fires at launch instead of waiting a full interval.
