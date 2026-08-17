# Add Mobile Companion

## Why

A mobile app is a decisive part of the "always-on teammate" promise: users check on bots, approve drafts, and even drive the agent computer from their phone while their Mac is closed. Bots for Mac currently has no away-from-desk surface at all — approvals and notifications dead-end until the user is back at the desktop.

## What Changes

- A phone companion app (iOS first) that mirrors the user's bots: sidebar, full conversation history, and message send, synced with the desktop.
- Remote view and takeover of a Bot's Agent Computer screen from the phone (live-view parity: watch, then take control with touch + keyboard).
- Approvals and notifications on the go: pending approvals actionable from the phone, push notifications routed per the `notifications` spec.
- Computer-optional continuity: everything above works while the Mac is off, for Bots running on cloud compute sessions.

## Capabilities

### New Capabilities

- `mobile-companion`: the phone surface — synced threads and bot roster, remote screen view/control, on-the-go approvals, and push delivery — with the same security and human-handoff invariants as the desktop.

### Modified Capabilities

_None — messaging, live-view, notifications, and human-handoff requirements are consumed as-is; this capability defines the additional surface, not new behavior in those specs._

## Impact

- New mobile client codebase (outside `app/`; shares message/thread schemas with `lib/engine`).
- Requires account-level sync of threads/state beyond current localStorage persistence (`lib/storage/`) — the largest architectural implication.
- `lib/sessions/` Fly provider becomes the basis for "works while the Mac is off"; local-provider sessions are desktop-tethered and degrade gracefully.
- Push notification routing added to the `notifications` channel table (consumes existing urgency classes).
