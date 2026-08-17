## Context

Every piece of machinery this change needs already exists and is shipped:

- Three session providers (`local`, `fly`, `host`) behind `SessionProvider`, selected through `sessionGlue`: `setSessionProvider`, `getSessionProviderKind`, `setHostTarget`, `getHostTarget`, `hostProviderStatus`, `flyProviderStatus`.
- Network discovery of SSH hosts (`hostDiscover` in `lib/native`, backed by the Rust host) — already used by the "Scan network" button in `SessionSettings.tsx`, which turns results into clickable chips.
- Question cards end to end: `ChoiceBlock` on a chat message, `attachChoices`, the `QuestionCard` renderer with letter-badged rows plus an inline own-answer field, receipt collapse on answer, and `onChoiceSelect` wired in `App.tsx`.
- A locally seeded introduction: `handleCreate` in `App.tsx` posts a greeting and attaches a starter-task card from `starterOptionsFor(roleDescription)` with no model call.

What is missing is only the wiring: the provider decision lives behind a Settings dialog the first-time user has no reason to open, and every question card today is answered by sending the text to the model. This change adds one first-run card sequence that the app itself answers.

Constraint that shapes most of the decisions below: onboarding must work with **no API key configured**, because the app is usable (and the first bot is created) before a key exists. Nothing in this flow may depend on a model turn.

## Goals / Non-Goals

**Goals:**

- The first Bot asks where it should work, in-thread, answerable entirely by clicking.
- Picking "a machine I own" gets the user to a *verified reachable* host without typing an address, when discovery can find one.
- A wrong or unconfigured choice never leaves the user stuck with a broken provider — every dead end offers a one-click return to the local default.
- Zero model calls, zero network calls until the user picks the branch that needs them.
- One source of truth for provider copy, shared with Settings.

**Non-Goals:**

- Removing or restyling the Settings provider surface — it stays as-is and remains the way to change the choice later.
- Provisioning or installing anything on the personal host. The host provisioning package (`host/provision.sh`) stays a manual step; onboarding only points at it when the probe fails.
- A multi-step wizard, progress bar, or any UI outside the thread.
- Re-asking, nagging, or blocking. Asked once, ever.

## Decisions

### 1. App-handled cards are tagged on the `ChoiceBlock`, not tracked in a side table

`ChoiceBlock` gains an optional `handler?: string` tag (e.g. `"onboarding.compute"`, `"onboarding.host"`). `onChoiceSelect` in `App.tsx` checks it: tagged → dispatch to the onboarding module; untagged → the existing `sendToBot` / `sendToThread` path, unchanged.

*Alternatives considered.* Keeping a module-level `Set<messageId>` of onboarding cards — loses its contents on reload, so a card answered after an app restart would be sent to the model instead. Matching on the prompt string — fragile and untranslatable. A distinct message `kind` — heavier than needed and would ripple through the renderer; the card should look and behave exactly like every other question card.

Tagging on the persisted message means the routing decision survives restarts and rehydration, which is the property that actually matters here.

### 2. The answer still posts as a user message

The existing structured-choice requirement says selecting an option posts the answer as a normal user message. That stays true: the onboarding handler posts the user's answer into the thread and marks the card answered (collapsing it to a receipt) using the same store path the send flow uses — the only difference is that nothing is dispatched to the model afterwards, and the follow-up is composed locally. The shared "post answer + mark answered" step is extracted from the send path so the two callers cannot drift.

### 3. The flow is a small explicit state machine in `app/src/app/onboardingCompute.ts`

Steps: `ask-location → (host: scan → pick-host → verdict) | (fly: token check) | (local: done) → starter-tasks`. Each step is a pure function returning what to post (message text, optional `ChoiceBlock` with a `handler` tag) plus an effect to run (`setSessionProvider`, `hostDiscover`, `setHostTarget` + `hostProviderStatus`, `flyProviderStatus`). Keeping the step functions pure and the effects injected (the module takes its `sessionGlue`/native functions as dependencies, matching how the engine takes `chatStream`) is what makes the whole flow unit-testable in vitest without Tauri.

*Alternative considered.* Inlining the branches in `App.tsx`'s `onChoiceSelect`. Rejected: `App.tsx` is already the largest glue file, and the branch logic — scan results, probe verdicts, fallbacks — is exactly the part that needs tests.

### 4. Nothing scans the network until the user asks for it

