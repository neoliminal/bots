// Glue between the compute-session layer (src/lib/sessions) and the app:
// provider selection (local default / Fly Machines), session tool
// registration in the app tool registry, thread-timeline session events,
// idle auto-stop, and best-effort teardown on app quit.
//
// Spec: openspec/specs/agent-computer/spec.md —
// - "On-demand session provisioning": nothing here provisions eagerly; the
//   first session tool call acquires a session through the SessionManager
//   and the only user-visible trace is the timeline indicator.
// - "Isolation and hygiene": commands are recorded in the audit log (by the
//   run loop, whether or not they needed approval), NOT in the thread. What
//   reaches the thread is one lifecycle line per session and warnings the
//   user can act on — a sync-back that skipped files.
// - "Ephemeral by default": the SessionManager idle timer auto-stops
//   sessions (default 10 minutes); app quit stops all sessions best-effort.

import { chatStore, type SessionEventKind } from "../features/chat";
import type { ToolRegistry } from "../lib/engine";
import {
  BROWSE_TOOL_NAMES,
  createBrowseTools,
  createSessionTools,
  FlySessionProvider,
  HostSessionProvider,
  LocalSessionProvider,
  SessionManager,
  SyncEngine,
  type SessionKind,
  type SessionProvider,
  type SessionStatus,
  type SessionStatusEvent,
} from "../lib/sessions";
import { hostSetTarget } from "../lib/native";
import { createLocalStorage, type KeyValueStorage } from "../lib/storage";
import { appToolRegistry } from "./tools";

/** Storage key holding the user's session-provider choice. */
export const SESSION_PROVIDER_KEY = "sessions.provider";

/** Storage key holding the personal host's SSH target (`user@host`). */
export const SESSION_HOST_TARGET_KEY = "sessions.hostTarget";

/** In-memory copy of the persisted SSH target ("" = not configured). */
let hostTarget = "";

/** Names of the tools this glue registers (replaced on provider switch). */
export const SESSION_TOOL_NAMES = [
  "session_exec",
  "session_read_file",
  "session_write_file",
] as const;

interface SessionRuntime {
  kind: SessionKind;
  provider: SessionProvider;
  manager: SessionManager;
  sync: SyncEngine;
  unsubscribe: () => void;
}

let runtime: SessionRuntime | null = null;
let storage: KeyValueStorage = createLocalStorage();
let registry: ToolRegistry = appToolRegistry;

/**
 * The thread each bot's latest session tool call ran in — session lifecycle
 * events (which only carry a botId) are posted to this thread's timeline.
 * Falls back to the bot's direct thread (its id) before any call is seen.
 */
const lastSessionThread = new Map<string, string>();

/** Bots whose session has stopped at least once (labels warm restarts). */
const everStopped = new Set<string>();

function timelineThreadFor(botId: string): string {
  return lastSessionThread.get(botId) ?? botId;
}

function postTimelineEvent(
  botId: string,
  threadId: string,
  text: string,
  sessionEvent: SessionEventKind,
  kind: SessionKind,
  command?: string,
): void {
  chatStore.getState().addTimelineEvent(threadId, botId, text, {
    kind: "session",
    sessionEvent,
    sessionKind: kind,
    ...(command !== undefined ? { command } : {}),
  });
}

/** Session lifecycle events → subtle thread-timeline indicators. */
function handleStatusEvent(event: SessionStatusEvent): void {
  const threadId = timelineThreadFor(event.botId);
  const where =
    event.kind === "fly"
      ? "cloud"
      : event.kind === "host"
        ? "personal host"
        : "local";
  if (event.status === "running") {
    const warm = everStopped.has(event.botId);
    postTimelineEvent(
      event.botId,
      threadId,
      warm
        ? `Compute session warm-resumed (${where})`
        : `Compute session provisioned (${where})`,
      warm ? "warm-resumed" : "provisioned",
      event.kind,
    );
  } else if (event.status === "stopped") {
    everStopped.add(event.botId);
    postTimelineEvent(
      event.botId,
      threadId,
      `Compute session stopped (${where})`,
      "stopped",
      event.kind,
    );
  }
}

function buildProvider(kind: SessionKind): SessionProvider {
  if (kind === "fly") return new FlySessionProvider();
  if (kind === "host") return new HostSessionProvider(hostTarget);
  return new LocalSessionProvider();
}

/**
 * Cached Fly readiness for the session tools' availability probe: null =
 * not yet known (treated as available so tools aren't hidden spuriously),
 * false = provider reported "unconfigured" (no FLY_API_TOKEN) — the tools
 * hide from every bot's next request instead of failing at call time.
 */
let flyConfigured: boolean | null = null;

/**
 * Activate a provider: tear down the previous one (stopping its sessions
 * best-effort), build the provider/sync/manager stack, subscribe timeline
 * events, and (re-)register the session tools — wrapped so every call notes
 * its thread (timeline routing) and every session_exec command lands in the
 * task record as an audit entry.
 */
