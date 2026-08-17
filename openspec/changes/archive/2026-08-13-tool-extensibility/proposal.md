# Proposal: tool-extensibility

## Why

Every bot currently sees one hard-coded tool list, gating is a per-tool boolean checked only at execution time, and there is no way to add a tool without editing `app/src/app/tools.ts` — while `task-execution` already promises "connectors/MCP where they exist" with nothing implementing it. Mature agent products (OpenClaw, Hermes Agent) converge on a three-layer model — tools (typed functions), skills (instruction packs), plugins (packaged capability bundles, with MCP as the zero-code path) — with tool *visibility* filtered per agent before the model ever sees a schema. Adopting that model now gives Bots per-bot capability control, user-extensible tooling, and a concrete home for the platform's CLI-first execution philosophy.

## What Changes

- **Tool policy pipeline**: replace the `gated: boolean` on `EngineTool` with (a) per-bot **visibility filtering** — a bot's model request only includes tools that survive the bot's tool policy (allow/deny, availability preconditions, environment checks) — and (b) a **policy hook** evaluated per call that returns allow / require-approval / deny, implementing the `human-handoff` autonomy matrix in one place. **BREAKING** for the internal `EngineTool` interface (all existing tools migrate).
- **Authored skills**: markdown instruction packs (SKILL.md-style) stored in the bot's workspace, listed/enabled per bot, and injected into the system prompt. Skills teach workflows; they add no capabilities. Complements `routines` (learned procedures) with an authored equivalent.
- **MCP client as the plugin layer**: the platform connects to user-configured MCP servers (stdio first), namespaces their tools into the registry, applies the same visibility/policy pipeline, and injects credentials at egress per `security`. No bespoke plugin SDK.
- **CLI-first execution preference**: where a job can be done either by an installed CLI in a compute session or by an MCP/connector tool, bots SHALL prefer the CLI path; MCP/connectors are the integration path for services without a usable CLI, and computer use remains the last resort. This reorders `task-execution`'s hybrid-execution preference.

## Capabilities

### New Capabilities
- `tool-extensibility`: The three-layer capability model (tools / skills / plugins): tool registry and schema, per-bot visibility filtering, policy-hook gating, authored skills, MCP server integration.

### Modified Capabilities
- `task-execution`: "Hybrid execution — connectors first, computer use everywhere else" becomes a three-step preference order: **CLI tools in a compute session first**, connectors/MCP second, computer use last.
- `bot-management`: bot configuration gains an explicit per-bot tool policy (which tools/tool groups and skills a bot may see and use), extending the existing "which connectors/sites the Bot may use" requirement.

## Impact

- `app/src/lib/engine/tools.ts` (EngineTool interface, ToolRegistry — breaking interface change), `app/src/app/tools.ts` (all built-in tools migrate), `app/src/lib/sessions/tools.ts` (session tools migrate; local-exec gating becomes policy-driven).
- New: skills loader (`lib/engine` + workspace integration), MCP client (Rust host `src-tauri` + TS bindings in `lib/native`), per-bot tool policy storage (`bot-management` UI + engine store).
- `buildSystemPrompt` (`lib/engine/engine.ts`) gains skill-pack injection and CLI-first steering guidance.
- Approval flow (`approvals.ts`, ApprovalCard) consumes policy-hook decisions instead of the static `gated` flag; behavior for existing tools is unchanged.
- No change to `human-handoff` requirements — the policy pipeline is its implementation, not a new contract.
