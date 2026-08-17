# Bot Management Specification (Delta)

## ADDED Requirements

### Requirement: Bot introduction with starter options
A newly created Bot's thread SHALL open with an introduction seeded locally at creation time (no model call): a short greeting naming the Bot and its role, plus a structured choice prompt of starter tasks derived from the Bot's role. Answering — by option click or typed text — SHALL flow through the normal message path so the Bot's first model turn responds to a concrete instruction. The user SHALL never face an empty thread with no indication of what the Bot can do.

#### Scenario: New bot greets with starter tasks
- **WHEN** the user creates a bot from the Research role
- **THEN** its thread opens with a greeting and a question card of research starter tasks, and clicking one sends it as the user's first message

#### Scenario: Custom role still gets options
- **WHEN** the user creates a bot with a hand-written role description matching no library role
- **THEN** the introduction still offers generic starter options (e.g. "Tell me what you can do") rather than an open-ended question

#### Scenario: Works offline and keyless
- **WHEN** a bot is created before any API key is configured
- **THEN** the introduction and card still appear instantly; only answering triggers a model call
