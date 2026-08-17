# Routines Specification

## Purpose

Learn workflows by watching — once. Instead of building automations step-by-step, the user performs a multi-step process one time while a Bot follows along (across tools, on the Agent Computer or via screen share of the flow on the VM), and the Bot persists it as a named routine. Routines incorporate corrections, run on demand or on a schedule, and adapt to UI changes rather than breaking like brittle recorded macros.

## Requirements

### Requirement: Learn by demonstration
The user SHALL be able to start a "show the Bot" session on the Agent Computer, perform a multi-step process across one or more tools while optionally narrating, and end the session with the Bot producing a draft routine: a step-by-step understanding of intent (goals per step), not a pixel-coordinate macro.

#### Scenario: Demonstrating an invoice workflow
- **WHEN** the user demonstrates: open the invoices inbox → download attachment → enter fields into the ERP web app → file the email into a folder
- **THEN** the Bot produces a draft routine describing each step by intent ("extract vendor, amount, due date from the PDF; create ERP entry; archive email") for user review

#### Scenario: Narration enriches the routine
- **WHEN** the user says "if the amount is over $5,000, don't submit — flag it for me" during the demonstration
- **THEN** the drafted routine includes that condition as an approval gate

### Requirement: Review and correction loop
A drafted routine SHALL be presented as an editable, human-readable step list. The user SHALL be able to correct steps in plain language, and corrections made during or after early runs SHALL be incorporated permanently into the routine.

#### Scenario: Correcting after a trial run
- **WHEN** the first supervised run files an invoice under the wrong cost center and the user replies "utilities go to cost center 400"
- **THEN** the routine is updated and every subsequent run applies the correction

### Requirement: On-demand and scheduled runs
Routines SHALL be runnable on demand ("run the invoice routine"), on a schedule (cron-style with timezone, e.g., weekdays 7:00), or on a trigger event (new matching email arrives). Scheduled runs SHALL execute reliably whether or not the client is online.

#### Scenario: Scheduled morning run
- **WHEN** the invoice routine is scheduled for weekdays at 07:00 America/New_York
- **THEN** it runs at 07:00 local wall-clock (DST-correct), and the run summary is in the thread when the user starts their day

#### Scenario: Trigger-based run
- **WHEN** the routine is bound to "new email in the invoices label"
- **THEN** each matching arrival starts a run, with concurrent arrivals queued rather than raced

### Requirement: Intent-based resilience
Routine execution SHALL follow step intent, tolerating UI changes (moved buttons, renamed labels, changed layouts) by re-locating equivalent controls. A step that cannot be confidently completed SHALL pause the run for guidance rather than guessing on ambiguous state.

#### Scenario: Vendor portal redesign
- **WHEN** the ERP web app ships a redesign that relocates the entry form
- **THEN** the routine finds the equivalent form and completes the run, noting the adaptation in the run log

#### Scenario: Ambiguity pauses, not guesses
- **WHEN** a run encounters an invoice with two plausible vendor matches
- **THEN** the run pauses at that item, asks the user, remembers the answer, and continues with the rest

### Requirement: Per-run reporting and trust progression
Every run SHALL produce a run record (items processed, actions taken, exceptions, artifacts) attached to the routine's history. Routines SHALL start in supervised mode (each run's actions gated as approvals) and be promotable by the user to autonomous mode once trusted, with sensitive-step handling always governed by `human-handoff`.

#### Scenario: Promotion to autonomous
- **WHEN** after five clean supervised runs the user promotes the routine to autonomous
- **THEN** subsequent runs execute without per-run approval, still pausing for any sensitive steps, and post a concise per-run summary

### Requirement: Routines invocable by other Bots
A routine SHALL be invocable not only by the user and its schedule/triggers, but also by other Bots through transparent peer delegation (see `multi-bot-collaboration`) — a routine the owning Bot has mastered appears in its capability card, and teammates may invoke it subject to a per-routine setting (user-only / owning-Bot-only / any team Bot, default any team Bot). Bot-invoked runs SHALL execute under the routine's own trust level and gates, identically to a scheduled run, and record who invoked them.

#### Scenario: Teammate triggers a specialist's routine
- **WHEN** any Bot needs fresh invoice data and the Expense Bot's capability card shows an "ingest invoices" routine open to team invocation
- **THEN** the requesting Bot invokes it via delegation, the run executes on the Expense Bot with its normal gates and reporting, and the run record shows who invoked it

#### Scenario: Invocation permissions respected
- **WHEN** a Bot attempts to invoke a routine whose setting is user-only
- **THEN** the invocation is refused, the requesting Bot is told why, and no run starts

### Requirement: Routine management
The user SHALL be able to list, inspect, edit, duplicate, disable, and delete routines; reassign a routine to a different Bot; and see upcoming scheduled runs. Disabling takes effect immediately, including for queued triggers.

#### Scenario: Disabling a routine
- **WHEN** the user disables the invoice routine while three triggered runs are queued
- **THEN** the queued runs are cancelled, no further runs start, and the routine shows disabled with its history intact
