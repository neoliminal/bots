# Refine UX Pass 1

## Why

First hands-on feedback on the MVP: the avatar eyes are overdone (cartoon eyeballs with pupils/whites), the model picker is an exhaustive wall with no way to type/filter, and Bot creation starts from a blank role description.

## What Changes

- Rebuild avatar eyes per updated `bot-avatars` spec: two rounded-end strokes moving in tandem, morphing (strokes ↔ dots ↔ sleepy lines ↔ squints ↔ happy arcs), blink = collapse to line. Remove pupils/whites/irises.
- Model picker per updated `model-configuration` spec: featured shortlist (flagships + utility pick + models in use) with full catalog collapsed behind it; instant type-to-filter across name/id/provider.
- Role first guess per updated `bot-management` spec: personal-assistant default pre-filled; suggestions that complement the existing roster; usage-inferred suggestions as history accumulates.

## Impact

- `app/src/features/avatars/` (eye rendering + poses + tests), `app/src/features/models/ModelPicker.tsx` (+tests), `app/src/app/BotEditor.tsx` + new role-suggestions module (+tests).
