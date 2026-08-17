# Bot Memory Specification

## Purpose

Context compounds. A Bot keeps long-term memory across days and weeks — conversation context, project state, user preferences, voice and tone, edge cases, and decision patterns — so the user re-explains less over time and the Bot starts anticipating. This is the opposite of session-reset agents. Memory is implemented as a per-Bot memory store (file-based memory surface exposed to the model via the memory tool, backed by versioned platform storage), plus automatic context management for long sessions.

## Requirements

### Requirement: Persistent long-term memory
Each Bot SHALL maintain a durable memory store that survives sessions, VM restarts, and model upgrades. The Bot SHALL consult memory at the start of relevant work and write new learnings (corrections, preferences, confirmed approaches, project state) as it works.

#### Scenario: Correction remembered across weeks
- **WHEN** the user corrects a Bot ("never contact accounts owned by Dana") and, three weeks later, assigns a similar outreach task
- **THEN** the Bot applies the correction without being reminded

#### Scenario: Memory survives restart
- **WHEN** the Agent Computer restarts overnight
- **THEN** the Bot's memory store is intact and the Bot resumes with the same knowledge

### Requirement: Voice and style learning
A Bot that drafts communications SHALL learn the user's voice from provided samples and from edits the user makes to its drafts, and SHALL converge so that required edits decrease over time.

#### Scenario: Learning from edits
- **WHEN** the user repeatedly shortens greetings and removes exclamation marks from a Bot's email drafts
- **THEN** subsequent drafts adopt the shorter greeting and neutral punctuation without instruction

### Requirement: Memory transparency and control
The user SHALL be able to view a Bot's memory (as readable entries), edit or delete individual entries, and instruct the Bot in-thread to remember or forget something. Deletions SHALL be effective immediately for future actions.

#### Scenario: Inspecting memory
- **WHEN** the user opens a Bot's memory panel
- **THEN** entries are listed with content and last-updated time, each editable and deletable

#### Scenario: "Forget that"
- **WHEN** the user tells a Bot "forget the old pricing sheet — we use the March one now"
- **THEN** the outdated entry is removed/updated and the Bot confirms what changed

### Requirement: No secrets in memory
Memory stores SHALL NOT contain credentials, API keys, tokens, or payment details. Credential handling is exclusively via the `security` capability's credential vault; a Bot attempting to write secret-shaped content to memory SHALL have it redacted and flagged.

#### Scenario: Secret redaction
- **WHEN** a Bot encounters an API key during work and attempts to note it in memory
- **THEN** the write is redacted, the Bot is instructed to use the credential vault reference instead, and an audit event is recorded

### Requirement: Long-session context management
For sessions exceeding the model context window, the system SHALL compact older context automatically (server-side compaction) while preserving task-critical state, so multi-day tasks continue without loss of essential context.

#### Scenario: Multi-day task
- **WHEN** a Bot's working session for a week-long project exceeds the context window
- **THEN** earlier context is compacted, the task continues coherently, and durable facts are preserved in the memory store rather than only in the compacted transcript

### Requirement: Instance memory merge
When an ephemeral instance of a Bot completes (see `multi-bot-collaboration`), its memory changes SHALL merge back into the canonical Bot's store: new entries are added, duplicate learnings are deduplicated, and conflicting edits to the same entry are resolved newest-wins with the conflict flagged in the memory history for user review. Merges SHALL be atomic (a crashed instance merges nothing partial) and visible in the memory panel's history with instance provenance.

#### Scenario: Concurrent learnings reconciled
- **WHEN** the canonical Bot and one of its instances both update the same memory entry during overlapping work
- **THEN** the newer edit wins, the conflict is flagged in memory history showing both versions, and the user can restore the other version from the panel

#### Scenario: Crashed instance merges nothing
- **WHEN** an instance dies mid-delegation
- **THEN** the canonical Bot's memory is unchanged — no partial merge occurs — and the failed delegation is reported to the requester

### Requirement: Shared team context (opt-in)
Bots on the same Agent Computer SHALL be able to share designated memory spaces (e.g., "Team knowledge") that any Bot can read and, with permission, write — while per-Bot private memory remains isolated by default.

#### Scenario: Shared glossary
- **WHEN** the user places account naming conventions in shared team memory
- **THEN** every Bot on the Agent Computer applies those conventions, and a new Bot created later inherits them immediately
