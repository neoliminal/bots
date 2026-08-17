# Agent Computer Specification (Delta)

## ADDED Requirements

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
