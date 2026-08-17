# Tasks

## 1. Scaffold
- [x] 1.1 Tauri 2 + React + TS + Vite + Tailwind project in `app/`, builds clean
- [x] 1.2 Vitest + Testing Library configured; all shared deps installed up front
- [x] 1.3 `cargo check` and `npm run build` pass on the empty scaffold

## 2. Features (parallel)
- [x] 2.1 Avatar system in `app/src/features/avatars/` with tests
- [x] 2.2 OpenRouter client + model config in `app/src/lib/openrouter/` + `app/src/features/models/` with tests; dev key via Rust command reading `keys/.env`
- [x] 2.3 Chat UI + store in `app/src/features/chat/` with tests
- [x] 2.4 Bot engine in `app/src/lib/engine/` (personas, streaming, state feed) with tests

## 3. Integration
- [x] 3.1 Wire features into App shell (roster sidebar + thread view + model picker + bot settings)
- [x] 3.2 Bot CRUD (create with name/color/role/model, edit, delete) persisted locally

## 4. Verification
- [x] 4.1 Full vitest suite green; `tsc --noEmit` clean; `cargo check` clean
- [x] 4.2 Live smoke test: model catalog fetch + one cheap completion via dev key
- [x] 4.3 Code review pass; findings fixed or logged
