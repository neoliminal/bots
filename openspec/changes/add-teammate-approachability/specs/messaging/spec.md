# Messaging Specification (Delta)

## ADDED Requirements

### Requirement: Structured choice prompts
When a Bot offers the user a set of options, the thread SHALL render them as clickable choice chips rather than requiring the user to type an answer. Selecting a chip SHALL post the selection as a normal user message (visible in history and to the Bot), and free-text reply SHALL always remain available alongside the chips. Chips from superseded prompts SHALL become inert once answered.

#### Scenario: One-click option selection
- **WHEN** a Bot asks "How should I handle replies?" with three offered modes
- **THEN** the three modes render as clickable chips, tapping one posts it as the user's message, and the Bot proceeds on that answer

#### Scenario: Free text still wins
- **WHEN** the user types a custom answer instead of tapping a chip
- **THEN** the typed message is delivered normally and the chips for that prompt become inert

### Requirement: Inline draft actions
When a Bot presents an outward-facing draft (a reply, post, or send-ready artifact), the message SHALL carry inline action buttons — at minimum approve/send, edit, and discard — wired to the same approval flow as `human-handoff`. Acting on a draft from the thread SHALL be equivalent to acting on it from the approvals inbox.

#### Scenario: Approving a draft in-thread
- **WHEN** a Bot posts a drafted community reply with post/tweak/discard actions
- **THEN** tapping post approves and executes it through the normal approval flow, tapping tweak opens the draft for editing, and the outcome is recorded in the thread either way
