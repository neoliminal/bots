// Audit log tests.
// Spec: openspec/specs/security/spec.md, "Comprehensive audit log".
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  AUDIT_LOG_LIMIT,
  AUDIT_STORAGE_KEY,
  createAuditStore,
  exportAuditLog,
  kindForDecision,
  type AuditEvent,
} from "./audit";

function entry(summary: string, at: number): Omit<AuditEvent, "id"> {
  return { at, kind: "tool.allowed", summary, botId: "b1", botName: "Scout" };
}

describe("audit store", () => {
  it("appends entries and lists them newest first", () => {
    const store = createAuditStore(createMemoryStorage());
    store.getState().record(entry("first", 1));
    store.getState().record(entry("second", 2));
    expect(store.getState().list().map((e) => e.summary)).toEqual(["second", "first"]);
  });

  it("stamps an id and a timestamp", () => {
    const store = createAuditStore(createMemoryStorage());
    const stored = store.getState().record({ kind: "tool.allowed", summary: "x" });
    expect(stored.id).not.toBe("");
    expect(stored.at).toBeGreaterThan(0);
  });

  it("filters by bot", () => {
    const store = createAuditStore(createMemoryStorage());
    store.getState().record({ kind: "tool.allowed", summary: "a", botId: "b1" });
    store.getState().record({ kind: "tool.allowed", summary: "b", botId: "b2" });
    expect(store.getState().list("b1").map((e) => e.summary)).toEqual(["a"]);
  });

  it("persists across hydrate", async () => {
    const storage = createMemoryStorage();
    createAuditStore(storage).getState().record(entry("kept", 1));
    const reloaded = createAuditStore(storage);
    await reloaded.getState().hydrate();
    expect(reloaded.getState().list().map((e) => e.summary)).toEqual(["kept"]);
    expect(await storage.get(AUDIT_STORAGE_KEY)).toHaveLength(1);
  });

  it("drops the OLDEST entries at the cap, never the newest", () => {
    const store = createAuditStore(createMemoryStorage());
    for (let i = 0; i < AUDIT_LOG_LIMIT + 10; i += 1) {
      store.getState().record(entry(`e${i}`, i));
    }
    const events = store.getState().list();
    expect(events).toHaveLength(AUDIT_LOG_LIMIT);
    expect(events[0]?.summary).toBe(`e${AUDIT_LOG_LIMIT + 9}`);
    expect(events.some((e) => e.summary === "e0")).toBe(false);
  });

  it("exposes no way to edit or remove a single entry (append-only)", () => {
    const store = createAuditStore(createMemoryStorage());
    const api = store.getState() as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "remove", "delete", "edit", "replace"]) {
      expect(api[forbidden]).toBeUndefined();
    }
  });

  it("records the wipe itself when cleared", () => {
    const store = createAuditStore(createMemoryStorage());
    store.getState().record(entry("secret-ish activity", 1));
    store.getState().clear();
    const events = store.getState().list();
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toContain("cleared by the user");
  });
});

describe("kindForDecision", () => {
  it("maps each policy decision to its audit kind", () => {
    expect(kindForDecision("allow")).toBe("tool.allowed");
    expect(kindForDecision("approve")).toBe("tool.approved");
    expect(kindForDecision("deny")).toBe("tool.refused");
  });
});

describe("exportAuditLog", () => {
  it("renders entries oldest first with a header stating the count", () => {
    const events: AuditEvent[] = [
      { id: "2", at: 2000, kind: "tool.denied", summary: "User denied send_email" },
      {
        id: "1",
        at: 1000,
        kind: "tool.allowed",
        botName: "Scout",
        summary: "Ran web_fetch",
      },
    ];
    const text = exportAuditLog(events);
    expect(text).toContain("Entries: 2");
    expect(text).toContain("No credential, token, or key values are recorded.");
    expect(text.indexOf("Ran web_fetch")).toBeLessThan(text.indexOf("User denied"));
  });

  it("says so when the log is at the cap, so a reader is not misled", () => {
    const events: AuditEvent[] = Array.from({ length: AUDIT_LOG_LIMIT }, (_, i) => ({
      id: String(i),
      at: i,
      kind: "tool.allowed" as const,
      summary: `e${i}`,
    }));
    expect(exportAuditLog(events)).toContain("older entries were dropped");
  });
});
