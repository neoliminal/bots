# Routines Specification (Delta)

## ADDED Requirements

### Requirement: Post-run self-correction
After a run, the owning Bot MAY critique its own execution and propose an amendment to the routine's step list (e.g. "I couldn't reliably tell whether a post was already liked — add 'open the post before liking'"). Proposed amendments SHALL be presented as a diff of the human-readable steps with the observation that motivated them, and SHALL follow the routine's trust mode: applied only on user approval while supervised, applied-and-reported when autonomous. A routine SHALL never be silently rewritten, and every amendment (proposed, applied, rejected) SHALL appear in the routine's history.

#### Scenario: Supervised routine proposes a fix
- **WHEN** a supervised run exposes an ambiguity and the Bot proposes a step amendment
- **THEN** the user sees the step diff with the Bot's observation, and the routine changes only if the user approves

#### Scenario: Autonomous routine amends and reports
- **WHEN** an autonomous routine hits the same failure twice and the Bot amends a step to fix it
- **THEN** the amendment is applied, reported in the run summary with the diff, and revertible from the routine's history

#### Scenario: Amendments never widen scope
- **WHEN** a proposed amendment would add a new action category (e.g. from liking posts to also commenting)
- **THEN** it is treated as a routine change requiring user approval regardless of trust mode
