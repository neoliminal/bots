# Task Execution Specification

## Purpose

Bots take work from start to finish. Given an assignment by message, a Bot plans, executes across tools — using official connectors/MCP where they exist and real computer use (mouse, keyboard, navigation on its screen) everywhere else — handles intermediate steps, and returns only when the work is complete or genuinely needs human judgment. The deliverable lands inside the actual system of record: the draft is in the email account's Drafts folder, the CRM row is updated, the ticket is filed. Execution is durable: tasks survive restarts and continue 24/7.

## Requirements

### Requirement: End-to-end task ownership
A Bot receiving an assignment SHALL derive a plan, execute all steps it is authorized for, and return to the user only when (a) the work is complete and ready for review, or (b) a step requires human judgment, approval, or a sensitive action. Bots SHALL NOT return partial work with "next steps for you" when they are capable and authorized to do those steps.

#### Scenario: Complete outcome in the system of record
- **WHEN** the user asks a Sales Bot to "draft follow-ups for everyone who replied this week, in my voice"
- **THEN** the finished drafts exist in the Drafts folder of the user's email account (not as chat text), and the Bot's completion message links to each draft

#### Scenario: Returning only for judgment
- **WHEN** a task requires choosing between two materially different discount structures
- **THEN** the Bot pauses at that decision, presents both options with its recommendation, and continues immediately once the user picks

### Requirement: Execution preference order — CLI first, connectors second, computer use last
For each step, the Bot SHALL choose its execution path in this order: (1) an **installed CLI tool in a compute session** when one can do the job (installing a well-known CLI on demand counts, per `agent-computer`); (2) an **official connector/MCP integration** when one is configured, for services without a usable CLI; (3) **computer use** on the real application UI as the last resort. A UI change that breaks a computer-use flow SHALL be handled by adaptive re-navigation, not a hard failure. The chosen path SHALL be recorded on the task timeline, and all three paths carry the same audit record.

#### Scenario: CLI available
- **WHEN** a Bot must open a pull request and the `gh` CLI is installed (or installable) in its session
- **THEN** the Bot uses `gh` in the session rather than a GitHub MCP tool, and the timeline records the CLI path

#### Scenario: No usable CLI, connector configured
- **WHEN** a Bot must create a ticket in a helpdesk that has no CLI but has a configured connector
- **THEN** the ticket is created via the connector API, with the same audit record as any UI action

#### Scenario: No API exists
- **WHEN** a Bot must submit data into a legacy internal web portal with no CLI and no API
- **THEN** the Bot completes the form through the browser on its own screen — navigating, typing, and clicking as a trained human would

#### Scenario: UI changed since last run
- **WHEN** a site has moved a button the Bot's previous runs used
- **THEN** the Bot locates the equivalent control by inspecting the current UI and completes the step, noting the change in the task log

### Requirement: Durable, resumable execution
Task state SHALL be checkpointed durably (via the orchestration layer) such that VM restarts, model-call failures, and platform deploys never lose a task. Interrupted tasks SHALL resume from the last checkpoint automatically.

#### Scenario: Resume after crash
- **WHEN** a VM crashes 40 minutes into a 60-minute task
- **THEN** after recovery the task resumes from its last checkpoint rather than restarting, and duplicate side effects are prevented by idempotency checks on already-completed steps

### Requirement: Continuity without persistent connections
Tasks SHALL NOT depend on any persistent cloud connection or long-lived compute session: work is checkpointed against local state (see `agent-computer` sync-back), compute sessions are provisioned and discarded as needed, and a task interrupted by session teardown resumes from its last checkpoint. Recurring work (morning briefings, queue triage) SHALL be supported via schedules (see `routines`), executing whenever the orchestrating app is running.

#### Scenario: Long task across disposable sessions
- **WHEN** a multi-hour task spans three compute sessions (two idle-stopped between phases)
- **THEN** the task completes correctly, each session picking up from locally-synced state, with no dependency on any one session surviving

#### Scenario: Scheduled morning run
- **WHEN** a routine is scheduled for 07:00 and the app is running at that time
- **THEN** the run executes on a freshly provisioned session as needed and the briefing is in the thread — no compute was held overnight waiting for it

### Requirement: Safe-action boundaries
The Bot SHALL classify actions by reversibility. Reversible, in-scope actions proceed autonomously per the Bot's autonomy setting; sensitive or hard-to-reverse actions (sending external communications, payments, deletions, credential entry) SHALL follow the `human-handoff` capability's approval/takeover rules — this is a platform invariant.

#### Scenario: Send is gated, drafting is not
- **WHEN** a Bot with default autonomy finishes composing outreach emails
- **THEN** the emails are placed in Drafts autonomously, and actually sending them requires the user's approval unless the user has granted send authority for this workflow

### Requirement: Verifiable task record
Every task SHALL maintain a timeline: plan, each significant action (with screenshots for computer-use steps), connector calls, checkpoints, human interventions, and final outcome. The record SHALL be reviewable in the app and retained per account policy.

#### Scenario: Reviewing what happened
- **WHEN** the user opens a completed task's detail view
- **THEN** they see the step timeline with screenshots of key UI actions, every system touched, and links to the produced artifacts

### Requirement: Failure reporting without silent abandonment
When a Bot cannot complete a task (blocked site, missing access, ambiguous data), it SHALL report what was completed, what is blocked and why, and what it needs — never silently dropping work or fabricating completion.

#### Scenario: Blocked on access
- **WHEN** a Bot's work requires a tool the Agent Computer is not signed into
- **THEN** the Bot completes independent steps, then reports the specific blocker and requests a login session (via `human-handoff`), resuming automatically once granted
