# Add Onboarding Compute Choice

## Why

Where a bot's commands actually run — this Mac, a machine the user owns, or a cloud VM — is the single most consequential setup decision in the product, and today it is discoverable only by opening Settings and reading three radio buttons. A first-time user therefore lands on the default (sandboxed local Mac, every command approved) without ever learning that the always-on mini-PC on their desk is an option, which is exactly the configuration that makes persistent bots worth having (persistent logins, browsing, no idle cloud cost). The first bot already opens with a question card asking what to take on first; asking where it should work belongs in that same conversation, one click each, before the answer starts to matter.

## What Changes

- The **first** bot's introduction (created when the roster was empty) leads with an app-authored question card: "Where should I run commands?" with one-click options — *This Mac*, *A machine I own*, *A cloud VM* — ahead of the existing starter-task card. Subsequent bots never re-ask.
- Answering is handled **locally by the app**, not by a model turn: the answer posts as a normal user message (per the existing structured-choice requirement), the app applies it to the session provider, and the app posts the follow-up card in the bot's voice. No API key is needed to complete onboarding.
- Choosing *A machine I own* triggers a network scan and offers each discovered SSH host as a clickable chip (`user@host`), with a free-text field for a manual address; picking a chip saves the target and immediately reports a reachability verdict in-thread. Unreachable or no hosts found → the bot says so and offers *Use this Mac for now*, which is one click and leaves the door open.
- Choosing *A cloud VM* without `FLY_API_TOKEN` configured → the bot states the one-line setup step and offers *Use this Mac for now* rather than leaving a broken provider selected.
- The choice never blocks: a *Decide later* option (and simply ignoring the card) leaves the local default in place, and the starter-task card follows either way.
- Settings remains the canonical place to change the provider later; this change adds a first-run path to the same state, it does not move or remove the Settings surface.

## Capabilities

### New Capabilities

_None — this extends existing capabilities rather than introducing one._

### Modified Capabilities

- `agent-computer`: new requirement — the compute provider is chosen during first-run onboarding through in-thread one-click options (including discovered-host chips and a reachability verdict), with an always-available fallback to the local default when a chosen provider is unconfigured or unreachable.
- `bot-management`: new requirement — the first Bot's introduction leads with the compute-location question ahead of its starter-task card, and later Bots show only starter tasks. (Added alongside the pending "Bot introduction with starter options" requirement rather than rewriting it.)

## Impact

- `app/src/app/` — new onboarding-cards module (question definitions + local answer handling), wired into `App.tsx`'s create path (which today seeds the introduction) and its `onChoiceSelect` handlers, calling existing `sessionGlue` functions (`setSessionProvider`, `setHostTarget`, `hostProviderStatus`, `flyProviderStatus`) and `hostDiscover` from `lib/native`.
- `app/src/App.tsx` — seed the compute card for the first bot only; route answers to app-handled cards before the normal send path.
- No changes to `lib/sessions/` or the Rust host: every provider, the discovery command, and the reachability probe already exist.
- `app/src/app/SessionSettings.tsx` — unchanged behavior; may gain a shared options/copy source with the onboarding cards to avoid two divergent descriptions.
- Tests: colocated vitest for the new module and the first-bot-only seeding rule; an e2e pass through the first-run flow with the mocked Tauri bridge.
