// Append-only audit log.
// Spec: openspec/specs/security/spec.md, "Comprehensive audit log" — every
// external action a Bot takes, every human intervention, every
// configuration/autonomy change, exportable, with no secret material in it.
//
// Local-first shape for the desktop app: entries are appended in memory,
// persisted through the engine's StorageLike adapter, and capped by count
// (the spec's 1-year retention is a cloud-tier concern; the cap is stated in
// the export header so a reader is never misled about completeness).
//
// The log is APPEND-ONLY by construction: the store exposes no update or
// delete for individual entries, only `clear` (a deliberate, user-initiated
// wipe that itself records an entry).
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import type { PolicyDecision } from "./policy";
import type { StorageLike } from "./types";

export const AUDIT_STORAGE_KEY = "engine.audit";

/** Entries retained before the oldest are dropped. */
export const AUDIT_LOG_LIMIT = 5000;

export type AuditEventKind =
  /** A tool call ran without needing a human (policy said allow). */
  | "tool.allowed"
  /** A tool call ran after the user approved it. */
  | "tool.approved"
  /** The user denied a parked tool call. */
  | "tool.denied"
  /** Policy refused the call outright; it never ran. */
  | "tool.refused"
  /** A call was blocked by a revoked grant, a pause, or a stop. */
  | "tool.blocked"
  /** Connector authorization recorded or revoked. */
  | "grant.recorded"
  | "grant.revoked"
  /** Bot configuration or autonomy settings changed. */
  | "config.changed";

export interface AuditEvent {
  id: string;
  /** Epoch ms. */
  at: number;
  kind: AuditEventKind;
  /** Acting bot, when the event has one. */
  botId?: string;
  botName?: string;
  /** Thread the action belonged to. */
  threadId?: string;
  /** Tool name for tool.* events. */
  toolName?: string;
  /** Delegation chain ending in the acting bot, oldest first. */
  chain?: string[];
  /** One-line human-readable summary. Never contains secret values. */
  summary: string;
  /** Free-form extra detail (reason text, category, policy decision). */
  detail?: string;
}

export interface AuditState {
  events: AuditEvent[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Append one entry. Returns the stored event (with id and timestamp). */
  record: (event: Omit<AuditEvent, "id" | "at"> & { at?: number }) => AuditEvent;
  /** Newest first, optionally filtered by bot. */
  list: (botId?: string) => AuditEvent[];
  /** Deliberate user-initiated wipe; records that it happened. */
  clear: () => void;
}

export type AuditStore = UseBoundStore<StoreApi<AuditState>>;

/** Minimal sink the run loop depends on (tests pass a fake). */
export interface AuditSink {
  record: AuditState["record"];
}

function createAuditStoreWith(getStorage: () => StorageLike): AuditStore {
  const persist = (events: AuditEvent[]): void => {
    void getStorage()
      .set(AUDIT_STORAGE_KEY, events)
      .catch((err: unknown) => {
        console.error("[engine] failed to persist audit log:", err);
      });
  };

  return create<AuditState>()((set, get) => ({
    events: [],
    hydrated: false,

    hydrate: async () => {
      const stored = await getStorage().get<AuditEvent[]>(AUDIT_STORAGE_KEY);
      set({ events: stored ?? [], hydrated: true });
    },

    record: (event) => {
      const stored: AuditEvent = {
        ...event,
        id: makeId("audit"),
        at: event.at ?? Date.now(),
      };
      // Newest last in storage order; trimming drops the OLDEST.
      const events = [...get().events, stored].slice(-AUDIT_LOG_LIMIT);
      set({ events });
      persist(events);
      return stored;
    },

    list: (botId) => {
      const all = [...get().events].reverse();
      return botId === undefined ? all : all.filter((e) => e.botId === botId);
    },

    clear: () => {
      const marker: AuditEvent = {
        id: makeId("audit"),
        at: Date.now(),
        kind: "config.changed",
        summary: "Activity log cleared by the user",
      };
      set({ events: [marker] });
      persist([marker]);
    },
  }));
}

/** Build an isolated audit store bound to a specific adapter (tests). */
export function createAuditStore(storage: StorageLike): AuditStore {
  return createAuditStoreWith(() => storage);
}

/** App-wide audit log; uses whatever adapter configureEngineStorage set. */
export const auditLog: AuditStore = createAuditStoreWith(() => getEngineStorage());

/** Map a policy decision to the kind recorded when the call proceeds. */
export function kindForDecision(decision: PolicyDecision): AuditEventKind {
  if (decision === "deny") return "tool.refused";
  if (decision === "approve") return "tool.approved";
  return "tool.allowed";
}

function formatTimestamp(at: number): string {
  return new Date(at).toISOString();
}

/**
 * Render the log as plain text for export. States the cap and the range up
 * front so a reader can tell a complete history from a trimmed one.
 */
export function exportAuditLog(events: readonly AuditEvent[]): string {
  const header = [
    "Bots — activity log export",
    `Generated: ${formatTimestamp(Date.now())}`,
    `Entries: ${events.length}${
      events.length >= AUDIT_LOG_LIMIT
        ? ` (at the ${AUDIT_LOG_LIMIT}-entry cap — older entries were dropped)`
        : ""
    }`,
    "No credential, token, or key values are recorded.",
    "",
  ].join("\n");

  const lines = [...events]
    .sort((a, b) => a.at - b.at)
    .map((e) => {
      const who = e.botName ?? e.botId ?? "—";
      const parts = [formatTimestamp(e.at), e.kind, who, e.summary];
      if (e.detail !== undefined && e.detail !== "") parts.push(`(${e.detail})`);
      return parts.join("\t");
    });

  return `${header}${lines.join("\n")}\n`;
}
