# Bot Management Specification (Delta)

## ADDED Requirements

### Requirement: First Bot's introduction covers compute location
When the first Bot is created (the roster was empty), its seeded introduction SHALL lead with the compute-location question before the starter-task card, phrased in the Bot's own voice as something it needs in order to work. Both cards SHALL be seeded locally with no model call, so onboarding completes before any API key exists. The compute question and its follow-ups SHALL be answered by the application itself — the user's selection posts as a normal user message and the Bot's reply is composed locally — and the starter-task card SHALL follow once the location is settled or skipped. Bots created when a roster already exists SHALL receive the starter-task card only.

#### Scenario: First bot asks where it works
- **WHEN** the user creates their first Bot
- **THEN** the thread opens with a greeting, a question card asking where the Bot should run commands, and no starter-task card until that question is answered or skipped

#### Scenario: Onboarding needs no API key
- **WHEN** the first Bot is created before any model API key is configured
- **THEN** the compute question, the host chips, the reachability verdict, and the starter-task card all appear without a model call

#### Scenario: Later bots skip the question
- **WHEN** the user creates a second Bot
- **THEN** its introduction contains only the greeting and starter-task card, and the compute location already chosen applies to it

#### Scenario: Starter tasks follow the choice
- **WHEN** the user answers the compute question by any path, including "Decide later"
- **THEN** the Bot posts its starter-task card next, so the first instruction is still one click away
