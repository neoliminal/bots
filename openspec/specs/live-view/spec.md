# Live View Specification

## Purpose

Trust is built by visibility. The user can open the Agent Computer view at any time and watch any Bot's screen live — every click, keystroke, and navigation — from the Mac app. Live view is read-only by default and hands off to interactive control via `human-handoff`. Streaming uses the low-latency real-time transport defined in the project tech stack.

## Requirements

### Requirement: Live screen streaming
The app SHALL stream any Bot's screen on demand at up to 1080p/30fps with end-to-end latency under 500 ms on a typical broadband connection, degrading resolution/framerate gracefully under constrained bandwidth rather than stalling.

#### Scenario: Watching a working Bot
- **WHEN** the user clicks "Watch" on a Bot that is filling a CRM form
- **THEN** within 2 seconds the live screen appears, cursor movement and typing are visible in near-real-time, and closing the view has no effect on the Bot's work

#### Scenario: Constrained network
- **WHEN** the viewer's bandwidth drops below 2 Mbps
- **THEN** the stream reduces quality adaptively and remains continuous rather than freezing

### Requirement: Read-only by default
Live view SHALL be strictly observational: viewer input is not forwarded to the VM unless an explicit control handoff occurs (see `human-handoff`). The UI SHALL make the current mode (watching vs. controlling) unmistakable.

#### Scenario: Stray clicks do nothing
- **WHEN** the user clicks inside the live view while in watch mode
- **THEN** no input reaches the Agent Computer and a subtle hint indicates how to request control

### Requirement: Action annotation
While streaming, the app SHALL overlay a live action feed correlating what the Bot is doing with why (current task step), so the user can follow intent, not just pixels.

#### Scenario: Understanding the current step
- **WHEN** the user watches a Bot mid-task
- **THEN** a side panel shows the current task, the step in progress (e.g., "Updating close date on Acme opportunity"), and the last few completed steps

### Requirement: Multi-screen overview
The app SHALL provide a grid overview of all Bot screens (live thumbnails refreshing at ≥0.5 fps) so the user can monitor the whole team at a glance and click through to any full stream.

#### Scenario: Team monitoring
- **WHEN** the user opens the Agent Computer overview with four active Bots
- **THEN** four live thumbnails are shown with Bot name and current task, and clicking one opens its full live view

### Requirement: Session recordings
Key task segments (each significant computer-use step) SHALL be captured as screenshots and short recordings attached to the task timeline, retained per account policy, so work is reviewable after the fact without having watched live.

#### Scenario: After-the-fact review
- **WHEN** the user reviews an overnight task the next morning
- **THEN** the task timeline includes screenshots/clips of the significant UI actions taken

### Requirement: Privacy masking
When a screen displays a field the platform recognizes as sensitive (password inputs, card entry), the live stream and recordings SHALL mask that region; full-fidelity input for such steps happens only under user takeover, where the user is the one typing.

#### Scenario: Password field masked
- **WHEN** a login page with a password field is visible on a Bot's screen
- **THEN** viewers of the stream and recordings see the field region masked
