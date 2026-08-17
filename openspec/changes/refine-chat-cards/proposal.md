# Refine Chat Cards

## Why

The new Design Pillar (openspec/project.md): minimize the human's typing and mental load even when it costs the AI more work. A review of our shipped screens showed four places where our shipped UI still asks humans to type or scan more than needed: chips don't collapse to receipts or take an inline typed answer, a bot waiting on the user is invisible in the sidebar, template import leads with a paste box, and personal-host setup requires typing an SSH target the machine could discover.

## What Changes

- **Question cards**: upgrade choice chips to titled cards — letter badges (A/B/C…) on options, an inline "type your own answer" field inside the card, and an answered state that collapses to a receipt (chosen option + checkmark) instead of dimmed buttons.
- **Sidebar waiting states**: a bot in `waitingOnUser` shows an amber "Waiting for you…" status line and amber dot on its sidebar row, so attention needs are visible without opening the thread.
- **Template import, file-first**: "Import template…" opens the file picker directly (one click); paste-JSON remains as a secondary path.
- **Personal-host discovery**: a "Scan network" action in Settings discovers SSH hosts (mDNS/Bonjour) and offers them as clickable choices that prefill the target field; typing remains the fallback.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `messaging`: "Structured choice prompts" requirement updated — question-card presentation, inline own-answer, receipt collapse; new requirement for waiting-state visibility in the thread list.
- `agent-computer`: "Personal host sessions" gains a discovery scenario — reachable hosts are offered as choices, not typed.

## Impact

- `app/src/features/chat/ThreadView.tsx` (+ store answered-state, + tests), `Sidebar.tsx` (+ tests).
- `app/src/app/BotEditor.tsx` import affordance reorder (+ tests).
- `app/src-tauri/src/host.rs` `host_discover` command; `lib/native` binding; `SessionSettings.tsx` scan UI (+ tests).
- No breaking changes; chips marker format unchanged.
