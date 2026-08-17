// Grants registry tests (tool-extensibility spec: "Account-scoped connector
// authorization", "Multiple accounts per integration").
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  connectorServerOf,
  createGrantsStore,
  DEFAULT_ACCOUNT_LABEL,
  getGrantsStore,
  GRANTS_STORAGE_KEY,
  hydrateGrants,
  isConnectorToolName,
  recordGrant,
  resetGrantsStore,
  revokeGrant,
  revokeGrantsForServer,
  type ConnectorGrant,
} from "./grants";

afterEach(() => {
  resetGrantsStore();
});

describe("createGrantsStore", () => {
  it("authorize once: a single grant covers the integration for everyone (account-scoped, not per-bot)", () => {
    const store = createGrantsStore(createMemoryStorage());
    expect(store.isGranted("calendar")).toBe(false);

    store.record("calendar");

    // The store keys on the account alone — there is no bot dimension, so
    // any bot's loop consulting it sees the same answer.
    expect(store.isGranted("calendar")).toBe(true);
    expect(store.isGranted("calendar", DEFAULT_ACCOUNT_LABEL)).toBe(true);
    expect(store.coversTool("mcp__calendar__create_event")).toBe(true);
    expect(store.coversTool("mcp__slack__post")).toBe(false);
  });

  it("defaults the account label to \"default\" and normalizes blank labels", () => {
    const store = createGrantsStore(createMemoryStorage());
    const a = store.record("slack");
    const b = store.record("slack", "  ");
    expect(a.accountLabel).toBe(DEFAULT_ACCOUNT_LABEL);
    // Same key: re-recording returns the original grant (idempotent).
    expect(b).toEqual(a);
    expect(store.list()).toHaveLength(1);
  });

  it("supports multiple accounts per integration with independent revocation", () => {
    const store = createGrantsStore(createMemoryStorage());
    store.record("slack");
    store.record("slack", "work");
    expect(store.labelsFor("slack")).toEqual([DEFAULT_ACCOUNT_LABEL, "work"]);

    // Revoking "work" leaves "default" functioning (spec: second account
    // added/removed without disturbing the first).
    expect(store.revoke("slack", "work")).toBe(true);
    expect(store.isGranted("slack", "work")).toBe(false);
    expect(store.isGranted("slack", DEFAULT_ACCOUNT_LABEL)).toBe(true);
    expect(store.isGranted("slack")).toBe(true);
    expect(store.coversTool("mcp__slack__post")).toBe(true);

    // Revoking the last account cuts the integration off entirely.
    expect(store.revoke("slack")).toBe(true);
    expect(store.isGranted("slack")).toBe(false);
    expect(store.coversTool("mcp__slack__post")).toBe(false);
    expect(store.revoke("slack")).toBe(false);
  });

  it("round-trips grants through storage", async () => {
    const storage = createMemoryStorage();
    const store = createGrantsStore(storage);
    await store.hydrate();
    const grant = store.record("calendar", "personal");

    // Persisted under the documented key…
    expect(await storage.get<ConnectorGrant[]>(GRANTS_STORAGE_KEY)).toEqual([grant]);

    // …and a fresh store over the same storage sees it after hydrate.
    const reloaded = createGrantsStore(storage);
    expect(reloaded.isGranted("calendar")).toBe(false);
    await reloaded.hydrate();
    expect(reloaded.list()).toEqual([grant]);
    expect(reloaded.isGranted("calendar", "personal")).toBe(true);
  });

  it("keeps grants recorded before hydrate finished, deduped by key", async () => {
    const storage = createMemoryStorage();
    const stored: ConnectorGrant = {
      id: "grant-old",
      integration: "slack",
      accountLabel: "default",
      grantedAt: 1,
    };
    await storage.set(GRANTS_STORAGE_KEY, [stored]);
    const store = createGrantsStore(storage);
    store.record("slack"); // pre-hydrate duplicate of the stored key
    store.record("calendar"); // pre-hydrate, new key
    await store.hydrate();
    // Stored grant wins its key; the new integration survives.
    expect(store.list().map((g) => `${g.integration}:${g.accountLabel}`)).toEqual([
      "slack:default",
      "calendar:default",
    ]);
    expect(store.list()[0]).toEqual(stored);
  });

  it("matches the exact server segment — never a longer or different server name", () => {
    const store = createGrantsStore(createMemoryStorage());
    store.record("gh");
    // Server names can never contain "__" (rejected at registration and at
    // bootstrap), so the first "__" after the prefix is an unambiguous
    // separator: mcp__gh__staging__deploy is tool "staging__deploy" ON
    // server "gh" — covered — while other servers never match.
    expect(store.coversTool("mcp__gh__create_issue")).toBe(true);
    expect(store.coversTool("mcp__gh__staging__deploy")).toBe(true);
    expect(store.coversTool("mcp__ghx__anything")).toBe(false);
    expect(store.coversTool("mcp__g__anything")).toBe(false);
    expect(store.coversTool("not_a_connector")).toBe(false);
  });

  it("keys tool coverage on the grant's server for multi-account integrations", () => {
    const store = createGrantsStore(createMemoryStorage());
    store.record("slack"); // default account, server "slack"
    store.record("slack", "work", "slack-work");

    expect(store.coversTool("mcp__slack__post")).toBe(true);
    expect(store.coversTool("mcp__slack-work__post")).toBe(true);
    expect(store.grantForTool("mcp__slack-work__post")?.accountLabel).toBe("work");
    expect(store.grantForTool("mcp__slack__post")?.accountLabel).toBe(
      DEFAULT_ACCOUNT_LABEL,
    );

    // Independent revocation by account cuts exactly that server's tools.
    store.revoke("slack", "work");
    expect(store.coversTool("mcp__slack-work__post")).toBe(false);
    expect(store.coversTool("mcp__slack__post")).toBe(true);
  });

  it("notifies subscribers immediately and on create/revoke", () => {
    const store = createGrantsStore(createMemoryStorage());
    const seen: ConnectorGrant[][] = [];
    const unsubscribe = store.subscribe((grants) => seen.push(grants));
    expect(seen).toEqual([[]]);

    store.record("slack");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.[0]?.integration).toBe("slack");

    store.revoke("slack");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual([]);

    unsubscribe();
    store.record("calendar");
    expect(seen).toHaveLength(3);
  });
});

