# Task Execution Specification (Delta)

## ADDED Requirements

### Requirement: Workspace-scoped work needs no per-action approval
Shell commands and file operations confined to a Bot's own workspace SHALL be treated as reversible in-scope work under "Safe-action boundaries" and SHALL proceed without asking the user, regardless of whether that workspace is on the user's Mac, a machine they own, or a disposable cloud VM. Approval SHALL NOT be requested merely because a command is a shell command. The sensitive-action floor is unaffected: permanent deletion, credential entry, payments, and external communications remain gated per `human-handoff`, cannot be loosened per Bot, and still pause even mid-command-sequence. A user who prefers to be asked SHALL be able to raise the rule for an individual Bot.

#### Scenario: Ordinary work runs uninterrupted
- **WHEN** a Bot converts a folder of files using a CLI tool in its workspace on the user's Mac
- **THEN** every command runs without prompting, and the user sees the finished result and the Bot's account of it

#### Scenario: The floor still holds
- **WHEN** that same command sequence reaches a step that would delete data outside the workspace, enter a credential, or send something externally
- **THEN** the Bot pauses for the user exactly as before, and the earlier autonomy grants it nothing here

#### Scenario: Location does not change the answer
- **WHEN** the same Bot doing the same task is moved between this Mac, a personal host, and a cloud VM
- **THEN** the number of approvals it asks for is identical, because the question is what the action does, not where it runs

#### Scenario: The user can still ask to be asked
- **WHEN** a user sets a Bot's shell rule to "Ask first"
- **THEN** that Bot resumes prompting before each command, and the platform default does not override the choice