`hostDiscover` runs only after the user picks "A machine I own". Scanning the local network on app start or on bot creation is a surprising side effect for a user who was never going to use that option. While the scan is in flight the thread shows a "Looking for machines on your network…" line; results arrive as chips in a follow-up card, with the free-text SSH field present in the card's inline own-answer slot (the field the card already has — no new input widget).

### 5. Discovered chips carry a username guess, and the probe is the verdict

`SessionSettings` already models this: a discovered host becomes `user@host`, saved and probed in one click, with the result shown as a badge. Onboarding reuses the same two-step (`setHostTarget` then `hostProviderStatus`) and renders the verdict as a sentence in the Bot's voice instead of a badge. When the probe fails, the follow-up card offers *Try another machine* (re-scan), *Enter the address myself* (inline field), and *Use this Mac for now* — never a dead end with only prose.

The username guess is the one place a click may not be enough: `SessionSettings` defaults to `user` when nothing was typed. Onboarding does better by seeding the local account name (`whoami` equivalent already available to the host layer) as the default, so the common case — same username on both machines — is genuinely one click, and the inline field covers the rest.

### 6. `fly` is never selected before its token is verified

Picking the cloud option calls `flyProviderStatus()` first. Only a non-`unconfigured` status calls `setSessionProvider("fly")`. Otherwise the provider is left at its current value and the Bot posts the one-line setup step (`FLY_API_TOKEN` in `keys/.env`) plus the local fallback chip. This mirrors the fail-soft rule already applied to the host branch and keeps the first-run state always usable.

### 7. Asked at most once, tracked by a persisted flag

A storage key (`onboarding.computeAsked`, alongside the existing `sessions.*` keys) is set when the card is seeded. `handleCreate` seeds the compute card only when that flag is unset — which also covers the "deleted every bot, made a new one" case, where re-asking would read as the app forgetting a decision the user already made. Settings remains the way to revisit it.

### 8. Provider copy lives in one module

The three options' titles and one-line consequences move to a shared constant consumed by both `SessionSettings.tsx` and the onboarding cards. Card copy is shorter than Settings copy, so the shared shape is `{ kind, title, oneLine, settingsBody }` rather than one string reused verbatim in two places with different space budgets.

## Risks / Trade-offs

- **A scan that finds nothing makes the best option look broken** → the empty result is phrased as a next step, not a failure ("I couldn't spot one — you can type its address, or I'll use this Mac for now"), with both as one-click/inline options in the same card.
- **The scan is slow enough to feel like a hang** → post the "looking…" line before starting, keep the previous card's receipt visible, and never block the composer; the user can type a task at any point during the flow.
- **The user answers the compute card by free text ("my nuc")** → the inline own-answer path is still available on every card, so the handler must treat unrecognized text as "decide later", post a one-line acknowledgement pointing at Settings, and move on to starter tasks rather than parsing prose.
- **Two paths can now mark a card answered** → mitigated by extracting the shared step (decision 2) instead of duplicating the store mutation; a regression here would silently double-post the user's answer, so it gets a direct test.
- **Onboarding drifts from Settings as providers change** → shared copy module (decision 8) plus a test asserting both surfaces offer the same set of `SessionKind`s.
- **Tagged handlers are a small extension point that could grow into ad-hoc app-driven conversations** → scoped deliberately: the tag namespace is `onboarding.*` in this change, and anything beyond first-run setup should earn its own spec rather than accreting here.

## Migration Plan

Additive; no data migration. Existing users have bots, so the `onboarding.computeAsked` flag is set on first launch after upgrade **when the roster is non-empty**, so no established user is asked retroactively. Rollback is removing the seeding call in `handleCreate`: tagged cards already in a thread degrade to ordinary question cards whose answers go to the model, which is inert rather than broken.

## Open Questions

- Should the compute card also appear for an existing user who has never opened Settings (i.e. still on the default local provider)? The migration rule above says no; a one-time nudge elsewhere in the UI would be a separate change.
- ~~Does the host layer already expose the local account name for the username guess (decision 5)?~~ **Resolved during implementation:** no binding exposes it, but `sessionLocalExec(botId, "whoami")` does the job through the existing sandboxed local-exec command — no new Rust, and it degrades to `user` outside Tauri or on any failure.

## Implementation Notes

- Decision 2 ("extract the shared answer step") turned out to need no extraction: `sendUserMessage` already posts the answer *and* marks every open card in the thread answered. The local handler calls it and then `markDelivered`, since nothing downstream will deliver a message the app itself is the recipient of. The drift risk the decision was guarding against never materialized — there is still exactly one implementation.
