// Session lifecycle store: per-bot active session, idle auto-stop timer,
// and status events for the UI.
// Spec: openspec/specs/agent-computer/spec.md — "Ephemeral by default":
// sessions auto-stop after an idle timeout (default 10 minutes); nothing
// depends on a session surviving, because files are already local.
import type {
  SessionKind,
  SessionProvider,
  SessionStatus,
  SessionStatusEvent,
} from "./types";

/** Default idle auto-stop timeout: 10 minutes. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export interface SessionManagerOptions {
  /** Idle auto-stop timeout in ms (default 10 minutes). */
  idleMs?: number;
}

interface Entry {
  sessionId: string;
  status: SessionStatus;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Shared in-flight provision, so concurrent acquires coalesce. */
  provisioning?: Promise<string>;
}

/**
 * Tracks at most one active session per bot on top of a SessionProvider.
 *
 * - `acquire(botId)` provisions on first use and reuses the running session
 *   afterwards; concurrent calls share one provision.
 * - Every acquire/touch resets the idle timer; when it expires the session
 *   is stopped automatically (files are already synced — see sync.ts).
 * - Status transitions are emitted to `onStatus` subscribers for the UI
 *   (task-timeline session indicator).
 */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: SessionStatusEvent) => void>();

  constructor(
    private readonly provider: SessionProvider,
    private readonly options: SessionManagerOptions = {},
  ) {}

  get kind(): SessionKind {
    return this.provider.kind;
  }

  get idleMs(): number {
    return this.options.idleMs ?? DEFAULT_IDLE_MS;
  }

  /** Subscribe to status events; returns an unsubscribe function. */
  onStatus(listener: (event: SessionStatusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(botId: string, sessionId: string | null, status: SessionStatus): void {
    const event: SessionStatusEvent = {
      botId,
      sessionId,
      status,
      kind: this.provider.kind,
    };
    for (const listener of this.listeners) listener(event);
  }

  /** Current session record for a bot, if any. */
  get(botId: string): { sessionId: string; status: SessionStatus } | undefined {
    const entry = this.entries.get(botId);
    if (!entry || entry.status === "provisioning") return undefined;
    return { sessionId: entry.sessionId, status: entry.status };
  }

  /**
   * Return the bot's running session id, provisioning one when needed.
   * Resets the idle auto-stop timer.
   */
  async acquire(botId: string): Promise<string> {
    const existing = this.entries.get(botId);
    if (existing?.status === "running") {
      this.touch(botId);
      return existing.sessionId;
    }
    if (existing?.provisioning) return existing.provisioning;

    const provisioning = (async () => {
      this.emit(botId, null, "provisioning");
      try {
        const result = await this.provider.provision(botId);
        this.entries.set(botId, {
          sessionId: result.sessionId,
          status: "running",
        });
        this.emit(botId, result.sessionId, "running");
        this.touch(botId);
        return result.sessionId;
      } catch (error) {
        this.entries.delete(botId);
        this.emit(botId, null, "error");
        throw error;
      }
    })();
    this.entries.set(botId, {
      sessionId: "",
      status: "provisioning",
      provisioning,
    });
    return provisioning;
  }

  /** Reset the idle auto-stop timer for a bot's running session. */
  touch(botId: string): void {
    const entry = this.entries.get(botId);
    if (!entry || entry.status !== "running") return;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.stop(botId).catch(() => {
        // Idle teardown failures are non-fatal: the session will be
        // replaced on next acquire anyway (interruption tolerance).
      });
    }, this.idleMs);
  }

  /** Stop a bot's session (idle teardown or explicit). */
  async stop(botId: string, opts?: { destroy?: boolean }): Promise<void> {
    const entry = this.entries.get(botId);
    if (!entry || entry.status !== "running") return;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    const { sessionId } = entry;
    this.entries.delete(botId);
    try {
      await this.provider.stop(sessionId, { destroy: opts?.destroy });
      this.emit(botId, sessionId, "stopped");
    } catch (error) {
      this.emit(botId, sessionId, "error");
      throw error;
    }
  }

  /** Stop every active session (app shutdown / pause-all). */
  async stopAll(): Promise<void> {
    const botIds = [...this.entries.keys()];
    await Promise.allSettled(botIds.map((botId) => this.stop(botId)));
  }
}
