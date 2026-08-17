# Add Bot Introductions

## Why

A freshly created bot presents an empty thread — the burden of discovering what it can do and typing a first instruction falls entirely on the user. The pillar audit flagged this as the missing onboarding flow: a new bot should greet the user by name and ask "what do you mainly want me around for?" with pick-one options. We now have every ingredient: question cards, role-derived suggestions, and the choices pipeline.

## What Changes

- On creation, a bot's thread is seeded with an introduction: a short greeting in the bot's role voice plus a question card of role-derived starter tasks ("What should I take on first?"). Answering is one click; the answer flows through the normal send path and the bot takes it from there.
- Starter options derive from the role library (each library role gains curated starter tasks); custom role descriptions match to the closest library role's options, with a generic fallback.
- The seed is local and instant — no model call, no API key needed; the first model turn happens when the user answers.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `bot-management`: new requirement — bot introduction with starter options on creation.

## Impact

- `app/src/app/roleSuggestions.ts` (starter options per role + matcher), `app/src/App.tsx` (seed on create/quick-create), chat store used as-is (+ tests).
