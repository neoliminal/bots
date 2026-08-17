// Account-scoped connector authorization registry (tool-extensibility spec,
// "Account-scoped connector authorization" + "Multiple accounts per
// integration"; design: "Account-scoped grants live in a new lib/engine/grants
// registry").
//
// A grant answers exactly one question — "is this integration authorized for
// this account at all?" — and is keyed on (integration, accountLabel) so an
// integration can hold several concurrently authorized accounts (e.g. Slack
// "default" and Slack "work"), each revocable independently. Per-bot tool
// visibility filtering and the policy hook (policy.ts) remain the per-bot
// gate on *use*; the run loop consults this registry only to decide whether
// connector/MCP tools are offered at all.
//
// Headless: no React, storage injected via the narrow StorageLike shape
// (defaults to the shared engine storage accessor, like worklog/cards).
import { getEngineStorage } from "./bots";
import { makeId } from "./id";
import type { StorageLike } from "./types";

/** Storage key holding the account's connector grants. */
export const GRANTS_STORAGE_KEY = "engine.grants";

/** Label a grant gets when the user hasn't named the account. */
export const DEFAULT_ACCOUNT_LABEL = "default";

/** One authorized (integration, account) pair. */
export interface ConnectorGrant {
  id: string;
  /** Integration/service identifier (e.g. "slack"). */
  integration: string;
  /** User-visible account label ("default", "work", …). */
  accountLabel: string;
  /**
   * MCP server name whose namespaced tools (mcp__<server>__*) this grant
   * covers. Each authorized account is its own connected server, so this is
   * what makes a second account of the same integration independently
   * addressable and revocable. Absent (legacy grants): the integration name
   * doubles as the server name.
   */
  server?: string;
  /** Epoch milliseconds when the authorization was recorded. */
  grantedAt: number;
}

export type GrantsListener = (grants: ConnectorGrant[]) => void;

/**
 * The narrow read surface the run loop needs: does any active grant cover
 * this (namespaced) tool name? Tests inject trivial fakes of this shape.
 * `grantForTool` (optional for fakes) resolves the covering grant, which
 * the loop uses to surface multi-account ambiguity to the model.
 */
export interface GrantsReader {
  coversTool(toolName: string): boolean;
  grantForTool?(toolName: string): ConnectorGrant | undefined;
}

export interface GrantsStore extends GrantsReader {
  /** Load persisted grants. Idempotent; grants made pre-hydrate are kept. */
  hydrate(): Promise<void>;
  /** All active grants, oldest first. */
  list(): ConnectorGrant[];
  /** The grant covering a connector tool name, when one exists. */
  grantForTool(toolName: string): ConnectorGrant | undefined;
  /**
   * Is the integration authorized? With a label: exactly that account.
   * Without: any account of the integration.
   */
  isGranted(integration: string, accountLabel?: string): boolean;
  /** Account labels currently authorized for an integration. */
  labelsFor(integration: string): string[];
  /**
   * Record an authorization. Idempotent per (integration, accountLabel):
   * re-authorizing an existing pair returns the original grant unchanged.
   * `server` names the MCP server whose tools the grant covers (defaults to
   * the integration name).
   */
  record(integration: string, accountLabel?: string, server?: string): ConnectorGrant;
  /**
   * Revoke one (integration, accountLabel) pair — other labels of the same
   * integration keep working. Returns whether a grant was removed.
   */
  revoke(integration: string, accountLabel?: string): boolean;
  /** Subscribe to the grant list. Fires immediately, then on every change. */
  subscribe(listener: GrantsListener): () => void;
}

const normalizeLabel = (accountLabel?: string): string => {
  const trimmed = accountLabel?.trim() ?? "";
  return trimmed === "" ? DEFAULT_ACCOUNT_LABEL : trimmed;
};

/**
 * Is this tool name a connector/MCP tool at all? Non-connector tools are
 * never subject to grant filtering.
 */
export function isConnectorToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

/**
 * The server segment of a namespaced connector tool name
 * (`mcp__<server>__<tool>`), or undefined for non-connector/malformed names.
 * Server names never contain "__" (enforced at registration), so the first
 * "__" after the prefix is an unambiguous separator. This exact-segment
 * extraction is what stops a grant for integration "a" from covering the
 * distinct server "a__b" via naive prefix matching.
 */
