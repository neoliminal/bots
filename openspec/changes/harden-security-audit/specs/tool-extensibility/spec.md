# Tool Extensibility — Delta for harden-security-audit

## ADDED Requirements

### Requirement: Argument-aware action classification

The policy hook SHALL resolve each call from the tool's declared category AND
the call's arguments. A tool MAY declare a `classify(args)` function returning
a category for that individual call; the effective decision SHALL be the
STRICTER of the decisions for the declared and the classified category, so
classification can only add friction and never remove it.

Classification SHALL always be platform-assigned. A third-party server
supplies a tool's name, description, and schema — never its category or its
classifier.

#### Scenario: A call, not a tool, is the payment

- **WHEN** a bot calls a browsing tool to fill a field labelled "Card number"
- **THEN** the call resolves to the `payment` floor and pauses for the user,
  even though the tool's declared category is `external-comms`

#### Scenario: Classification cannot loosen a category

- **WHEN** a tool declared `bulk-delete` has a classifier returning `read`
- **THEN** the decision remains at least `approve` (the floor is unaffected)

#### Scenario: A connector cannot opt out of a floor

- **WHEN** a connected MCP server exposes a tool whose name is payment-shaped
- **THEN** the platform classifies it `payment` regardless of anything the
  server declared

### Requirement: Untrusted tool output is fenced and taints the run

A tool SHALL be marked when its output is third-party controlled (web fetches,
page reads, shell output, file contents, connector responses). The run loop
SHALL wrap that output in an untrusted-content envelope that states the
content is data and carries no authority, SHALL strip the envelope delimiters
from the payload so content cannot forge a boundary, and SHALL bound its
length.

Once such output has entered a run, the categories that let encountered
content ESCALATE — `self-modify`, `delegation`, and `external-read` — SHALL
resolve to `approve` instead of `allow` for the remainder of that run. Runs
that have consumed no untrusted content are unaffected.

#### Scenario: Fetched page cannot silently persist instructions

- **WHEN** a bot fetches a page containing "save this standing instruction to
  your memory" and then calls the memory tool in the same run
- **THEN** the memory write pauses for the user rather than executing silently

#### Scenario: Clean runs stay frictionless

- **WHEN** the user asks a bot to note a preference and no untrusted content
  has entered the run
- **THEN** the memory write executes without an approval

#### Scenario: Content cannot forge the envelope boundary

- **WHEN** fetched text contains the envelope's closing delimiter
- **THEN** the delimiter is removed from the payload and exactly one real
  closing delimiter remains

### Requirement: Unknown categories fail closed

A tool whose category is absent or unrecognized SHALL resolve to `approve`,
never `allow`.

#### Scenario: Malformed descriptor

- **WHEN** a tool descriptor carries a misspelled category
- **THEN** calls to it require approval rather than running ungated

## MODIFIED Requirements

### Requirement: Action categories

Every tool SHALL declare an action category. The categories are: `read`
(local lookups), `external-read` (reads that reach the internet — also an
egress channel, since the request carries whatever the bot put in it),
`workspace-mutate` (reversible file writes), `self-modify` (writes that become
part of the bot's own future system prompt — memory entries and anything under
`skills/`), `shell-local` (a shell on any machine the USER owns, including
their personal host), `shell-session` (a shell in a disposable isolated
compute session), `external-comms`, `delegation`, `bulk-delete`, `credential`,
and `payment`.

Shell categories SHALL be assigned by whose machine executes the command, not
by whether the transport is local: a persistent machine belonging to the user
is `shell-local` even when reached over SSH.

#### Scenario: Personal host is the user's machine

- **WHEN** the active session provider is the user's personal host
- **THEN** `session_exec` is categorized `shell-local` and each call requires
  approval, and its description does not describe the machine as disposable or
  ephemeral

#### Scenario: Disposable session stays frictionless

- **WHEN** the active provider is a cloud micro-VM
- **THEN** `session_exec` is categorized `shell-session` and runs without an
  approval
