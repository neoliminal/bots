# Tasks — Add Onboarding Compute Choice

## 1. Shared provider copy

- [x] 1.1 New `app/src/app/computeOptions.ts`: one exported list of `{ kind, title, cardLabel, oneLine, settingsBody }` for local / host / fly, plus the fallback copy ("Use this Mac for now") and an answer→kind resolver
- [x] 1.2 Point `SessionSettings.tsx` at it (titles + `settingsBody`), leaving its behavior and test ids unchanged
- [x] 1.3 Test: both surfaces cover the same set of `SessionKind`s (guards drift when a provider is added)

## 2. Chat plumbing for app-handled cards

- [x] 2.1 `features/chat/store.ts`: optional `handler?: string` on `ChoiceBlock`, carried through `attachChoices` and persistence
- [x] 2.2 Reuse the send path's answer step rather than extracting one — `sendUserMessage` already posts the answer *and* marks open cards answered, so the local handler calls it plus `markDelivered` (nothing downstream will deliver an app-answered message). Tests cover "exactly one user message" and the tag surviving a storage roundtrip

## 3. Onboarding flow module

- [x] 3.1 New `app/src/app/onboardingCompute.ts`: step functions over an injected `OnboardingDeps` (`setSessionProvider` / `setHostTarget` / `hostProviderStatus` / `flyProviderStatus` / `hostDiscover` / `localUserName`), posting through an `OnboardingCtx`
- [x] 3.2 Local branch: select local, acknowledge in one line, hand off to starter tasks
- [x] 3.3 Host branch: post the "looking…" line, run discovery, offer discovered hosts as chips (username from `whoami` via `sessionLocalExec`, else `user`), save + probe on selection, post the reachability verdict
- [x] 3.4 Host failure paths: no hosts found, probe unreachable, and unparseable text — each ends in a card offering *Look again* / *Use this Mac for now*, never prose alone
- [x] 3.5 Fly branch: `flyProviderStatus()` first; select `fly` only when configured, otherwise post the one-line `FLY_API_TOKEN` step + local fallback chip without changing the provider
- [x] 3.6 Unrecognized free-text answers are treated as "decide later": one-line acknowledgement pointing at Settings, then starter tasks
- [x] 3.7 Tests for every branch with fake dependencies (no Tauri, no network, no model), including thrown discovery/probe/status calls

## 4. Wiring in App.tsx

- [x] 4.1 `handleCreate`: when the roster was empty and `onboarding.computeAsked` is unset, seed the compute card ahead of the starter-task card and set the flag; otherwise seed starter tasks as today
- [x] 4.2 Bootstrap: `initOnboarding({ hasBots })` sets the flag on first run when the roster is already non-empty, so existing users are never asked retroactively
- [x] 4.3 Direct-thread `onChoiceSelect` routes `handler`-tagged cards to `onboardingCompute`; everything else takes the unchanged send path. The group-thread handler is untouched — onboarding cards only ever exist in the first bot's direct thread
- [x] 4.4 Starter-task card is posted after the flow settles (any branch, including skip), so the first instruction stays one click away
- [x] 4.5 Tests: first bot gets both cards in order, second bot gets only starter tasks, composer stays usable throughout the flow, and `chatStream` is never called

## 5. Verification

- [x] 5.1 `npm test` (888 passing) + `tsc --noEmit` clean
- [x] 5.2 E2E `e2e/onboarding-compute.spec.ts`: 4 specs over the found / unreachable / not-found / second-bot paths, with `host_discover` + `host_exec` + `session_local_exec` added to the mocked Tauri bridge and a `setHostState` helper. All pass. Pre-existing failures in `avatar-gallery`, `chat`, `create-bot`, `edit-bot` were verified against a clean tree (`git stash`) and are unrelated to this change
- [ ] 5.3 Manual pass in `npm run tauri dev` against the real host — user-run
