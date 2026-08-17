# Agent Computer Specification

## Purpose

Bots need OS access — a real shell, a real filesystem, installable tools — to do useful work beyond chat. The Agent Computer provides that as **on-demand compute sessions**, not an always-on cloud desktop: when a task needs OS-level tools, a lightweight VM spins up, executes the bot's tool calls, and syncs results back. The user's **local workspace is the source of truth for files** — modified files are copied back to the local machine after modifications and at mid-process checkpoints, so a session is always disposable. No connection is maintained overnight; a session that isn't working costs (approximately) nothing. Desktop-grade sessions (screens, persistent browser logins, live view/takeover) are a future extension layered on this same session model — see `live-view` and `human-handoff`.

## Requirements

### Requirement: On-demand session provisioning
The platform SHALL provision a compute session automatically on a bot's first OS-level tool call — no user setup per task. Warm starts (resuming a stopped session image) SHALL take ≤5 seconds; cold provisioning ≤60 seconds. The requesting tool call simply blocks until the session is ready; the bot and user need no awareness of session mechanics.

#### Scenario: Transparent spin-up
- **WHEN** a bot's task issues its first shell command and no session exists
- **THEN** a session provisions automatically, the command runs, and the only user-visible trace is the session indicator on the task timeline

#### Scenario: Warm restart
- **WHEN** a bot needs OS access 20 minutes after its previous session auto-stopped
- **THEN** the stopped image resumes in ≤5 seconds with previously installed packages intact

### Requirement: OS tool surface
Sessions SHALL expose, as ordinary bot tools: shell command execution, file read/write/list within the session workspace, package installation, and long-running processes (bounded by the session lifetime). These tools follow the same gating rules as all tools (`human-handoff`): reversible operations run per the bot's autonomy; destructive or gated operations require approval.

#### Scenario: Real OS work
- **WHEN** a task requires converting a batch of files with a CLI tool not installed locally
- **THEN** the bot installs the tool in its session, runs the conversion, and the outputs sync back — no local installation on the user's Mac

### Requirement: Local source of truth with continuous sync-back
The bot's local workspace (on the user's machine) SHALL be the durable home of files. Sessions are seeded from it (files uploaded at session start or on first access), and every file a session modifies SHALL be copied back to the local workspace **after each completed tool call that modified files and at checkpoints during long-running processes** — not only at task completion. The maximum unsynced window SHALL be bounded so a dying session never loses more than the work in flight.

#### Scenario: Mid-process sync
- **WHEN** a long-running session process writes intermediate outputs over 30 minutes
- **THEN** checkpoint syncs copy those files back to the local workspace as they stabilize, and the user can open partial results locally before the process finishes

#### Scenario: Session dies, files survive
- **WHEN** a session crashes mid-task
- **THEN** every file from completed tool calls is already in the local workspace; the task resumes on a fresh session re-seeded from local state, and only the in-flight step re-runs

### Requirement: Ephemeral by default
Sessions SHALL auto-stop after an idle timeout (default 10 minutes) and MAY be fully destroyed after a retention window; neither event loses data (files are already local). Nothing SHALL depend on a session surviving overnight or between tasks. Stopped session images MAY be retained for warm restarts where their storage cost is negligible, with total session spend visible in the usage view.

#### Scenario: Idle teardown is free of consequence
- **WHEN** a bot finishes its OS work and the session idles past the timeout
- **THEN** the session stops (billing drops to storage-only or zero), and the next task that needs OS access simply provisions again

#### Scenario: No overnight dependency
- **WHEN** the user's Mac sleeps overnight with no tasks running
- **THEN** no compute session remains running on their behalf, and nothing about the next morning's work depends on one having survived

### Requirement: Isolation and hygiene
Sessions SHALL be isolated per user; session images SHALL contain no credentials, API keys, or tokens (secrets are injected per `security` at egress, never baked into images or session disks); every command executed in a session SHALL be recorded in the task timeline; and session network egress SHALL be subject to the same guards as other bot network tools.

#### Scenario: Disposable means secret-free
- **WHEN** a session image is retained for warm restarts
- **THEN** it contains workspace files and installed packages only — inspection finds no credential material

### Requirement: Interruption tolerance
Task execution SHALL treat sessions as unreliable: a teardown, crash, or network drop mid-task pauses the affected step, provisions a replacement session, re-seeds from the local workspace, and resumes — with idempotency checks preventing duplicate side effects for already-completed steps (per `task-execution`).

#### Scenario: Seamless replacement
- **WHEN** the session provider has an outage mid-task
- **THEN** the task pauses at its last completed tool call, retries provisioning (or fails over to a second provider if configured), and resumes without user intervention — with the interruption noted on the timeline

### Requirement: Onboarding compute location choice
The compute provider SHALL be offered as a first-run choice inside the first Bot's thread, not only in Settings. The platform SHALL present the available locations — the user's Mac, a machine the user owns, and a cloud VM — as one-click options with a one-line plain-language consequence each (approval burden, persistence, cost), plus an explicit option to decide later. The user SHALL NOT be required to type anything to complete or skip this choice, and SHALL NOT be blocked from giving the Bot its first task by leaving it unanswered. Answering SHALL apply the choice to the session provider immediately and persist it, and the resulting state SHALL be identical to selecting the same provider in Settings, which remains the canonical place to change it later.

#### Scenario: First-run choice applies the provider
- **WHEN** the user clicks "This Mac" on the onboarding compute card
- **THEN** the local provider is selected and persisted exactly as the Settings radio would, and the thread shows the answer as a receipt

#### Scenario: Deciding later is free
- **WHEN** the user clicks "Decide later" or ignores the card entirely and types a task
- **THEN** the local default stays in effect, the Bot proceeds with the task, and the card is never re-shown as a blocker

#### Scenario: Choice is offered once
- **WHEN** the user creates a second Bot after the first Bot's onboarding
- **THEN** no compute-location card appears in the new Bot's thread

### Requirement: Guided personal-host setup during onboarding
When the user chooses a machine they own, the platform SHALL scan the local network for SSH hosts and offer each discovered host as a one-click chip that fills in the SSH target, with a free-text field available but never required. Selecting a chip SHALL save the target and immediately probe reachability, reporting a plain-language verdict in the thread. When no host is discovered, none is reachable, or a chosen provider is unconfigured, the platform SHALL state what is missing in one line and offer a one-click fallback to the local Mac rather than leaving an unusable provider selected.

#### Scenario: Discovered host in one click
- **WHEN** the network scan finds an SSH host and the user clicks its chip
- **THEN** the SSH target is saved, reachability is probed, and the thread reports that the host is reachable and will be used for this Bot's commands

#### Scenario: Unreachable host falls back
- **WHEN** the chosen host does not answer the reachability probe
- **THEN** the thread says so, states the one thing to fix (key-based SSH without a prompt), and offers a one-click "Use this Mac for now" that selects the local provider

#### Scenario: Cloud VM without a token
- **WHEN** the user chooses a cloud VM and no Fly API token is configured
- **THEN** the thread states the single setup step and offers the one-click local fallback, and the cloud provider is not left selected in a broken state
