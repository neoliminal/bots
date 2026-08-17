# Design: tool-extensibility

## Context

Today the tool surface is a single static registry (`appToolRegistry` in `app/src/app/tools.ts`): every bot sees every registered tool, gating is a per-tool `gated: boolean` checked at execution time by the run loop, and adding a tool means editing platform code. Session tools (`lib/sessions/tools.ts`) hard-code provider-dependent gating (local exec gated, Fly exec not). The `task-execution` spec promises connectors/MCP with no implementation, and there is no skills concept. OpenClaw and Hermes Agent demonstrate the convergent architecture this change adopts: tools / skills / plugins as separate layers, visibility filtered per agent before the model sees schemas, and gating as a policy hook rather than a flag.

## Goals / Non-Goals

**Goals:**
- One registry for built-in, session, and MCP-contributed tools with per-bot visibility filtering at request-build time.
- A single policy hook implementing the `human-handoff` autonomy matrix (allow / require-approval / deny) with hard floors that nothing can override.
- Authored skills: markdown packs enabled per bot, injected into the system prompt.
- MCP client (stdio) in the Tauri host as the plugin layer; credentials injected in Rust, never in the webview or model context.
- CLI-first steering: prompt guidance + tool descriptions that route jobs to session CLIs ahead of MCP tools.

**Non-Goals:**
- A bespoke plugin SDK / manifest format (OpenClaw-style) or a marketplace.
- SSE/HTTP MCP transports, sampling, or MCP resources/prompts (tools only, first pass).
- Learned skills (that is `routines`); per-tool-argument policy rules (category-level is enough now).
- Changing `human-handoff` requirements — this implements them.

## Decisions

**D1 — Policy replaces `gated`, evaluated in two places.**
`EngineTool` loses `gated: boolean` and gains `category: ActionCategory` (e.g. `workspace-read`, `workspace-mutate`, `shell-local`, `external-comms`, `payment`). A `ToolPolicy` object per bot resolves visibility (`isVisible(bot, tool)`) at request-build time and decisions (`decide(bot, tool, args) → allow | approve | deny`) at call time. The run loop consumes `approve` exactly where it consumed `gated: true` today, so `approvals.ts` and ApprovalCard are unchanged consumers. *Why categories, not per-tool config:* the `human-handoff` matrix is per action-category; per-tool flags re-scatter policy. *Alternative considered:* keeping `gated` and adding a separate allowlist — rejected because execution-time-only checks still burn model turns on tools the bot may not use, and two mechanisms drift.

**D2 — Hard floors live in the policy module, not tool definitions.**
Categories `payment`, `credential`, `bulk-delete` map to require-approval unconditionally in `lib/engine/policy.ts`; per-bot configuration can only tighten, never loosen, these. This mirrors Hermes's capability-consent model but keeps it in one auditable function.

**D3 — Visibility filtering happens where messages are built.**
The engine's request builder receives the bot's filtered tool list (registry × policy × environment availability). Availability is a per-tool `available(): boolean` (Hermes's `check_fn`) replacing today's runtime "unavailable outside the desktop app" error strings — e.g. Fly tools hidden without a token, `web_fetch`/`send_email` hidden outside Tauri.

**D4 — MCP client lives in the Rust host.**
A `mcp.rs` module spawns stdio servers (config: name, command, args, env-from-vault), does the MCP handshake, lists tools, and proxies calls; TS bindings in `lib/native` surface `mcpListTools`/`mcpCallTool`, and a registry adapter wraps each remote tool as an `EngineTool` named `mcp__<server>__<tool>` with category defaulting to `external-comms` (user can reclassify per server). *Why Rust, not the webview:* process spawning, credential injection away from the model/webview, and parity with where session exec already lives. Server crash ⇒ adapter marks tools unavailable (hidden on next request) and returns error results for in-flight calls.

**D5 — Skills are workspace files with a small manifest.**
`skills/<name>/SKILL.md` in the bot's workspace; frontmatter (name, description) + body. An enabled-skills list lives in bot config. `buildSystemPrompt` appends enabled skills under a "Skills" section, with a total character budget; over budget, bodies are replaced by name+description lines and the bot is told it can `workspace_read` the full text. Skills add no tools and are inert w.r.t. policy (D1/D2 run regardless of prompt content).

**D6 — CLI-first is steering, not enforcement.**
The preference order (CLI in session → MCP/connector → computer use) is implemented as (a) a paragraph in the composed system prompt when both session tools and MCP tools are visible, and (b) MCP tool descriptions prefixed with "Prefer an equivalent CLI in your compute session if one exists." *Why not hard routing:* the model is the only component that knows whether a CLI "can do the job"; blocking MCP calls mechanically would break services with no CLI. The task timeline records which path ran (tool names make this auditable).

## Risks / Trade-offs

- [Arbitrary MCP servers run as local processes] → stdio servers are user-registered only (no auto-discovery), spawned with the same sanitized env as session exec, and their tools pass the same policy hook; registering a server is itself a gated, user-initiated act.
- [Prompt-steered CLI preference may be ignored by weaker models] → acceptable: the fallback is a working MCP path; steering strength can be tuned in descriptions without spec changes.
- [Skills budget truncation could hide critical instructions] → deterministic order (user-defined priority), explicit in-prompt notice of elided skills, and skills remain readable via `workspace_read`.
- [Interface break ripples through tests] → `gated` is referenced in tool definitions and run-loop tests only; migration is mechanical (boolean → category) and each migrated tool keeps its current effective behavior.
- [Namespaced MCP tool names may exceed provider name limits] → clamp/hash names over 64 chars in the adapter.

## Migration Plan

1. Land policy module + `EngineTool` change with all built-in/session tools migrated in the same commit (no behavior change: categories chosen to reproduce today's gating exactly; default bot policy = allow-all-visible).
2. Land visibility filtering in the request builder (still no behavior change with default policy).
3. Land bot-management tool-policy UI + storage.
4. Land skills loader + prompt injection.
5. Land Rust MCP client + adapter + registration UI, then CLI-first steering text.
Rollback at any step is a revert; no persisted-data migrations exist until step 3, whose storage is additive (absent policy ⇒ allow-all default).

## Open Questions

- Should per-server MCP category reclassification ship in the first pass, or default everything to `external-comms` until a real need appears?
- Skill authoring UX: plain workspace files only, or a small editor surface in BotEditor from day one?
