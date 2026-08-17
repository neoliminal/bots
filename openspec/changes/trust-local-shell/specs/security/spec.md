# Security Specification (Delta)

## MODIFIED Requirements

### Requirement: Comprehensive audit log
The platform SHALL keep an append-only, tenant-visible audit log covering: every external action taken by a Bot (connector call or computer-use step), every shell command or other tool call a Bot runs — including those that needed no approval — every human intervention, every configuration/autonomy change, every vault operation (excluding values), and every interactive session. Each entry SHALL record what ran, which Bot ran it (with its delegation chain), when, and the policy decision that let it run. Entries SHALL be retained at least 1 year and exportable. The log SHALL be readable in the app without exporting it: reachable from Settings, filterable by Bot, and ordered newest first. No entry SHALL contain secret material.

#### Scenario: Exporting for review
- **WHEN** the user exports the last 90 days of audit history
- **THEN** they receive a complete, timestamped record of Bot actions, interventions, and configuration changes with no secret material included

#### Scenario: Answering "what did it actually do?"
- **WHEN** a Bot has completed work autonomously and the user wants to see the individual commands afterwards
- **THEN** they open the activity log from Settings and read them there, filtered to that Bot, without exporting a file or opening a terminal

#### Scenario: Autonomous actions are not invisible actions
- **WHEN** a tool call runs under an "allow" policy with no approval prompt
- **THEN** it is still written to the audit log with its decision recorded as allowed, indistinguishable in completeness from a call the user approved
