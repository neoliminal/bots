# Bot Management Specification

## Purpose

Bots are named, durable entities — not disposable sessions. Users create Bots with a role and job description, configure how they work, pause or retire them, and monitor their standing state. This capability covers the Bot lifecycle and configuration surface; what Bots remember is `bot-memory`, and where they run is `agent-computer`.

## Requirements

### Requirement: Bot creation with role definition
The system SHALL let a user create a Bot by giving it a name, an avatar, and a free-text role/job description (e.g., "Sales Outbound", "Expense Manager", "Executive Assistant"). Role templates SHALL be offered for common roles but never required. Creation SHALL complete in under 30 seconds with the Bot immediately messageable.

#### Scenario: Creating a Bot from scratch
- **WHEN** the user creates a Bot named "Scout" with the description "Research accounts overnight, score buying intent, hand top prospects to Sales Bot"
- **THEN** the Bot appears in the sidebar with its own thread and screen on the Agent Computer, and responds to its first message using the role description as standing context

#### Scenario: Creating from a template
- **WHEN** the user picks the "Support Triage" template
- **THEN** the Bot is pre-configured with that role description and suggested connectors, all editable before and after creation

### Requirement: Role description first guess
The creation form SHALL never start from a blank role description. The first guess SHALL default to a personal/executive-assistant role (a broadly useful generalist that helps with whatever the user needs). Second and subsequent suggestions SHALL be inferred from context: roles that complement the user's existing Bots (don't re-suggest a role already covered) and, as history accumulates, roles implied by what the user has actually been asking Bots to do. Suggestions are one-tap to accept and fully editable.

#### Scenario: First Bot defaults to assistant
- **WHEN** the user opens the creation form with no existing Bots
- **THEN** the role description is pre-filled with a personal-assistant role, with alternative role suggestions offered beneath it

#### Scenario: Suggestions complement the roster
- **WHEN** the user already has a Research Bot and an Executive Assistant and opens the creation form
- **THEN** the suggestions offer roles not yet covered (e.g., outreach, expenses, support triage) rather than duplicating existing ones

#### Scenario: Suggestions learn from usage
- **WHEN** the user's recent threads show repeated requests about invoice processing
- **THEN** an invoice/expenses role appears among the top suggestions for the next new Bot

### Requirement: Durable identity
A Bot's identity (name, role, memory, thread history, browser sessions, files) SHALL persist across VM restarts, app updates, and platform maintenance. Deleting a Bot SHALL be the only way its identity is destroyed.

#### Scenario: Platform maintenance
- **WHEN** the Agent Computer is migrated to a new host during maintenance
- **THEN** every Bot resumes with identical memory, logins, files, and in-flight task state

### Requirement: Bot configuration
The user SHALL be able to edit, at any time: the role description; standing instructions (tone, guardrails, escalation rules); the Bot's **tool policy** — which tools, tool groups, plugin (MCP) servers, and connectors/sites the Bot may see and use, enforced as visibility filtering per `tool-extensibility`; which authored skills are enabled for the Bot; its autonomy level (see `human-handoff`); and its working hours/schedule. Changes SHALL take effect for subsequent actions without recreating the Bot.

#### Scenario: Tightening autonomy
- **WHEN** the user changes a Bot's autonomy from "act, then report" to "propose, then wait for approval" for outbound email
- **THEN** the next email the Bot prepares is held as a draft pending approval instead of being sent

#### Scenario: Narrowing a Bot's tool policy
- **WHEN** the user removes shell access from a research Bot's tool policy
- **THEN** the Bot's next model request no longer offers any session-exec tool, and previously visible MCP tools outside the policy are likewise absent

### Requirement: Pause and resume
The user SHALL be able to pause a Bot (finish or checkpoint current work, take no new actions) and resume it later with full context intact. Pausing all Bots at once SHALL be available from the menu bar.

#### Scenario: Pausing a Bot
- **WHEN** the user pauses a Bot mid-task
- **THEN** the Bot checkpoints at the next safe boundary, its status shows "paused", it accepts (queues) but does not act on new messages, and resuming continues the task from the checkpoint

### Requirement: Bot roster limits and overview
The system SHALL support at least 8 concurrent Bots per Agent Computer (one screen each) and provide a roster view showing each Bot's status (idle, working, blocked-on-human, paused), current task, and last activity.

#### Scenario: Roster at a glance
- **WHEN** the user opens the roster view
- **THEN** each Bot shows status, current task title, and last-activity timestamp, and clicking a Bot opens its thread

### Requirement: Bot deletion
Deleting a Bot SHALL require explicit confirmation, stop all its activity immediately, revoke nothing shared (files and logins on the shared Agent Computer are preserved for other Bots), and permanently remove its memory and identity after a 30-day soft-delete window during which it can be restored.

#### Scenario: Soft delete and restore
- **WHEN** the user deletes a Bot and restores it 10 days later
- **THEN** the Bot returns with its full memory, thread history, and configuration intact

#### Scenario: Permanent deletion
- **WHEN** the 30-day window elapses without restore
- **THEN** the Bot's memory and identity are permanently destroyed and no longer restorable

### Requirement: First Bot's introduction covers compute location
When the first Bot is created (the roster was empty), its seeded introduction SHALL lead with the compute-location question before the starter-task card, phrased in the Bot's own voice as something it needs in order to work. Both cards SHALL be seeded locally with no model call, so onboarding completes before any API key exists. The compute question and its follow-ups SHALL be answered by the application itself — the user's selection posts as a normal user message and the Bot's reply is composed locally — and the starter-task card SHALL follow once the location is settled or skipped. Bots created when a roster already exists SHALL receive the starter-task card only.

#### Scenario: First bot asks where it works
- **WHEN** the user creates their first Bot
- **THEN** the thread opens with a greeting, a question card asking where the Bot should run commands, and no starter-task card until that question is answered or skipped

#### Scenario: Onboarding needs no API key
- **WHEN** the first Bot is created before any model API key is configured
- **THEN** the compute question, the host chips, the reachability verdict, and the starter-task card all appear without a model call

#### Scenario: Later bots skip the question
- **WHEN** the user creates a second Bot
- **THEN** its introduction contains only the greeting and starter-task card, and the compute location already chosen applies to it

#### Scenario: Starter tasks follow the choice
- **WHEN** the user answers the compute question by any path, including "Decide later"
- **THEN** the Bot posts its starter-task card next, so the first instruction is still one click away
