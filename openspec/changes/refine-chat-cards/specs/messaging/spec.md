# Messaging Specification (Delta)

## MODIFIED Requirements

### Requirement: Structured choice prompts
When a Bot offers the user a set of options, the thread SHALL render them as a question card rather than requiring the user to type an answer: the prompt as the card's title, options as one-click rows with letter badges (A, B, C…), and an inline free-text field inside the card for typing an own answer. Selecting an option or submitting the inline field SHALL post the answer as a normal user message (visible in history and to the Bot). Free-text reply through the main composer SHALL always remain available alongside the card. Once answered — by card, inline field, or composer — the card SHALL collapse to a receipt showing only the chosen answer with a confirmation mark, keeping thread history scannable.

#### Scenario: One-click option selection
- **WHEN** a Bot asks "How should I handle replies?" with three offered modes
- **THEN** the three modes render as option rows with letter badges, clicking one posts it as the user's message, and the Bot proceeds on that answer

#### Scenario: Inline own answer
- **WHEN** none of the offered options fit and the user types into the card's own-answer field and submits
- **THEN** the typed text is posted as the user's message exactly as a click would be, and the card collapses to a receipt of that answer

#### Scenario: Receipt after answering
- **WHEN** a prompt has been answered by any path (option click, inline field, or composer free text)
- **THEN** the card no longer shows the unchosen options — only the prompt and the chosen answer with a confirmation mark

## ADDED Requirements

### Requirement: Waiting-state visibility in the thread list
A Bot that is blocked on the user (`waitingOnUser`) SHALL be visibly flagged on its thread-list row without the user opening the thread: an attention-colored status line (e.g. "Waiting for you…", amber) and an attention-colored indicator dot. The flag SHALL clear as soon as the Bot is no longer waiting.

#### Scenario: Waiting bot flags its row
- **WHEN** a Bot pauses for the user (an approval, a sign-in, a question) while the user is in another thread
- **THEN** the Bot's sidebar row shows the amber "Waiting for you…" status line and amber dot, and returns to normal once the user responds
