# Tool Extensibility Specification (Delta)

## ADDED Requirements

### Requirement: Account-scoped connector authorization
Connector and MCP-server authorizations SHALL be scoped to the account, not to an individual Bot or conversation: once the user authorizes an integration anywhere, every Bot can use it without re-authorization, still subject to per-bot tool visibility filtering and the policy hook. The platform SHALL provide a single grants view listing every active authorization (service, when granted, which Bots may use it), and revoking a grant there SHALL cut off all Bots at once.

#### Scenario: Authorize once, every Bot benefits
- **WHEN** the user authorizes their calendar in a conversation with one Bot
- **THEN** any other Bot whose visibility and policy allow calendar tools can use it immediately, with no second authorization prompt

#### Scenario: Visibility still gates use
- **WHEN** calendar access is authorized account-wide but a Bot's tool filter excludes calendar tools
- **THEN** that Bot cannot use the calendar despite the account-level grant

#### Scenario: One-stop revocation
- **WHEN** the user revokes the calendar grant in the grants view
- **THEN** calendar tools stop working for every Bot, and any Bot needing it asks the user to re-authorize

### Requirement: Multiple accounts per integration
An integration SHALL support multiple concurrently authorized accounts, each grant carrying a user-visible label (e.g. Slack "default" and Slack "work"). Tool calls against a multi-account integration SHALL be explicit about which account they target, a Bot SHALL be able to report what each account can access when asked, and each account SHALL be revocable independently in the grants view.

#### Scenario: Second account added without disturbing the first
- **WHEN** the user connects a second Slack workspace under the label "work"
- **THEN** both accounts appear as separate grants, Bots can address either explicitly, and revoking "work" leaves "default" functioning

#### Scenario: Ambiguity is surfaced, not guessed
- **WHEN** a Bot is asked to post to Slack and more than one account could apply
- **THEN** the Bot asks which account to use rather than picking one silently
