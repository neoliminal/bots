# Tasks: tool-extensibility

## 1. Policy core (design D1, D2)

- [x] 1.1 Add `lib/engine/policy.ts`: `ActionCategory` union, `ToolPolicy` type, `decide(bot, tool, args)` returning allow/approve/deny, hard-floor categories (payment, credential, bulk-delete) unconditionally approve-gated; unit tests including floor-cannot-be-loosened
- [x] 1.2 Change `EngineTool` in `lib/engine/tools.ts`: replace `gated: boolean` with `category: ActionCategory` and optional `available(): boolean`; update `ToolRegistry` accordingly
- [x] 1.3 Migrate all built-in tools (`app/tools.ts`) and session tools (`lib/sessions/tools.ts`) to categories reproducing today's effective gating exactly (workspace_delete → bulk-delete, send_email → external-comms, local session_exec → shell-local approve-gated, Fly exec allow); migrate `available()` from runtime "unavailable" error strings (web_fetch, Fly-without-token)
- [x] 1.4 Update run loop (`lib/engine/loop.ts`) and `approvals.ts` to consume policy decisions instead of `gated`; all existing loop/approval tests pass with unchanged behavior

## 2. Per-bot visibility (design D3)

- [x] 2.1 Add per-bot tool policy to bot config storage (engine `bots.ts` + persistence): allow/deny by tool name and category, default allow-all; hydration/migration test for bots saved without a policy
- [x] 2.2 Filter the tool list at request-build time (engine request builder): registry × bot policy × `available()`; test that a denied tool's schema never reaches the model request
- [x] 2.3 BotEditor UI: tool-policy section (tools/groups toggles, MCP servers once 5.x lands); e2e spec extending `edit-bot.spec.ts`

## 3. Authored skills (design D5)

- [x] 3.1 Skills loader in `lib/engine`: discover `skills/*/SKILL.md` in the bot workspace, parse frontmatter, enabled-list in bot config; unit tests including malformed frontmatter
- [x] 3.2 Inject enabled skills into `buildSystemPrompt` with character budget, deterministic priority order, elided-skills notice; tests for budget overflow behavior
- [x] 3.3 Skill escalation inertness test: a skill instructing use of a denied tool changes neither visibility nor policy decisions
- [x] 3.4 BotEditor: enabled-skills list surface (workspace files as source of truth)

## 4. CLI-first steering (design D6)

- [x] 4.1 Add execution-preference paragraph to composed system prompt when both session tools and MCP/connector tools are visible; unit test on prompt composition
- [x] 4.2 Prefix MCP tool descriptions with the prefer-CLI steering line in the adapter (depends on 5.3)
- [x] 4.3 Worklog/timeline records which path a step used (tool name suffices; verify rendering in DetailPanel)

## 5. MCP client (design D4)

- [x] 5.1 `src-tauri/src/mcp.rs`: spawn stdio server from user config (name, command, args, vault env), MCP initialize handshake, `tools/list`, `tools/call`, kill/restart on crash; Rust unit tests against a fixture echo server
- [x] 5.2 TS bindings in `lib/native`: `mcpListServers/mcpListTools/mcpCallTool`, no-op outside Tauri
- [x] 5.3 Registry adapter: wrap remote tools as `EngineTool` named `mcp__<server>__<tool>` (clamp >64 chars), default category external-comms, `available()` tied to server health; error-result (never throw) tests
- [x] 5.4 Server registration UI (settings): add/remove server, per-server tool filter; registering is user-initiated only
- [x] 5.5 E2e spec: mocked MCP server contributes a tool, visible only to a bot whose policy allows it, callable end-to-end with policy approval

## 6. Verification

- [x] 6.1 Full vitest + Playwright suites green; `cargo test` in src-tauri green
- [x] 6.2 Walk every scenario in the three delta specs against the implementation and note evidence per scenario
