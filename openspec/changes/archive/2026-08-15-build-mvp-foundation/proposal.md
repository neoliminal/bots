# Build MVP Foundation

## Why

The spec suite is complete but nothing is implemented. This change builds the locally-runnable foundation: the Mac app shell with working Bot chat against real models via OpenRouter, per-Bot model configuration, and the animated ball avatars. It exercises `mac-app-shell`, `messaging`, `bot-management` (subset), `model-configuration`, and `bot-avatars`.

## What Changes

- Scaffold the Tauri 2 + React + TypeScript + Tailwind app (`app/`), with vitest test setup.
- Implement the avatar system: colored balls with animated eyes, state-driven animations (idle/thinking/working/talking/waiting/sleeping/celebrating/error/disconnected), Reduce Motion support. (SVG/CSS implementation now; Rive asset swap later.)
- Implement the OpenRouter layer: live model catalog with capability filtering, dev key loading from `keys/.env` (Rust side), per-Bot model selection with primary/utility roles, usage logging.
- Implement messaging UI: sidebar roster with avatars, per-Bot threads, message persistence (SQLite via Tauri), streaming responses.
- Implement the local bot engine: per-Bot persona (role description as system context), chat completion streaming via OpenRouter, bot state feed driving avatars.
- Tests at every layer; full suite green plus `tsc` and `cargo check` clean.

## Out of Scope (later changes)

- Cloud Agent Computer (VMs, screens, computer use, live view, takeover)
- Routines, multi-bot collaboration/Executive Assistant, notifications beyond basics, credential vault (dev key only)

## Impact

- New `app/` directory (Tauri project). No changes to existing specs.
- Dev-only key handling per project.md conventions; key never committed.
