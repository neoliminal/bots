# Human Handoff Specification

## Purpose

Bots pause and involve the human for exactly the steps that need a human: credentials, 2FA, CAPTCHAs, payment confirmations, and any action the user's autonomy settings gate. The user completes the single sensitive step — by taking live control of the Bot's screen or by an approval action — then hands back, and the Bot continues. Secrets are never pasted into chat. This capability is the enforcement point for the platform's sensitive-action invariant.

## Requirements

### Requirement: Automatic pause on sensitive steps
A Bot SHALL detect sensitive steps — credential entry, 2FA prompts, CAPTCHAs, payment confirmation, and any action matching the user's configured gates — and pause before acting, requesting human involvement instead of attempting the step itself.

#### Scenario: 2FA encountered mid-task
- **WHEN** a site the Bot is working in demands a 2FA code
- **THEN** the Bot pauses, holds the page state, and sends a takeover request identifying the site and step; it never asks for the code in chat

#### Scenario: CAPTCHA encountered
- **WHEN** a CAPTCHA challenge appears
- **THEN** the Bot pauses and requests takeover rather than attempting to solve it

### Requirement: Live takeover
The takeover request SHALL open the Bot's screen with interactive control transferred to the user (keyboard/mouse forwarded over the live view). While the user has control, the Bot SHALL observe page state changes but take no actions and record no keystrokes. Handing back control SHALL resume the task within 5 seconds.

#### Scenario: Completing a login
- **WHEN** the user accepts a takeover request, types their password and 2FA code directly into the page, and clicks "Hand back"
- **THEN** the credentials were entered only on the Agent Computer's page (never in chat or logs), keystrokes during takeover are excluded from recordings, and the Bot resumes the task from the now-authenticated state

#### Scenario: Takeover from the phone-free path
- **WHEN** a takeover request arrives while the user is at their Mac
- **THEN** the notification's "Take over" action opens the interactive view in one click

### Requirement: Approval requests
For gated-but-not-interactive actions (send this email, submit this payment, delete these records), the Bot SHALL present an approval card showing exactly what will happen (recipients, amounts, affected records, diffs where applicable) with Approve / Edit / Deny actions. Deny SHALL include an optional reason the Bot incorporates.

#### Scenario: Approving outbound email
- **WHEN** a Bot requests approval to send 12 outreach emails
- **THEN** the approval card lists all recipients and shows each draft, the user can edit any draft in place, and approving sends exactly what was shown

#### Scenario: Denial with guidance
- **WHEN** the user denies with "tone is too pushy for these two accounts"
- **THEN** the Bot revises those drafts and re-requests approval for them only

### Requirement: Configurable autonomy levels
Per Bot and per action-category, the user SHALL be able to set autonomy: **always ask** (approval required), **act and report** (do it, notify after), or **fully autonomous** (do it silently). Credentials, payments, and irreversible bulk deletions SHALL be non-configurable "always ask / always takeover".

#### Scenario: Granting send authority
- **WHEN** the user sets "sending follow-up emails to existing threads" to act-and-report for their Sales Bot
- **THEN** such emails send without approval and appear in an activity digest, while cold outreach still requires approval

#### Scenario: Hard floor cannot be disabled
- **WHEN** the user attempts to set payment confirmation to fully autonomous
- **THEN** the setting is refused with an explanation that payment steps always require a human

### Requirement: Pending-request lifecycle
Requests awaiting a human SHALL not block other work: the Bot parks the blocked task and proceeds with other queued work. Requests SHALL escalate through the `notifications` capability, remain actionable for a configurable window, and expire safely (task paused, nothing acted) if unanswered.

#### Scenario: Unanswered request
- **WHEN** an approval request goes unanswered for its 24-hour window
- **THEN** the task remains safely paused, the request is marked expired in the thread, and the Bot re-raises it with the user's next interaction

### Requirement: Complete intervention audit
Every takeover and approval SHALL be recorded: who acted, when, what was requested, what was approved/denied/edited — excluding secret values themselves. The record SHALL appear in the task timeline.

#### Scenario: Reviewing interventions
- **WHEN** the user reviews a task that included a takeover and two approvals
- **THEN** the timeline shows each intervention with timestamp and outcome, with no credential material present anywhere
