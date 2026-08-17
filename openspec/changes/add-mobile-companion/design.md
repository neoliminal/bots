# Design — Add Mobile Companion

## Context

Bots is currently a single-device product: state persists in localStorage behind `lib/storage/`, and compute sessions exist (`lib/sessions/`, Local + Fly providers) but conversations and approvals live only on the Mac. A phone surface forces the first real multi-device architecture decision: where does shared state live?

## Goals / Non-Goals

**Goals:**
- Define the sync boundary: threads, bot roster, approvals, and notification state become account-synced data.
- Phone app with thread messaging, approvals, push, live view, and takeover.
- Preserve every existing invariant (human-handoff, security, notifications rules) rather than inventing mobile-specific behavior.

**Non-Goals:**
- No bot editing/creation on mobile in v1 (view + converse + approve + take over only).
- No Android in v1 (spec is platform-neutral; iOS ships first).
- No offline authoring beyond queued outgoing messages.

## Decisions

- **Sync via a thin account-scoped state service, not device-to-device.** The desktop cannot be the server (it's allowed to be off — that's the point). Introduce a `SyncBackend` interface in `lib/storage/` mirroring the existing storage abstraction so the engine stays unaware; desktop keeps localStorage as a cache. Alternative (iCloud/CRDT device sync) rejected: approvals need a single arbiter to prevent double-execution.
- **Approvals resolve server-side, first-writer-wins.** Both surfaces submit resolutions to the state service; the second resolution is rejected and reflected back. This is what makes "acted on either surface" safe.
- **Live view/takeover reuses the session provider's existing screen channel** (Fly sessions already expose one for the desktop live-view); the phone is just a second authorized client. Takeover arbitration: one controller at a time, human always preempts bot, per `human-handoff`.
- **Push is a channel in the existing notifications router**, not a new pipeline: the router gains a `push` channel whose delivery target is the device registry. Quiet hours/digest logic runs before channel selection, unchanged.
- **Mobile client is a separate codebase consuming shared schemas.** Message/thread/approval types move to a shared package so the phone app and `lib/engine` cannot drift. Alternative (Tauri mobile from the same repo) is attractive but unproven for this UI; decide at implementation start.

## Risks / Trade-offs

- [A sync service is new hosted infrastructure with real security surface] → scope it to encrypted state blobs + approval arbitration only; no model calls, no credentials (vault stays per existing `security` spec).
- [Local-provider sessions can't be reached when the Mac is off] → spec'd as labeled unavailability, not failure; nudges users toward cloud sessions for always-on bots.
- [Double-resolution races on approvals] → server-side first-writer-wins with explicit rejection UX.
- [Phone as attack surface for takeover] → device auth to open app, per-device revocation, takeover recorded in audit log.

## Migration Plan

Desktop adopts the `SyncBackend` behind a flag while localStorage remains source of truth; once parity is proven, the service becomes authoritative and localStorage demotes to cache. Rollback: flag off, desktop reverts to local-only. Phone ships only after the authoritative flip.

## Open Questions

- Build the state service on the existing Fly footprint or a separate managed store?
- Tauri mobile vs. native Swift for the client?
- Does v1 need takeover, or is watch-plus-approve enough to ship earlier?
