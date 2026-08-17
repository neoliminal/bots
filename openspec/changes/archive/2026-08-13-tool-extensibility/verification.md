# Verification: tool-extensibility

Suites at completion: vitest 635/635 (49 files), Playwright e2e 11/11, `cargo test` 63/63.

## specs/tool-extensibility/spec.md

| Scenario | Evidence |
|---|---|
| Layers stay separate | Skills are prompt-only (`skills.ts` has no registry access); `skills.test.ts` "skill escalation inertness" proves enabling one grants nothing |
| Uniform registration | `mcpGlue.test.ts` "registers namespaced tools…": MCP tools land in the same `ToolRegistry` as built-ins and flow through the same `toToolDef` |
| Tool failure is survivable | `loop.ts` `executeCall` catches and returns `Error: …` strings; `mcpGlue.test.ts` "contains failures: error result (never throws)" |
| Restricted bot never sees the tool | `loop.test.ts` "never sends a policy-denied tool's schema to the model"; e2e `mcp.spec.ts` "a bot whose policy blocks external comms never sees the MCP tool" |
| Precondition hides rather than errors | `loop.test.ts` "hides tools whose available() probe reports false"; `chatGlue.test.ts` asserts web_fetch absent outside Tauri; Fly probe in `sessionGlue.ts` |
| Same tool, different bots | `policy.test.ts` "category rules override defaults" (external-comms allow for one bot, approve default for the other); approval path in `loop.test.ts` gated-tool tests |
| Floor beats configuration | `policy.test.ts` hard-floor suite (allow on payment/credential/bulk-delete still decides approve, via both category and tool-name rules) |
| Skill guides existing tools | `skills.test.ts` composeSystemPrompt tests: enabled skill bodies enter the prompt; budget/elision tests cover the bound |
| Skill cannot escalate | `skills.test.ts` "skill escalation inertness": denied tool stays invisible and denied with the rogue skill in the prompt |
| Zero-code tool addition | e2e `mcp.spec.ts` "register server, approve the gated call…": settings UI → namespaced tool offered → callable, no code changes |
| Server credential stays invisible | `mcp.rs` `child_env` resolves keys/.env values Rust-side; webview passes NAMES only (`mcpGlue.test.ts` persistence test); `child_env_rejects_missing_key_names` |
| Misbehaving server is contained | `mcp.rs` `crashed_server_read_reports_closed_stdout` + one-retry-then-disconnect in `mcp_call`; `mcpGlue.test.ts` containment test (tools hidden, others unaffected) |

## specs/task-execution/spec.md

| Scenario | Evidence |
|---|---|
| CLI available | `loop.test.ts` "appends CLI-first steering only when both a shell and MCP tools are visible" (`CLI_FIRST_GUIDANCE`); steering-not-enforcement per design D6 |
| No usable CLI, connector configured | e2e `mcp.spec.ts` full call flow (MCP path works when chosen); MCP descriptions carry the prefer-CLI line (`MCP_CLI_STEERING`, `mcpGlue.test.ts`) |
| No API exists / UI changed since last run | Computer use is the deferred desktop phase (project.md); requirement text preserved, no implementation in this change — unchanged from before |
| Path recorded on timeline | `worklog.test.ts` "records which execution path a step used via tool names"; session_exec audit lines in `sessionGlue.ts`; toolsUsed → capability card |

## specs/bot-management/spec.md

| Scenario | Evidence |
|---|---|
| Tightening autonomy | `policy.test.ts` "policy can tighten an allowed category to approve or deny" |
| Narrowing a Bot's tool policy | e2e `edit-bot.spec.ts` "tool access policy saves and persists"; `loop.test.ts` denied-schema test; `bots.test.ts` toolPolicy persistence + no-policy migration |

## Notes

- Spec fix during verification: the "Same tool, different bots" scenario originally used `workspace_delete`, which is a hard-floor category and can never be loosened to act-and-report — it now uses `send_email` (external-comms), which the floor rules permit.
- Behavior-compat check: category defaults reproduce pre-change gating exactly (`tools.test.ts` "gates only the sensitive tools (send_email, workspace_delete) via categories"); one deliberate change is web_fetch hidden (not erroring) outside Tauri, per "Precondition hides rather than errors".
