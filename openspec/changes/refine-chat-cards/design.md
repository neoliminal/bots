# Design — Refine Chat Cards

## Context

All four items are pillar applications (minimize human typing/mental load) over already-shipped machinery: chips exist (chat store `choices` block + ThreadView), sidebar rows already receive a `state`, template file-loading exists but is secondary to paste, and the host transport (`host_exec` over ssh) is live.

## Goals / Non-Goals

**Goals:** card presentation + receipt collapse + inline own-answer; amber waiting rows; file-first import; user-initiated host discovery.
**Non-Goals:** per-option descriptions and keyboard-shortcut answering (letter badges are visual affordances first; keybindings later to avoid composer-focus conflicts); changing the `<<choices>>` stream-marker format; background/continuous network scanning.

## Decisions

- **Card is a rendering change only.** `ChoiceBlock` keeps its shape (`prompt/options/answeredWith`); the receipt state derives from `answeredWith`. No store or marker migration.
- **Inline own-answer reuses `onChoiceSelect`** with the typed text as the option — the store already marks any user send as the answer, so one path serves clicks, inline text, and composer text identically.
- **Sidebar amber derives from the existing `state === "waiting"`** mapping (`waitingOnUser`/`error`/`disconnected` already map to "waiting" in App). Amber dot shares the unread-dot slot; unread blue wins when both apply (unread implies something newer to read than the wait).
- **Import goes file-first** by pointing the "Import template…" button at a hidden file input; paste-JSON stays behind a "paste JSON instead" toggle. Parsing/preview/inertness unchanged.
- **Discovery = one Rust command** `host_discover` spawning `dns-sd -B _ssh._tcp` for a bounded window (~3s, tokio timeout, process killed after) and parsing instance names to `<name>.local` candidates. Returned to the UI as suggestions; clicking prefills `<localUser>@<host>` (editable). dns-sd instance names are not guaranteed to equal hostnames — the field stays editable and Save & test verifies, so a wrong guess costs one click, not a lie.

## Risks / Trade-offs

- [Receipt hides unchosen options the user may want to revisit] → the prompt text remains in the receipt; asking again is one message. History scannability wins.
- [dns-sd parsing is best-effort] → suggestions only; the reachability probe (Save & test) is the source of truth.
- [Amber row could nag during long approvals] → it reflects a true state (`waitingOnUser`); clearing it means answering the bot, which is the point.

## Migration Plan

Pure UI/additive; no data changes. Existing answered `choices` blocks render as receipts retroactively (same data).

## Open Questions

- Keyboard answering (press A–E) — deferred until a focus model is chosen.
