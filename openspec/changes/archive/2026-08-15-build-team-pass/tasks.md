# Build Team Pass — Tasks

## 1. Thread model + group threads (messaging spec, "Group threads")

- [x] 1.1 Rework the chat store to a thread model: `Thread` entities (direct + group) in `threadsById`, messages keyed by threadId, direct thread id === botId for full backward compatibility
- [x] 1.2 v1 → v2 persistence migration (botId-keyed histories become direct threads, lossless), interrupted streams normalized to error on load
- [x] 1.3 Group thread management: `createGroupThread` (2+ deduped participants, title), `addParticipant` / `removeParticipant`, `ensureDirectThread`
- [x] 1.4 Bot-to-bot message support: `addBotMessage` (participant-checked, complete messages) and `authorBotId` attribution on every bot message; `MessageMeta` (`delegation` / `report` / `normal`, `targetBotId`)
- [x] 1.5 Sidebar sections: direct threads under "Bots", group threads under "Teams", selection by threadId, unread badges, "New Team" button
- [x] 1.6 ThreadView group rendering: per-message author name + avatar slot (by authorBotId), delegation/report badges ("Delegated to X" / "Report")
- [x] 1.7 App shell: create-team flow (TeamEditor modal — name + pick 2+ bots), group thread header with stacked member avatars, group composer + Stop, thread-based selection/fallback

## 2. Engine v2: tool loop, approvals, memory, delegation

- [x] 2.1 Tool registry (`EngineTool`, gated + coordinatorOnly flags) and OpenAI-style tool defs on the OpenRouter client
- [x] 2.2 `runLoop`: multi-round tool-calling loop with MAX_TOOL_ROUNDS budget + graceful wrap-up round, runtime transitions (thinking/talkingToUser/working/waitingOnUser/celebrating/error), abort settles to idle
- [x] 2.3 Approvals manager (human-handoff subset): gated calls park a PendingApproval, resolve allow/deny (+reason fed to the model), abort withdraws; shared `botApprovals`
- [x] 2.4 Memory lite (bot-memory subset): per-bot persistent entries, remember/forget tools, MEMORY section in the system prompt, MemoryPanel editing
- [x] 2.5 Delegation tool (`send_to_bot`, coordinator-only): DelegationRequest emitted through injected DelegateFn, sender shows talkingToBot while awaiting

## 3. App tools (task-execution safe-action boundaries)

- [x] 3.1 Rust: per-bot sandboxed workspace fs (list/read/write/delete, path-guarded, 5MB caps), SSRF-guarded https web_fetch (timeouts/size caps/HTML stripped)
- [x] 3.2 `src/lib/native`: typed bindings that no-op outside Tauri
- [x] 3.3 App tool registry: workspace_list/read/write autonomous; workspace_delete GATED; web_fetch autonomous (https only); send_email GATED (mock transport); memory tools autonomous
- [x] 3.4 chatGlue on engine v2: per-bot serialized deliveries, streamed replies, usage accounting across tool rounds, cancel withdraws approvals

## 4. EA lite (multi-bot-collaboration, local subset)

- [x] 4.1 "Team coordinator" toggle in Bot settings (engine `isCoordinator`; single-coordinator enforced on save)
- [x] 4.2 Group messages route to the coordinator participant (else first participant); group history maps teammate messages as attributed user turns
- [x] 4.3 Delegation glue: DelegationRequest → visible `delegation` message in the same group thread → target bot runs the delegated brief with its own persona/memory/tools on its serial queue → reply posted as `report` message → promise resolves so the coordinator synthesizes
- [x] 4.4 Avatars: coordinator talkingToBot while awaiting; target handoff → thinking → talkingToUser cycle
- [x] 4.5 Approvals from ANY bot in a delegation surface to the user on the shared manager with the group threadId — the coordinator can never approve (spec: "Coordinator cannot bypass human gates")
- [x] 4.6 Delegation errors (unknown teammate, paused target, failed run) surface to the coordinator's model as tool error results

## 5. Notifications (notifications spec, native subset)

- [x] 5.1 Native notify binding (plugin-notification, permission-on-first-use, no-op outside Tauri)
- [x] 5.2 Fire ONLY while the window is unfocused: approval pending (blocking) and bot finished a task in a non-active thread (notable); progress stays quiet
- [x] 5.3 Approval watcher on the shared manager (no replay of already-parked approvals, idempotent init); clicking = best-effort app focus (no deep routing yet)

## 6. Tray + dock (mac-app-shell subset)

- [x] 6.1 Rust tray: per-bot disabled status lines, "Pause All Bots" / "Open Bots" actions (events `tray://pause-all`, `tray://open`; open shows/focuses the window)
- [x] 6.2 Shell glue: tray menu kept in sync with per-bot name + runtime status via `tray_update`, debounced across state/roster bursts
- [x] 6.3 `tray://pause-all` pauses every active bot (engine paused + sleeping runtime)
- [x] 6.4 Dock badge = pending approvals count (cleared at zero)

## 7. Verification

- [x] 7.1 `npx vitest run` green (366 tests, 32 files) — including new coverage: delegation flow, group routing, notifications policy, shell/tray, TeamEditor, ThreadView badges, App team flow
- [x] 7.2 `npx tsc --noEmit` clean
- [x] 7.3 `npm run build` clean
- [x] 7.4 `cargo check` clean
- [x] 7.5 `npx playwright test` green (7 specs) — new `team.spec.ts` covers create-team + coordinator-attributed group reply