function activateProvider(kind: SessionKind): SessionRuntime {
  if (runtime) {
    runtime.unsubscribe();
    void runtime.manager.stopAll().catch(() => {
      // Best-effort: an unreachable provider must not block switching.
    });
  }

  const provider = buildProvider(kind);
  const sync = new SyncEngine(provider);
  const manager = new SessionManager(provider);
  const unsubscribe = manager.onStatus(handleStatusEvent);

  if (kind === "fly") {
    flyConfigured = null;
    void flyProviderStatus()
      .then((status) => {
        flyConfigured = status !== "unconfigured";
      })
      .catch(() => {
        // Status probe failure is not proof of misconfiguration; keep the
        // tools offered and let call-time errors surface the real problem.
        flyConfigured = null;
      });
  }

  // Browse tools only exist on the personal host: drop any leftovers from
  // a previous provider before (re-)registering.
  for (const name of BROWSE_TOOL_NAMES) registry.unregister(name);

  const tools = [
    ...createSessionTools(sessionToolDeps(kind, provider, manager, sync)),
    ...(kind === "host" ? createBrowseTools({ provider, manager }) : []),
  ];
  for (const tool of tools) {
    registry.register({
      ...tool,
      run: (args, ctx) => {
        // Commands do not appear in the thread (agent-computer spec,
        // "Isolation and hygiene"): the conversation carries the bot's own
        // account of its work, not a console. Every call is recorded in the
        // audit log by the run loop — see the Activity log in Settings.
        // This wrapper still tracks which thread the work belongs to, so
        // lifecycle events and sync warnings land in the right place.
        lastSessionThread.set(ctx.bot.id, ctx.threadId);
        return tool.run(args, ctx);
      },
    });
  }

  runtime = { kind, provider, manager, sync, unsubscribe };
  return runtime;
}

function sessionToolDeps(
  kind: SessionKind,
  provider: SessionProvider,
  manager: SessionManager,
  sync: SyncEngine,
) {
  return {
    provider,
    manager,
    sync,
    ...(kind === "fly"
      ? { available: () => flyConfigured !== false }
      : {}),
    // Partial sync-back (skipped files) surfaces as a visible warning on
    // the task timeline of the thread the exec ran in.
    onSyncFailures: (botId: string, threadId: string, failures) => {
      const detail = failures
        .map((f) => `${f.path} (${f.error})`)
        .join("; ");
      postTimelineEvent(
        botId,
        threadId,
        `Warning: sync-back skipped ${failures.length} file${
          failures.length === 1 ? "" : "s"
        }: ${detail}`,
        "sync-warning",
        kind,
      );
    },
  } satisfies Parameters<typeof createSessionTools>[0];
}

/**
 * Initialize sessions at bootstrap: read the persisted provider choice
 * (default "local") and activate it. Idempotent — repeated calls keep the
 * already-active runtime.
 */
export async function initSessions(options?: {
  registry?: ToolRegistry;
  storage?: KeyValueStorage;
}): Promise<void> {
  if (options?.registry) registry = options.registry;
  if (options?.storage) storage = options.storage;
  if (runtime) return;
  const stored = await storage.get<string>(SESSION_PROVIDER_KEY);
  hostTarget = (await storage.get<string>(SESSION_HOST_TARGET_KEY)) ?? "";
  // Pin the target host-side before any command can run. The Rust layer
  // refuses every other SSH target, so a bot cannot aim the user's SSH agent
  // at some other machine on the LAN or at loopback.
  await pinHostTarget(hostTarget);
  activateProvider(stored === "fly" || stored === "host" ? stored : "local");
}

/** The active session provider kind ("local" until initialized). */
export function getSessionProviderKind(): SessionKind {
  return runtime?.kind ?? "local";
}

/** The active session manager (undefined before initSessions). */
export function getSessionManager(): SessionManager | undefined {
  return runtime?.manager;
}

/**
 * Switch the session provider (Settings). Stops the previous provider's
 * sessions best-effort, re-registers the session tools against the new
 * provider (local exec is gated; Fly exec is not), and persists the choice.
 */
export async function setSessionProvider(kind: SessionKind): Promise<void> {
  if (runtime?.kind === kind) return;
  activateProvider(kind);
  await storage.set(SESSION_PROVIDER_KEY, kind);
}

/**
 * Fly provider readiness for the Settings surface: "unconfigured" without a
 * FLY_API_TOKEN in keys/.env; "none" (no session yet) when configured.
 */
export async function flyProviderStatus(): Promise<SessionStatus> {
  return new FlySessionProvider().providerStatus();
}

/** The personal host's SSH target ("" when not configured). */
export function getHostTarget(): string {
  return hostTarget;
}

/**
 * Set (and persist) the personal host's SSH target. If the host provider is
 * active, it is re-activated so sessions and tools bind to the new target.
 */
export async function setHostTarget(target: string): Promise<void> {
  hostTarget = target.trim();
  await storage.set(SESSION_HOST_TARGET_KEY, hostTarget);
  await pinHostTarget(hostTarget);
  if (runtime?.kind === "host") activateProvider("host");
}

/**
 * Tell the Rust layer which SSH target is permitted. Failing to pin must not
 * break settings persistence — host_exec simply keeps refusing, which is the
 * safe direction.
 */
async function pinHostTarget(target: string): Promise<void> {
  try {
    await hostSetTarget(target);
  } catch (err) {
    console.error("[sessions] failed to pin the personal-host target:", err);
  }
}

/**
 * Personal-host readiness for the Settings surface: "unconfigured" without
 * an SSH target; otherwise a live reachability probe (`echo ok` over ssh).
 */
export async function hostProviderStatus(): Promise<SessionStatus> {
  return new HostSessionProvider(hostTarget).providerStatus();
}

/** Stop every active session, best-effort (app quit / pause-all). */
export async function stopAllSessions(): Promise<void> {
  if (!runtime) return;
  await runtime.manager.stopAll().catch(() => {
    // Best-effort by contract: files are already local (sync-back), so a
    // failed stop costs nothing but idle compute until the provider reaps it.
  });
}

/** Test helper: drop all session-glue state (does not stop sessions). */
export function resetSessionsForTest(): void {
  runtime?.unsubscribe();
  runtime = null;
  registry = appToolRegistry;
  storage = createLocalStorage();
  hostTarget = "";
  lastSessionThread.clear();
  everStopped.clear();
}
