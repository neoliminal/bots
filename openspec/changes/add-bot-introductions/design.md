# Design — Add Bot Introductions

## Context

All machinery exists: `addBotMessage` + `attachChoices` in the chat store seed a bot message carrying a `ChoiceBlock`; ThreadView renders it as a question card; App's `onChoiceSelect` posts the answer through the normal send path, which triggers the first model turn.

## Goals / Non-Goals

**Goals:** instant, local, keyless introduction with role-derived starter options on every creation path (editor and quick-create).
**Non-Goals:** model-generated greetings (the first model call stays user-triggered); re-introducing existing bots; group-thread introductions.

## Decisions

- **Local seed over model call.** Deterministic, instant, free, works before keys exist; the model enters on the user's answer with a concrete instruction in context. Alternative (a model-driven greeting) deferred — it costs latency and tokens for a message whose content is predictable.
- **Starter options live in the role library** (`ROLE_LIBRARY` entries gain `starterOptions`). Custom descriptions reuse the existing `coverageKeywords` matching to borrow the closest role's options; a generic set is the floor. One source of truth for role knowledge.
- **Seed in App's create handlers**, not the bot store — the engine layer stays chat-agnostic; the store's existing primitives are used unmodified.

## Risks / Trade-offs

- [Canned greeting can feel templated] → kept to one short line + card; the bot's real voice starts on the first answer.

## Migration Plan

Additive; existing bots are untouched (no retroactive seeding).

## Open Questions

_None._
