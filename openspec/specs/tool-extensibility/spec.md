# Tool Extensibility Specification

## Purpose

Bot capabilities are organized into three layers: **tools** (typed functions a bot can call), **skills** (instruction packs that teach workflows without adding capabilities), and **plugins** (packaged capability sources — MCP servers being the primary form — that contribute tools). This capability covers the tool registry, per-bot visibility filtering, policy-hook gating of every tool call, authored skills, and MCP server integration. Autonomy and approval semantics live in `human-handoff`; per-bot tool policy configuration lives in `bot-management`; credential handling lives in `security`.

## Requirements

### Requirement: Three-layer capability model
The platform SHALL organize bot capabilities into three distinct layers: **tools** (typed functions a bot can call, defined by a name, a description, a JSON Schema for parameters, and an implementation), **skills** (instruction packs that teach workflows without adding capabilities), and **plugins** (packaged capability sources — MCP servers being the primary form — that contribute tools into the registry). A capability surface SHALL belong to exactly one layer.

#### Scenario: Layers stay separate
- **WHEN** a user wants a bot to follow a specific invoice-filing procedure using tools the bot already has
- **THEN** this is delivered as a skill (instructions), not a new tool, and enabling it grants no new capability

### Requirement: Tool registry with structured definitions
All tools — built-in, session, and plugin-contributed — SHALL live in one registry keyed by unique name, and tools visible to a bot SHALL be sent to the model as structured function definitions derived from their JSON Schema. Tool implementations SHALL return model-readable text results and SHALL report failures as error results rather than thrown exceptions, so a failed tool call never aborts the bot's turn.

#### Scenario: Uniform registration
- **WHEN** an MCP server contributes a `create_ticket` tool
- **THEN** it appears in the same registry as built-in tools, namespaced by its source, and is offered to the model in the same structured format

#### Scenario: Tool failure is survivable
- **WHEN** a tool implementation fails (network error, invalid input)
- **THEN** the model receives an error result describing the failure and the bot's turn continues

### Requirement: Per-bot tool visibility filtering
The model request for a bot SHALL include only the tools that survive that bot's tool policy, evaluated before the request is built: the bot's configured allow/deny list (see `bot-management`), environment availability (a tool whose runtime preconditions are unmet is hidden, not offered-then-failing), and plugin enablement. A bot SHALL never see the schema of a tool its policy excludes.

#### Scenario: Restricted bot never sees the tool
- **WHEN** a bot's policy denies shell access
- **THEN** `session_exec` is absent from that bot's model requests entirely — the model cannot attempt to call it

#### Scenario: Precondition hides rather than errors
- **WHEN** no compute-session provider credential is configured
- **THEN** remote session tools are hidden from all bots instead of returning "unavailable" errors at call time

### Requirement: Policy-hook gating
Every tool call SHALL pass through a policy hook that returns one of **allow**, **require-approval**, or **deny**, evaluated with the calling bot, the tool, and the call arguments. The hook SHALL implement the `human-handoff` autonomy matrix (per-bot, per-action-category settings), and the non-configurable "always ask" floors (credentials, payments, irreversible bulk deletions) SHALL be enforced in this hook and not be overridable by any tool, skill, plugin, or bot configuration. Require-approval decisions SHALL park a pending approval per `human-handoff`.

#### Scenario: Same tool, different bots
- **WHEN** two bots call `send_email` and only one has been granted act-and-report autonomy for external communications
- **THEN** the granted bot's call runs (and is reported), while the other bot's call parks an approval request

#### Scenario: Floor beats configuration
- **WHEN** any configuration attempts to make a payment-confirming tool call fully autonomous
- **THEN** the policy hook still returns require-approval and the call waits for the user

### Requirement: Authored skills
The user SHALL be able to add markdown skill packs to a bot: named documents describing a repeatable workflow, rubric, or operating constraint. Enabled skills SHALL be injected into the bot's system prompt, SHALL be bounded in total size with the bot told which skills are available when the bound is exceeded, and SHALL never widen the bot's tool visibility or autonomy. A bot MAY draft a skill from completed work, but a bot-authored skill SHALL be visible to the user and editable like any other.

#### Scenario: Skill guides existing tools
- **WHEN** a bot with a "weekly metrics report" skill is asked for the weekly report
- **THEN** it follows the skill's documented steps using its existing tools, without any new capability having been granted

#### Scenario: Skill cannot escalate
- **WHEN** a skill document instructs the bot to use a tool its policy denies
- **THEN** the tool remains invisible to the bot and the policy hook is unaffected by the skill's text

### Requirement: MCP server integration
The platform SHALL let the user register MCP servers (stdio transport first) as tool sources. Tools from a server SHALL be namespaced by server name, pass through the same visibility filtering and policy hook as built-in tools, and be filterable per server. Credentials for MCP servers SHALL be held by the platform and injected at connection/egress per `security` — never placed in model context, tool results, or logs.

#### Scenario: Zero-code tool addition
- **WHEN** the user registers a configured MCP server for their helpdesk
- **THEN** its tools appear (namespaced) for the bots whose policy allows them, with no platform code changes

#### Scenario: Server credential stays invisible
- **WHEN** a bot uses an MCP tool that requires the server's API token
- **THEN** the token is supplied by the platform to the server process and never appears in the bot's context or the thread

#### Scenario: Misbehaving server is contained
- **WHEN** a registered MCP server crashes or hangs
- **THEN** its tools fail as error results (or are hidden once marked unavailable) and bots' other tools are unaffected
