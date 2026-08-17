# Task Execution Specification (Delta)

## ADDED Requirements

### Requirement: Execution preference order — CLI first, connectors second, computer use last
For each step, the Bot SHALL choose its execution path in this order: (1) an **installed CLI tool in a compute session** when one can do the job (installing a well-known CLI on demand counts, per `agent-computer`); (2) an **official connector/MCP integration** when one is configured, for services without a usable CLI; (3) **computer use** on the real application UI as the last resort. A UI change that breaks a computer-use flow SHALL be handled by adaptive re-navigation, not a hard failure. The chosen path SHALL be recorded on the task timeline, and all three paths carry the same audit record.

#### Scenario: CLI available
- **WHEN** a Bot must open a pull request and the `gh` CLI is installed (or installable) in its session
- **THEN** the Bot uses `gh` in the session rather than a GitHub MCP tool, and the timeline records the CLI path

#### Scenario: No usable CLI, connector configured
- **WHEN** a Bot must create a ticket in a helpdesk that has no CLI but has a configured connector
- **THEN** the ticket is created via the connector API, with the same audit record as any UI action

#### Scenario: No API exists
- **WHEN** a Bot must submit data into a legacy internal web portal with no CLI and no API
- **THEN** the Bot completes the form through the browser on its own screen — navigating, typing, and clicking as a trained human would

#### Scenario: UI changed since last run
- **WHEN** a site has moved a button the Bot's previous runs used
- **THEN** the Bot locates the equivalent control by inspecting the current UI and completes the step, noting the change in the task log

## REMOVED Requirements

### Requirement: Hybrid execution — connectors first, computer use everywhere else
**Reason**: Superseded by the three-step execution preference order above, which inserts CLI tools in compute sessions ahead of connectors/MCP (CLI-first philosophy) while preserving the connector and computer-use behavior and scenarios.
**Migration**: Behavior for connector-vs-computer-use decisions is unchanged; steps that a CLI can perform now route to the compute session first. No data or configuration migration required.
