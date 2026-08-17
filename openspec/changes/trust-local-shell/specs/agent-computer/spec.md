# Agent Computer Specification (Delta)

## MODIFIED Requirements

### Requirement: Isolation and hygiene
Sessions SHALL be isolated per user; session images SHALL contain no credentials, API keys, or tokens (secrets are injected per `security` at egress, never baked into images or session disks); every command executed in a session SHALL be recorded in the tenant-visible audit log (`security`, "Comprehensive audit log") at the moment it runs; and session network egress SHALL be subject to the same guards as other bot network tools. The conversation thread SHALL NOT carry per-command entries: it is reserved for the Bot's own account of its work, session lifecycle indicators, and warnings the user can act on (e.g. files that failed to sync back).

#### Scenario: Disposable means secret-free
- **WHEN** a session image is retained for warm restarts
- **THEN** it contains workspace files and installed packages only — inspection finds no credential material

#### Scenario: Every command is recorded, none of them interrupt
- **WHEN** a Bot runs six shell commands to complete a task
- **THEN** all six appear in the activity log with their timestamps and policy decisions, and the thread shows only the Bot's reply — no command lines

#### Scenario: Warnings still reach the thread
- **WHEN** sync-back cannot copy two modified files to the local workspace
- **THEN** the thread shows the warning naming those files, because it is something the user can act on