export function connectorServerOf(toolName: string): string | undefined {
  if (!isConnectorToolName(toolName)) return undefined;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

/** The server a grant covers (legacy grants: the integration name itself). */
export function grantServerOf(grant: ConnectorGrant): string {
  return grant.server ?? grant.integration;
}

export function createGrantsStore(storage: StorageLike): GrantsStore {
  let grants: ConnectorGrant[] = [];
  let hydrated = false;
  const listeners = new Set<GrantsListener>();

  const notify = (): void => {
    for (const cb of [...listeners]) cb([...grants]);
  };

  const persist = (): void => {
    // Never write before hydrate finishes — a pre-hydrate record must not
    // clobber previously persisted grants (hydrate re-persists the merge).
    if (!hydrated) return;
    void storage.set(GRANTS_STORAGE_KEY, grants).catch((err: unknown) => {
      console.error("[engine] failed to persist connector grants:", err);
    });
  };

  const find = (integration: string, label: string): ConnectorGrant | undefined =>
    grants.find((g) => g.integration === integration && g.accountLabel === label);

  const grantForTool = (toolName: string): ConnectorGrant | undefined => {
    const server = connectorServerOf(toolName);
    if (server === undefined) return undefined;
    return grants.find((g) => grantServerOf(g) === server);
  };

  return {
    hydrate: async () => {
      if (hydrated) return;
      const stored = await storage.get<ConnectorGrant[]>(GRANTS_STORAGE_KEY);
      const hadPreHydrateGrants = grants.length > 0;
      hydrated = true;
      if (stored && stored.length > 0) {
        // Grants recorded before hydrate finished stay (deduped by key,
        // stored ones win — they are the older authorization).
        const merged = [...stored];
        for (const g of grants) {
          if (
            !merged.some(
              (s) => s.integration === g.integration && s.accountLabel === g.accountLabel,
            )
          ) {
            merged.push(g);
          }
        }
        grants = merged;
      }
      if (hadPreHydrateGrants) persist();
      notify();
    },

    list: () => [...grants],

    isGranted: (integration, accountLabel) =>
      accountLabel === undefined
        ? grants.some((g) => g.integration === integration)
        : find(integration, normalizeLabel(accountLabel)) !== undefined,

    labelsFor: (integration) =>
      grants.filter((g) => g.integration === integration).map((g) => g.accountLabel),

    // Exact server-segment match: never covers a DIFFERENT server whose name
    // merely extends the granted one (e.g. grant "a" vs server "a__b").
    coversTool: (toolName) => grantForTool(toolName) !== undefined,

    grantForTool,

    record: (integration, accountLabel, server) => {
      const label = normalizeLabel(accountLabel);
      const existing = find(integration, label);
      if (existing) return existing;
      const grant: ConnectorGrant = {
        id: makeId("grant"),
        integration,
        accountLabel: label,
        ...(server !== undefined && server !== integration ? { server } : {}),
        grantedAt: Date.now(),
      };
      grants = [...grants, grant];
      persist();
      notify();
      return grant;
    },

    revoke: (integration, accountLabel) => {
      const label = normalizeLabel(accountLabel);
      const next = grants.filter(
        (g) => !(g.integration === integration && g.accountLabel === label),
      );
      if (next.length === grants.length) return false;
      grants = next;
      persist();
      notify();
      return true;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      listener([...grants]);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared account-level store (engine + UI share one instance; grants are
// account-scoped, so unlike worklog there is no per-bot keying).
// ---------------------------------------------------------------------------

interface CachedGrants {
  store: GrantsStore;
  ready: Promise<void>;
}

let cachedGrants: CachedGrants | null = null;

function getCached(storage?: StorageLike): CachedGrants {
  if (!cachedGrants) {
    const store = createGrantsStore(storage ?? getEngineStorage());
    cachedGrants = { store, ready: store.hydrate() };
  }
  return cachedGrants;
}

/** Get (or lazily create + hydrate) the shared account grants store. */
export function getGrantsStore(storage?: StorageLike): GrantsStore {
  return getCached(storage).store;
}

/** Await hydration of (and return) the shared grants store. */
export async function hydrateGrants(storage?: StorageLike): Promise<GrantsStore> {
  const cached = getCached(storage);
  await cached.ready;
  return cached.store;
}

/**
 * Record an authorization on the shared store (the API auth flows call when
 * an integration authorizes successfully — e.g. an MCP server connects).
 * Waits for hydration so persisted grants are never clobbered.
 */
export async function recordGrant(
  integration: string,
  accountLabel?: string,
  storage?: StorageLike,
  server?: string,
): Promise<ConnectorGrant> {
  const store = await hydrateGrants(storage);
  return store.record(integration, accountLabel, server);
}

/**
 * Revoke every grant covering an MCP server's tools (used when the user
 * removes the server itself — a forgotten server must not leave a live
 * authorization behind). Returns the number of grants revoked.
 */
export async function revokeGrantsForServer(
  server: string,
  storage?: StorageLike,
): Promise<number> {
  const store = await hydrateGrants(storage);
  const covered = store.list().filter((g) => grantServerOf(g) === server);
  let revoked = 0;
  for (const g of covered) {
    if (store.revoke(g.integration, g.accountLabel)) revoked++;
  }
  return revoked;
}

/** Revoke a grant on the shared store (grants view / one-stop revocation). */
export async function revokeGrant(
  integration: string,
  accountLabel?: string,
  storage?: StorageLike,
): Promise<boolean> {
  const store = await hydrateGrants(storage);
  return store.revoke(integration, accountLabel);
}

/** Drop the cached shared store (tests, or after switching storage adapters). */
export function resetGrantsStore(): void {
  cachedGrants = null;
}
