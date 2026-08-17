# Notifications Specification

## Purpose

Always-on Bots generate a continuous stream of events; the user must see exactly what matters, when it matters, without being flooded. Notifications classify events by urgency, deliver through the right channel (native macOS notification, badge, in-app inbox, digest), respect focus/quiet hours, and always deep-link to the actionable object.

## Requirements

### Requirement: Urgency classification
Every user-facing event SHALL be classified: **blocking** (takeover/approval needed — a Bot is waiting), **notable** (task completed, handoff stalled, task failed), or **informational** (progress, act-and-report records). Classification determines channel and timing; blocking events SHALL never be batched into digests.

#### Scenario: Blocking beats digest
- **WHEN** a Bot requests a 2FA takeover during the user's digest-only quiet period
- **THEN** the takeover request is delivered immediately as a native notification (subject to the quiet-hours override rule), not held for the digest

### Requirement: Channel routing
Blocking events SHALL produce actionable native macOS notifications plus a persistent in-app badge until resolved. Notable events SHALL produce native notifications during active hours. Informational events SHALL appear only in the in-app activity feed and the daily digest.

#### Scenario: Completion notification
- **WHEN** an assigned task completes during active hours
- **THEN** a native notification announces it with a "View results" action, and the thread shows the completion message

#### Scenario: Progress stays quiet
- **WHEN** a Bot posts routine mid-task progress
- **THEN** no native notification fires; the update is visible in the thread and activity feed

### Requirement: Daily digest
The system SHALL deliver a configurable daily digest (default: user's morning) summarizing overnight and background activity: tasks completed, actions taken under act-and-report, exceptions, and anything awaiting the user.

#### Scenario: Morning digest
- **WHEN** the user's digest time arrives after an active night
- **THEN** one message summarizes completed work with links, lists pending approvals first, and contains no items already individually notified and resolved

### Requirement: Quiet hours and focus respect
The user SHALL be able to configure quiet hours during which notable notifications are held for the next active window. Blocking events during quiet hours SHALL be held by default but the user MAY mark specific Bots or workflows as allowed to break through. The app SHALL respect macOS Focus modes.

#### Scenario: Quiet-hours breakthrough
- **WHEN** the user enabled breakthrough for the "close deal" workflow and its Bot hits an approval at 11 PM
- **THEN** that notification is delivered despite quiet hours, while other Bots' events are held until morning

### Requirement: Unified pending inbox
The app SHALL provide a single "Waiting on you" inbox listing every unresolved blocking item (approvals, takeovers, stalled handoffs, questions) across all Bots, ordered by age/urgency, each resolvable directly from the list.

#### Scenario: Clearing the queue
- **WHEN** the user opens "Waiting on you" with three pending approvals and one takeover request
- **THEN** all four are listed with context, and resolving each removes it and unblocks the corresponding task immediately

### Requirement: Coordinator funnel integration
When funnel mode is enabled on an interface Bot (typically the Executive Assistant — see `multi-bot-collaboration`), notable and informational events from team Bots SHALL route to that Bot instead of notifying the user, appearing in the digest with its resolutions. Blocking events and security-relevant events SHALL bypass the funnel and notify the user directly, always.

#### Scenario: Funnel reduces noise, not safety
- **WHEN** funnel mode is active and a team Bot completes a task (notable) while another requests a payment approval (blocking)
- **THEN** the completion routes to the interface Bot and appears in the digest, while the payment approval notifies the user immediately and directly

### Requirement: Per-bot and per-category tuning
Notification behavior SHALL be tunable per Bot and per category (completions, failures, act-and-report records), with sensible defaults, without any setting being able to silence blocking security-relevant events (new login to Agent Computer, credential vault changes).

#### Scenario: Muting a chatty bot
- **WHEN** the user sets a Research Bot's completions to digest-only
- **THEN** that Bot's completion notifications stop, its blocking requests still notify immediately, and other Bots are unaffected
