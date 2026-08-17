# Human Handoff — Delta for harden-security-audit

## ADDED Requirements

### Requirement: Delegation intersects policy along the chain

A delegated run SHALL be permitted no more than the MOST RESTRICTED bot in its
delegation chain. The policy hook SHALL evaluate the acting bot and every bot
upstream of it and take the strictest decision.

Without this, delegation launders permission: a bot whose external
communication is blocked writes the message into a brief and hands it to a
teammate whose policy permits sending.

#### Scenario: Restriction survives the hand-off

- **WHEN** a bot whose external comms are Blocked delegates a task whose brief
  asks a teammate to send an email, and the teammate's own policy allows
  sending
- **THEN** the send is refused, because the requesting bot could not have done
  it directly

#### Scenario: Direct runs are unaffected

- **WHEN** the user asks a bot directly to do something its own policy allows
- **THEN** it runs with no additional friction

### Requirement: Stop halts work already decoded

Stopping a run SHALL prevent tool calls that have not yet started, including
the remaining calls of a model round whose first call is already running, and
including a call whose approval was parked when Stop arrived. The cancellation
signal SHALL be available to tools so long-running work can honor it.

#### Scenario: Remaining calls in the round do not run

- **WHEN** a model round returns three tool calls and the user stops the bot
  while the first is running
- **THEN** the second and third never execute

#### Scenario: Stop while an approval is parked

- **WHEN** the user stops the bot while a gated call waits for approval
- **THEN** the call does not execute even if the approval is subsequently
  allowed

### Requirement: Approvals show everything that will execute

An approval SHALL display every argument the call carries, not only the
arguments the card recognizes, so nothing executes unseen. A one-click
approval control SHALL state what is being approved adjacent to the control
itself, not only in an accessible label.

#### Scenario: Unrecognized argument is still shown

- **WHEN** a send-email approval carries a `bcc` argument the card has no
  named field for
- **THEN** the `bcc` value is rendered among the fields

#### Scenario: The button says what it approves

- **WHEN** an inline draft action offers Approve beneath a bot's message
- **THEN** the summary of the pending action is visible next to the button,
  independently of the message text the bot wrote above it

## MODIFIED Requirements

### Requirement: Hard floor cannot be disabled

Credential handling, payment confirmation, and irreversible deletion SHALL
always require a human, and no policy, tool, skill, plugin, or connector may
loosen them below require-approval. The floors SHALL be REACHABLE in practice:
the platform SHALL classify individual calls into `credential` and `payment`
from their arguments (field labels and values, control names, connector tool
names), because no tool is inherently a credential or payment action — only a
call is.

The autonomy settings surface SHALL present the floor categories and SHALL NOT
offer "Allowed" for them.

#### Scenario: Password entry pauses regardless of settings

- **WHEN** a bot attempts to type into a password or one-time-code field, and
  the user has set that tool and its category to Allowed
- **THEN** the action still pauses for the user

#### Scenario: Payment confirmation pauses

- **WHEN** a bot attempts to click a control named "Pay now", or calls a
  payment-shaped connector tool
- **THEN** the action pauses for the user
