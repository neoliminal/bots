# Task Execution Specification (Delta)

## MODIFIED Requirements

### Requirement: Durable, resumable execution
Task state SHALL be checkpointed durably as the task proceeds — not at its end — such that app restarts, crashes, model-call failures, and platform deploys never lose the work already done. Each completed step of a run (an assistant message requesting tool calls, and each tool result answering one) SHALL be appended to a durable run log at the moment it completes. Interrupted tasks SHALL be resumable from that log with every completed step intact, so that resumption re-runs only the step that was in flight. Where a re-run step has already-completed side effects, the platform SHALL NOT claim to prevent duplication by itself: steps that are gated (`human-handoff`) SHALL re-park for approval rather than assume it, and the user SHALL be told the task is resuming rather than starting over.

#### Scenario: Resume after a crash mid-task
- **WHEN** the app quits while a Bot is six tool calls into a task
- **THEN** on restart the run is resumable with all six results still in its context, and only the seventh — the one in flight — runs again

#### Scenario: Resumption is visible, never silent
- **WHEN** an interrupted run resumes
- **THEN** the Bot says in the thread that it is picking up where it left off, so a user who sees new activity can tell it apart from work they just asked for

#### Scenario: A gated step does not inherit its old approval
- **WHEN** the interrupted step was a tool call awaiting the user's approval
- **THEN** resumption re-parks that approval rather than treating the earlier prompt as answered

#### Scenario: Stale work is not resurrected
- **WHEN** an interrupted run is older than 24 hours at launch
- **THEN** it is not resumed automatically, and its record remains available rather than being silently discarded

## ADDED Requirements

### Requirement: Model-visible means logged
Everything that reaches a model request SHALL be recoverable from durable storage: conversation history from the message store, and each run's tool steps from the run log. No model-visible input SHALL exist only in the memory of a run in progress. Reconstructing a run's model messages from durable state SHALL yield what the live run held, and introducing a new kind of model-visible input SHALL require a corresponding durable entry.

#### Scenario: Reconstruction matches the live run
- **WHEN** a run's model messages are rebuilt from the thread store and the run log
- **THEN** they match the messages the run assembled in memory, in the same order

#### Scenario: A new input type cannot skip the log
- **WHEN** a change adds a new kind of content to a model request without recording it durably
- **THEN** the reconstruction check fails, surfacing it before it ships

#### Scenario: A settled message is durable before anything else happens
- **WHEN** a user message is sent, a Bot reply finishes, or a timeline event is appended
- **THEN** it is written to durable storage immediately rather than waiting on a timer, so an abrupt kill cannot lose it

#### Scenario: A talkative Bot cannot starve the write
- **WHEN** a Bot streams a reply for longer than the write interval, with deltas arriving faster than the debounce
- **THEN** pending changes are still written within a bounded delay rather than waiting for the stream to end
