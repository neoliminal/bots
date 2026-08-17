# Bot Management Specification (Delta)

## MODIFIED Requirements

### Requirement: Bot configuration
The user SHALL be able to edit, at any time: the role description; standing instructions (tone, guardrails, escalation rules); the Bot's **tool policy** — which tools, tool groups, plugin (MCP) servers, and connectors/sites the Bot may see and use, enforced as visibility filtering per `tool-extensibility`; which authored skills are enabled for the Bot; its autonomy level (see `human-handoff`); and its working hours/schedule. Changes SHALL take effect for subsequent actions without recreating the Bot.

#### Scenario: Tightening autonomy
- **WHEN** the user changes a Bot's autonomy from "act, then report" to "propose, then wait for approval" for outbound email
- **THEN** the next email the Bot prepares is held as a draft pending approval instead of being sent

#### Scenario: Narrowing a Bot's tool policy
- **WHEN** the user removes shell access from a research Bot's tool policy
- **THEN** the Bot's next model request no longer offers any session-exec tool, and previously visible MCP tools outside the policy are likewise absent
