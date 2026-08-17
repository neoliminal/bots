# Proactive Work Specification (Delta)

## ADDED Requirements

### Requirement: Opt-in proactive mode
Proactive work discovery SHALL be off by default and enabled per Bot by an explicit user setting. A Bot with proactive mode off SHALL only act on user requests, routines, and delegations. Disabling proactive mode SHALL immediately stop discovery; drafts already produced remain available for review.

#### Scenario: Default is reactive
- **WHEN** a user creates a new Bot and never touches proactive settings
- **THEN** the Bot performs no unprompted work discovery

#### Scenario: Turning it off mid-flight
- **WHEN** the user disables proactive mode while the Bot is drafting an inferred deliverable
- **THEN** discovery stops, the in-progress draft is finished or parked as-is, and no new inferred work begins

### Requirement: Deliverable inference from connected context
A proactive Bot SHALL infer concrete, nameable deliverables (a draft reply, a document, a slide deck, a prepared checklist) from context the user has already connected — calendar entries, email threads, and workspace files — rather than generating busywork or generic briefings. Each inferred deliverable SHALL cite the signals that motivated it.

#### Scenario: Presentation inferred from calendar and email
- **WHEN** the user's calendar shows an upcoming presentation and their email contains a related thread
- **THEN** the Bot starts a draft deck in its workspace and, when surfacing it, cites the calendar entry and thread that motivated it

#### Scenario: No signal, no work
- **WHEN** the connected context contains nothing actionable
- **THEN** the Bot produces no deliverable and sends no "nothing to report" noise

### Requirement: Draft-only boundary
Proactive work SHALL always stop at a reviewable draft. A proactive Bot SHALL NOT send, post, publish, purchase, delete, or otherwise perform outward-facing or destructive actions on inferred work; completing any such action SHALL require the user's explicit go-ahead and SHALL respect `human-handoff` autonomy levels and `task-execution` safe-action boundaries.

#### Scenario: Email reply drafted, not sent
- **WHEN** the Bot infers that an incoming email needs a reply
- **THEN** it drafts the reply in the user's voice and presents it for review, and the email is not sent until the user approves

#### Scenario: Inferred work never widens permissions
- **WHEN** an inferred deliverable would require an action the Bot's autonomy level does not allow
- **THEN** the Bot prepares what it can as a draft and requests approval for the rest, exactly as it would for requested work

### Requirement: Quiet surfacing of proactive output
Proactive deliverables SHALL be surfaced through the `notifications` capability's urgency classification and digest, not as interruptions. A proactive draft SHALL appear in the Bot's thread with inline review actions, and undelivered drafts SHALL be discoverable later rather than lost.

#### Scenario: Draft lands in the digest
- **WHEN** the Bot completes an inferred draft during the user's quiet hours
- **THEN** the draft is queued and appears in the daily digest and the Bot's thread, with no immediate notification

### Requirement: Proactivity transparency and feedback
The user SHALL be able to see why any proactive deliverable was created (its motivating signals) and SHALL be able to reject it with feedback. Rejection SHALL be recorded so the Bot stops re-inferring the same class of unwanted work.

#### Scenario: Rejected inference is remembered
- **WHEN** the user dismisses an inferred deliverable with "don't draft replies to newsletters"
- **THEN** the Bot records the exclusion and stops producing that class of draft