describe("shared store helpers", () => {
  it("recordGrant/revokeGrant operate on the shared hydrated store", async () => {
    const storage = createMemoryStorage();
    const grant = await recordGrant("slack", "work", storage);
    expect(grant.accountLabel).toBe("work");

    const store = await hydrateGrants();
    expect(store).toBe(getGrantsStore());
    expect(store.isGranted("slack", "work")).toBe(true);

    expect(await revokeGrant("slack", "work")).toBe(true);
    expect(store.isGranted("slack")).toBe(false);
  });

  it("recordGrant never clobbers persisted grants (awaits hydration)", async () => {
    const storage = createMemoryStorage();
    const stored: ConnectorGrant = {
      id: "grant-old",
      integration: "calendar",
      accountLabel: "default",
      grantedAt: 1,
    };
    await storage.set(GRANTS_STORAGE_KEY, [stored]);

    await recordGrant("slack", undefined, storage);
    const store = getGrantsStore();
    expect(store.isGranted("calendar")).toBe(true);
    expect(store.isGranted("slack")).toBe(true);
  });
});

describe("isConnectorToolName", () => {
  it("marks only namespaced mcp__ tools as connector tools", () => {
    expect(isConnectorToolName("mcp__slack__post")).toBe(true);
    expect(isConnectorToolName("workspace_read")).toBe(false);
    expect(isConnectorToolName("session_exec")).toBe(false);
  });
});

describe("connectorServerOf", () => {
  it("extracts the server segment of a namespaced tool name", () => {
    expect(connectorServerOf("mcp__slack__post")).toBe("slack");
    expect(connectorServerOf("mcp__slack-work__post_message")).toBe("slack-work");
    // Malformed / non-connector names have no server.
    expect(connectorServerOf("workspace_read")).toBeUndefined();
    expect(connectorServerOf("mcp__noseparator")).toBeUndefined();
    expect(connectorServerOf("mcp____tool")).toBeUndefined();
  });
});

describe("revokeGrantsForServer", () => {
  it("revokes every grant covering the removed server, leaving others intact", async () => {
    const storage = createMemoryStorage();
    await recordGrant("slack", undefined, storage);
    await recordGrant("slack", "work", storage, "slack-work");

    expect(await revokeGrantsForServer("slack-work")).toBe(1);
    const store = getGrantsStore();
    expect(store.isGranted("slack", "work")).toBe(false);
    expect(store.isGranted("slack", "default")).toBe(true);
    expect(await revokeGrantsForServer("slack-work")).toBe(0);
  });
});
