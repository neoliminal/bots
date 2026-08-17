# Messaging Specification

## Purpose

Messaging is the primary interface to Bots: users brief, steer, and review work by chatting with Bots the way they would with human teammates. There is deliberately no automation builder or special syntax. Messaging covers direct threads (user ↔ Bot), optional group threads, attachments, and reliable delivery to always-on Bots. Bot collaboration does NOT require group threads — delegation happens transparently and renders inline in the originating thread (see `multi-bot-collaboration`); group threads are an optional view for when the user wants a standing conversation with several Bots at once.

## Requirements

### Requirement: Direct message threads with Bots
The system SHALL provide persistent, per-Bot direct message threads in which the user assigns work, asks questions, and receives results. Thread history SHALL be retained indefinitely (subject to account retention settings) and be searchable.

#### Scenario: Assigning work by message
- **WHEN** the user sends "Research the top 20 accounts in our pipeline and draft outreach for the 5 hottest" to a Sales Bot
- **THEN** the Bot acknowledges in-thread, begins a task (see `task-execution`), and posts progress and results back into the same thread

#### Scenario: History search
- **WHEN** the user searches for a phrase used in a conversation three weeks ago
- **THEN** matching messages are returned with thread context and can be jumped to in place

### Requirement: Group threads
The system SHALL support optional group threads containing the user and multiple Bots, for standing multi-Bot conversations the user chooses to have. Bots in a group thread SHALL be able to read the shared context, address each other, and pass work between themselves without the user relaying messages. Group threads are never required for Bot collaboration — transparent delegation (see `multi-bot-collaboration`) works from any thread.

#### Scenario: Multi-bot group thread
- **WHEN** the user creates a thread with a Research Bot and a Sales Bot and asks for scored leads plus draft outreach
- **THEN** the Research Bot posts scored contacts, the Sales Bot picks them up from the same thread and posts drafts, and the user sees the full exchange in one place

### Requirement: Rich messages and attachments
Messages SHALL support formatted text (Markdown), file attachments up to 100 MB, images with inline preview, and links to platform objects (tasks, routines, approvals, files on the Agent Computer) that render as actionable cards.

#### Scenario: Bot delivers a file
- **WHEN** a Bot produces a spreadsheet on the Agent Computer and shares it in-thread
- **THEN** the message shows a file card with name/size/preview, and the user can download it or open its location on the Agent Computer

### Requirement: Reliable delivery to always-on Bots
Messages sent to a Bot SHALL be durably queued server-side and processed in order, regardless of whether the Bot is idle, mid-task, or its VM is restarting. The user SHALL see per-message states: pending (local outbox), delivered, seen-by-Bot.

#### Scenario: Message during VM restart
- **WHEN** the user messages a Bot while its Agent Computer is recovering from a restart
- **THEN** the message is queued, marked delivered, and processed by the Bot as soon as it resumes, in the order sent

#### Scenario: Steering mid-task
- **WHEN** the user sends a correction while the Bot is mid-task ("actually exclude EU accounts")
- **THEN** the Bot incorporates the correction into the running task rather than starting over, and confirms the adjustment in-thread

### Requirement: Progress updates without noise
Bots SHALL post concise progress updates at meaningful milestones (started, key findings, blocked, done) rather than narrating every step. Long-running tasks SHALL update a single collapsible progress message rather than flooding the thread.

#### Scenario: Overnight task reporting
- **WHEN** a Bot runs a 6-hour overnight research task
- **THEN** the thread contains a start acknowledgment, a periodically-updated progress card, and one final summary message with the deliverables — not dozens of individual updates

### Requirement: Interruption and cancellation
The user SHALL be able to tell a Bot to pause, stop, or discard a running task via natural-language message or an explicit control on the task card, taking effect at the next safe boundary.

#### Scenario: Stop command
- **WHEN** the user replies "stop — wrong list, I'll re-brief you" during a running task
- **THEN** the Bot halts at a safe point, confirms what was and wasn't done, and takes no further actions for that task
