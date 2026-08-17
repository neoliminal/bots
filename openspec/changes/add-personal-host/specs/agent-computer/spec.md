# Agent Computer Specification (Delta)

## ADDED Requirements

### Requirement: Personal host sessions
The platform SHALL support a user-owned machine ("personal host") as a session provider, reached over SSH using the user's own key material (never passwords stored by the app). Each Bot SHALL get its own workspace directory under a single host root, the local workspace SHALL remain the source of truth with sync-back exactly as for other remote providers, and host sessions ARE persistent by design — the ephemeral-by-default rule applies to cloud sessions, and the settings UI SHALL state plainly that a personal host retains state between sessions.

#### Scenario: Pointing sessions at the mini-PC
- **WHEN** the user selects the personal-host provider and enters `user@minipc.local`
- **THEN** session tools run commands in that machine's per-bot workspace over SSH, files sync back to the local workspace, and no session state is destroyed when a session stops

#### Scenario: Unreachable host fails plainly
- **WHEN** the mini-PC is off or unreachable
- **THEN** session tools report the connection failure as a tool error (no silent hang, no fabricated results), and the session status shows the host as unavailable

### Requirement: Host provisioning package
The repo SHALL ship a self-contained provisioning package the user copies onto the personal host and runs once. Provisioning SHALL be idempotent, SHALL install only what the host features need (browse runtime, workspace/profile layout), and SHALL NOT open any network listener beyond the user's existing sshd (the browse daemon binds to localhost only).

#### Scenario: One-command setup
- **WHEN** the user copies `host/` to the mini-PC and runs `./provision.sh`
- **THEN** the script verifies prerequisites, creates the layout, installs the browser runtime, prints what it did, and can be re-run safely at any time

### Requirement: DOM-driven browsing tools
Bots on a personal host SHALL get browsing tools that drive a real Chromium via the DevTools protocol — navigate, read the page (title, URL, text, interactive elements), click by role/name, and fill fields by label — never by screenshot coordinates. Navigation and reading SHALL be category `read`; clicking and filling SHALL be category `external-comms` (approval-gated by default). Tool results SHALL be model-readable text descriptions of the resulting page state.

#### Scenario: Bot surfs for the user
- **WHEN** a Bot is asked to check a dashboard and summarize it
- **THEN** it navigates with `browse_goto`, extracts content with `browse_read`, and reports back — with any click/fill along the way passing the bot's policy gate

#### Scenario: No blind clicking
- **WHEN** a requested element cannot be found by role and accessible name
- **THEN** the click tool returns the available candidates as an error result instead of clicking something else

### Requirement: Persistent browser profile as shared login state
The host browser SHALL use one persistent profile per account so a site logged into once stays logged in for every Bot's browsing. Login and 2FA screens SHALL pause for the user per `human-handoff` — Bots never enter credentials. The user SHALL be able to clear the profile's stored state for a site (or entirely) from the app, and revoking a related grant SHOULD clear that integration's cookies.

#### Scenario: Log in once, every bot browses signed in
- **WHEN** the user completes a site login in the host browser during one Bot's task
- **THEN** any other Bot's later browsing on that site is already authenticated, with no credential ever passing through a Bot

#### Scenario: Signing out for real
- **WHEN** the user clears the profile state for a site from the app
- **THEN** subsequent browsing on that site is logged out for every Bot
