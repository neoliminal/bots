# Mobile Companion Specification (Delta)

## ADDED Requirements

### Requirement: Synced bot roster and threads
The mobile app SHALL present the user's full bot roster and complete conversation history, synced with the desktop: a message sent from either surface SHALL appear on the other, and thread state (unread counts, pending approvals) SHALL converge without user action.

#### Scenario: Conversation continuity
- **WHEN** the user messages a Bot from the Mac, then opens the phone app
- **THEN** the same thread appears with the full exchange, and a reply sent from the phone shows up on the Mac

### Requirement: Remote screen view and takeover
The mobile app SHALL provide live view of a Bot's Agent Computer screen and SHALL support explicit takeover with touch and keyboard input, honoring the same read-only-by-default and takeover rules as `live-view` and `human-handoff`. Ending takeover SHALL return control to the Bot with the intervention recorded.

#### Scenario: Login handled from the phone
- **WHEN** a Bot pauses at a login screen and the user opens the session on their phone
- **THEN** the user watches the live screen, takes control, types the credentials, releases control, and the Bot resumes — with the intervention in the audit trail

### Requirement: Approvals on the go
Pending approval requests SHALL be visible and actionable (approve, edit where applicable, deny) from the phone, using the same approval objects and audit trail as the desktop. Acting on either surface SHALL immediately resolve the request on both.

#### Scenario: Draft approved from the phone
- **WHEN** a Bot requests approval to send a drafted email while the user is away from their Mac
- **THEN** the user reviews and approves it from the phone, the Bot proceeds, and the desktop inbox no longer shows it pending

### Requirement: Push delivery per notification rules
The mobile app SHALL be a routable channel in the `notifications` capability: urgency classification, quiet hours, and digest rules apply unchanged, and a notification acted on from one surface SHALL clear on the other.

#### Scenario: Urgent only, when away
- **WHEN** the user is away from the desktop and a Bot raises an urgent approval alongside routine progress updates
- **THEN** the phone receives a push for the urgent item only, and the routine updates wait for the digest

### Requirement: Computer-optional continuity
For Bots running on cloud compute sessions, the mobile app SHALL remain fully functional — threads, approvals, live view, takeover — while the user's Mac is off. When a Bot's work is tethered to the local machine, the mobile app SHALL say so plainly rather than failing silently.

#### Scenario: Mac closed, work continues
- **WHEN** the user closes their Mac while a cloud-session Bot is mid-task
- **THEN** the Bot keeps working, and the phone shows live progress and can approve, message, and take over

#### Scenario: Local-only session is labeled
- **WHEN** the user opens a Bot whose session runs on the local provider and the Mac is off
- **THEN** the phone shows the session as unavailable-with-reason instead of an error or a stale view

### Requirement: Mobile surface security parity
The mobile app SHALL meet the same `security` requirements as the desktop: device-level authentication to open the app, encrypted transport and storage, no credentials in threads or logs, and the same tenant isolation. Loss of the phone SHALL be recoverable by revoking that device's access from another surface.

#### Scenario: Device revocation
- **WHEN** the user reports their phone lost and revokes it from the Mac
- **THEN** the phone's sessions are invalidated and it can no longer read threads or act on approvals
