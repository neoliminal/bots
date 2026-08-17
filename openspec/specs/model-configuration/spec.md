# Model Configuration Specification

## Purpose

The user chooses which LLM powers each Bot. Model access is routed through **OpenRouter** initially — one integration surface exposing many providers/models — with the architecture keeping a provider-agnostic routing layer so keys and models outside OpenRouter (direct provider keys) plug in without redesign. Keys are user-supplied (BYO), stored in the credential vault, and usable by any Bot. Different Bots on the same Agent Computer can run different models (a cheap fast model for a triage Bot, a frontier model for an Executive Assistant Bot).

## Requirements

### Requirement: Per-Bot model selection
Each Bot SHALL have a configurable model setting, selectable at creation and changeable at any time from the Bot's settings. A model change SHALL take effect on the Bot's next model call without recreating the Bot, and SHALL be recorded in the Bot's configuration history.

#### Scenario: Different models per bot
- **WHEN** the user sets the Research Bot to a fast/cheap model and the Executive Assistant Bot to a frontier model
- **THEN** each Bot's subsequent reasoning runs on its own configured model, verifiable in the task timeline's per-step model attribution

#### Scenario: Changing model mid-life
- **WHEN** the user switches a Bot's model while it has a task in flight
- **THEN** the in-flight task continues; the new model applies from the next task (or next safe boundary, with a note in the task timeline), and the Bot's memory and identity are unaffected

### Requirement: OpenRouter as the initial model catalog
The platform SHALL integrate OpenRouter as the first model provider: the model picker SHALL list available OpenRouter models (fetched live, with name, provider, context window, and pricing), filtered to models meeting the platform's minimum capability bar (tool/function calling; vision required for computer-use work).

#### Scenario: Browsing the catalog
- **WHEN** the user opens the model picker for a Bot
- **THEN** they see a searchable list of OpenRouter models with pricing and capability badges, with incompatible models (no tool calling) shown as unselectable with the reason

### Requirement: Picker ergonomics — featured shortlist plus search
The model picker SHALL NOT present the full catalog as an undifferentiated list. It SHALL open with a small curated **featured** section at the top (roughly 5–8 likely choices: current flagship agentic models across the major providers, plus a recommended cheap utility model, plus any models already in use by the user's other Bots), with the full catalog collapsed behind it. A prominent type-to-filter search box SHALL filter the entire catalog as the user types, matching on model name, model id, and provider (e.g., typing "anthropic" narrows to Anthropic models); filtering happens locally and instantly.

#### Scenario: Likely suspects first
- **WHEN** the user opens the picker without typing anything
- **THEN** they see the short featured list (flagships, a utility pick, and models their other Bots use) rather than hundreds of entries, with a control to browse the full catalog

#### Scenario: Filter by provider
- **WHEN** the user types "anthropic" in the search box
- **THEN** the list narrows to Anthropic models only, instantly, across the entire catalog (not just the featured section)

#### Scenario: Search by partial name
- **WHEN** the user types a fragment like "4o" or "haiku"
- **THEN** models whose name or id contain the fragment are shown, ranked with featured/popular matches first

#### Scenario: Capability guardrails
- **WHEN** the user selects a text-only model for a Bot whose role involves computer use
- **THEN** the picker warns that screen-based work requires a vision-capable model and offers either choosing a compatible model or a per-task-class split (see model roles below)

### Requirement: Provider-agnostic routing layer
Model access SHALL go through an internal routing layer keyed by (provider, model, credential) so that providers other than OpenRouter (e.g., direct model-provider keys, self-hosted endpoints) can be added as first-class providers. No Bot-facing or spec-level concept SHALL assume OpenRouter specifically.

#### Scenario: Adding a direct provider later
- **WHEN** a direct provider integration is added alongside OpenRouter
- **THEN** its models appear in the same picker, existing Bot configurations are untouched, and a Bot can be switched between an OpenRouter-routed model and a direct-keyed model with no other changes

### Requirement: Bring-your-own API keys
The user SHALL be able to add one or more API keys (OpenRouter keys now; direct provider keys as providers are added), stored in the credential vault per the `security` capability: write-only after entry, injected server-side at egress, never visible to Bots, model context, or logs. Any stored key SHALL be usable by any Bot the user assigns it to; a default key MAY be set for all Bots.

#### Scenario: One key, many bots
- **WHEN** the user adds an OpenRouter key and sets it as the default
- **THEN** all Bots' model calls authenticate with that key, and adding a second key allows assigning specific Bots to it (e.g., separating personal vs. client billing)

#### Scenario: Key validation on entry
- **WHEN** the user pastes a key
- **THEN** the platform verifies it with a minimal probe call before saving, and reports invalid or unfunded keys immediately

#### Scenario: Key revocation
- **WHEN** the user removes a key that Bots are using
- **THEN** affected Bots surface a missing-credential blocker on their next model call (per `security`) rather than failing silently, and prompt for a replacement key or fallback

### Requirement: Model roles within a Bot
A Bot's model configuration SHALL support distinct model assignments per task class — at minimum: **primary** (reasoning/planning/computer use) and **utility** (classification, routing, summarization) — so expensive models are reserved for work that needs them. Defaults SHALL be sensible (utility falls back to primary if unset).

#### Scenario: Cheap utility model
- **WHEN** the user assigns a small fast model as a Bot's utility model
- **THEN** notification triage and routing calls use the utility model while task reasoning stays on the primary, with the split visible in usage reporting

### Requirement: Failure handling and fallbacks
The user MAY configure an ordered fallback list per Bot. On provider errors (rate limit, outage, model deprecated), the platform SHALL retry per policy and then fail over to the next configured fallback, recording every failover in the task timeline. Without a configured fallback, the task pauses with a clear blocker rather than degrading silently.

#### Scenario: Provider outage with fallback
- **WHEN** a Bot's primary model returns repeated 5xx errors mid-task and a fallback model is configured
- **THEN** the task continues on the fallback, the timeline records the switch, and the Bot returns to the primary on the next task

#### Scenario: No fallback configured
- **WHEN** the same outage occurs with no fallback configured
- **THEN** the task pauses with a "model unavailable" blocker and notifies the user, resuming automatically when the model recovers

### Requirement: Usage and cost visibility
The platform SHALL track model usage per Bot, per model, and per key (tokens and provider-reported cost where available), showing it in a usage view with daily/weekly rollups. The user MAY set soft budget alerts per key or per Bot.

#### Scenario: Cost by bot
- **WHEN** the user opens the usage view
- **THEN** they see spend and token counts broken down by Bot and by model for the selected period, matching what OpenRouter reports for the same window

#### Scenario: Budget alert
- **WHEN** a Bot passes its configured weekly soft budget
- **THEN** the user gets a notable notification; work continues unless the user has additionally enabled a hard pause at the cap
