# Tasks — Add Mobile Companion

## 1. Shared state foundation

- [ ] 1.1 Extract message/thread/approval schemas into a shared package consumed by `lib/engine` (+ tests)
- [ ] 1.2 Define `SyncBackend` interface in `lib/storage/` mirroring the storage abstraction (+ contract tests)
- [ ] 1.3 Stand up the account-scoped state service (encrypted state blobs, device registry, approval arbitration)
- [ ] 1.4 Desktop adopts `SyncBackend` behind a flag with localStorage as cache; parity test suite

## 2. Approval arbitration

- [ ] 2.1 Server-side first-writer-wins resolution with explicit rejection response (+ tests)
- [ ] 2.2 Desktop approvals submit through the service when the flag is on; rejected-second-writer UX (+ tests)

## 3. Mobile client (iOS)

- [ ] 3.1 Decide client stack (Tauri mobile vs. native) with a takeover-latency spike; record decision in design.md
- [ ] 3.2 Auth + device registration + device-level app lock
- [ ] 3.3 Bot roster + thread list + conversation view with send, synced both directions
- [ ] 3.4 Approvals list and in-thread approval actions (approve/edit/deny)
- [ ] 3.5 Live view of a session screen; explicit takeover with touch + keyboard; intervention audit events
- [ ] 3.6 Local-provider sessions render as unavailable-with-reason when unreachable

## 4. Push notifications

- [ ] 4.1 Add `push` channel to the notifications router after urgency/quiet-hours/digest logic (+ tests)
- [ ] 4.2 Device registry integration + cross-surface clear-on-action (+ tests)

## 5. Security & verification

- [ ] 5.1 Per-device revocation from the desktop; revoked device loses read and act ability (+ tests)
- [ ] 5.2 Audit-log coverage for mobile takeover, approvals, and device lifecycle
- [ ] 5.3 Walk every `mobile-companion` scenario end-to-end (Mac-off continuity included); fix gaps
