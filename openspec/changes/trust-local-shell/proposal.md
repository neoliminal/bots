# Trust Local Shell

## Why

A Bot running on this Mac stops and asks before every shell command; the identical Bot on a personal host or a cloud VM does not (`DEFAULT_CATEGORY_RULES`: `shell-local: "approve"`, `shell-session: "allow"`). That asymmetry isn't tracking real risk — local exec is already locked to the Bot's own workspace directory with a sanitized environment, a 30-second timeout and a 256KB output cap — it just makes the default configuration the most interrupting one. Worse, the thing the user is asked to adjudicate is a raw shell command they mostly can't evaluate, so the prompt collects a reflexive "yes" and teaches the user to click through gates, which is exactly the habit that makes the gates that *do* matter (payments, credentials, deletion) less effective.

The same argument applies to the per-command `$ …` lines posted into the thread: they are noise in a conversation, they aren't how a user wants to learn what their teammate did, and they push the actual reply off screen. The trail still needs to exist — it is what makes not asking defensible — but its home is an activity log, not a chat.

## What Changes

- **Local shell runs without asking**: the platform default for `shell-local` becomes `allow`, matching `shell-session`. **This lowers a default gate** — see the unchanged list below.
- **Unchanged gates**: the hard floors (permanent deletion, credentials, payments) remain `approve`-or-stricter and still cannot be loosened per-bot; `external-comms` stays gated; the taint rule still escalates `self-modify` / `delegation` / `external-read` to approval once untrusted third-party content has entered a run. A user who wants the old behavior can still set `shell-local` to Ask first per Bot in the Bot editor.
- **Commands leave the thread**: no per-command `$ …` timeline entries. Session lifecycle indicators (provisioned / warm-resumed / stopped) and genuine warnings (sync-back skipped files) stay — those tell the user something they can act on.
- **Activity log in Settings**: a new view over the existing audit store — every tool call with its decision (`tool.allowed` / `approved` / `denied` / `refused` / `blocked`), acting Bot, delegation chain, and timestamp — filterable by Bot, with the existing `exportAuditLog` text export wired to a save. The store and its records already exist; nothing reads them today, which is the gap this closes.
- **Copy follows behavior**: the onboarding compute card and Settings currently promise "I ask before every command" for This Mac. That becomes an accurate description of what the local option actually means (own workspace, no network of its own, everything logged).

## Capabilities

### New Capabilities

_None — this changes defaults and surfaces within existing capabilities._

### Modified Capabilities

- `agent-computer`: "Isolation and hygiene" currently requires every session command to be recorded **in the task timeline**. It moves to requiring the record in the tenant-visible audit log, with the thread reserved for lifecycle and warnings.
- `security`: "Comprehensive audit log" gains the requirement that the log is reachable and readable **in the app**, not merely retained and exportable — hiding per-command detail from the thread is only acceptable if the trail has a door.
- `task-execution`: new requirement — work inside a Bot's own workspace proceeds without per-action approval, with the sensitive-action floor unchanged. This states the autonomy boundary the default now encodes, so a future reader can tell the difference between "we trust this" and "we forgot to gate it".

## Impact

- `app/src/lib/engine/policy.ts` — one default flips; `policy.test.ts` and any test asserting the old default update with it.
- `app/src/app/sessionGlue.ts` — drop the `session_exec` timeline post; keep lifecycle events and sync warnings.
- `app/src/app/` — new `ActivityLog.tsx` (+ tests) rendered inside `SessionSettings`, reading `auditLog` and `exportAuditLog` from `lib/engine/audit.ts`; save via the existing `saveTextFile` native binding.
- `app/src/app/computeOptions.ts`, `onboardingCompute.ts` — local-option copy and the local confirmation line.
- No change to `lib/sessions/`, the approval pipeline, or the Rust host: gated tools still park exactly as before, there are just fewer of them by default.
- Existing Bots with an explicit per-bot `shell-local` rule keep it; only the platform default moves.
