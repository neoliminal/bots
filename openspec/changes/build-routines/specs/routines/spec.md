# Routines — Delta for build-routines

## ADDED Requirements

### Requirement: Routine creation from conversation

A Bot SHALL be able to persist a routine directly from chat via a
`save_routine` tool (name, intent steps, schedule) when the user asks for
recurring or repeatable work, so creating a routine never requires a form.
New routines start enabled and in supervised mode. Saving a routine SHALL
require no approval gate (it performs no external action); the routine's
runs are gated normally.

#### Scenario: "Do this every morning" saves a routine

- **WHEN** the user tells a Bot "summarize my inbox every weekday at 7:00"
- **THEN** the Bot saves a routine with those steps and schedule and confirms
  in words ("Saved — weekdays at 7:00 AM, supervised"), with no form or
  approval interstitial

#### Scenario: Invalid schedule is rejected at the tool boundary

- **WHEN** a Bot calls `save_routine` with a malformed time or day set
- **THEN** the tool errors with a correctable message and no routine is
  created

### Requirement: Routine run visibility in the thread

Every routine run SHALL appear as a run card in the owning Bot's direct
thread — live status while running, then the report or failure — and SHALL
append a run record (status, summary, invoker, timestamps) to the routine's
history. Run history SHALL be retained for at least the most recent 20 runs
per routine.

#### Scenario: Scheduled run leaves a card and a record

- **WHEN** a scheduled run completes
- **THEN** the thread shows a routine-run card with the report, and the
  routine's history shows a record with status, summary, and `invokedBy:
  "schedule"`

## MODIFIED Requirements

### Requirement: On-demand and scheduled runs

Routines SHALL be runnable on demand ("run the invoice routine"), on a
schedule (daily/weekday times in the user's local timezone), or on a trigger
event via a `notifyTrigger` rail (event sources land in later changes).
While the app is running, scheduled runs SHALL fire at the scheduled
wall-clock time (DST-correct). A scheduled slot missed while the app was
closed SHALL produce exactly one catch-up run on next launch, marked late.
Concurrent fires for the same Bot SHALL queue on the Bot's serial run queue
rather than race. (Client-offline cloud execution remains the long-term
requirement and is deferred to a mobile/cloud change.)

#### Scenario: Scheduled morning run

- **WHEN** the invoice routine is scheduled for weekdays at 07:00 local time
  and the app is running
- **THEN** it runs at 07:00 local wall-clock (DST-correct), and the run
  summary is in the thread when the user starts their day

#### Scenario: Missed slot catches up once

- **WHEN** the app was closed over a routine's 07:00 slot and opens at 09:30
- **THEN** exactly one run fires promptly, its record marked late, and the
  next fire is the following scheduled slot

#### Scenario: Trigger-based run

- **WHEN** `notifyTrigger` is invoked for a routine bound to an event
- **THEN** a run starts with `invokedBy: "trigger"`, with concurrent
  invocations queued rather than raced
