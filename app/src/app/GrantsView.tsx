// Grants view (tool-extensibility spec, "Account-scoped connector
// authorization" / "Multiple accounts per integration"): the single place
// listing every active connector authorization — integration, account label,
// when it was granted, and which bots may use it — with per-row revocation.
// Revoking here cuts off every bot at once (the run loop stops offering the
// integration's tools, including mid-run); a bot that still needs the
// integration must ask the user to re-authorize.
//
// "Which Bots may use it" is computed live from the same pipeline the run
// loop uses: a bot is eligible when its per-bot visibility filter + tool
// policy leave at least one of the grant's tools offerable.

import { useEffect, useState } from "react";
import {
  connectorServerOf,
  getGrantsStore,
  grantServerOf,
  useBotsStore,
  type Bot,
  type ConnectorGrant,
  type GrantsStore,
  type ToolRegistry,
} from "../lib/engine";
import { appToolRegistry } from "./tools";

export interface GrantsViewProps {
  /** Grants store override for tests; defaults to the shared account store. */
  grants?: GrantsStore;
  /** Tool registry override for tests; defaults to the app registry. */
  registry?: ToolRegistry;
}

const formatGrantedAt = (grantedAt: number): string =>
  new Date(grantedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * Bots that can actually use this grant right now: the grant's connected
 * tools filtered through each bot's visibility + policy pipeline. Returns
 * null when the grant's server has no registered tools (not connected), in
 * which case per-bot eligibility cannot be probed.
 */
function eligibleBots(
  grant: ConnectorGrant,
  registry: ToolRegistry,
  bots: Bot[],
): Bot[] | null {
  const server = grantServerOf(grant);
  const grantToolNames = new Set(
    registry
      .list()
      .filter((t) => connectorServerOf(t.name) === server)
      .map((t) => t.name),
  );
  if (grantToolNames.size === 0) return null;
  return bots.filter((bot) =>
    registry.listFor(bot).some((t) => grantToolNames.has(t.name)),
  );
}

export function GrantsView({ grants, registry }: GrantsViewProps) {
  const [store] = useState<GrantsStore>(() => grants ?? getGrantsStore());
  const [rows, setRows] = useState<ConnectorGrant[]>(() => store.list());
  const toolRegistry = registry ?? appToolRegistry;
  const bots = useBotsStore((s) => s.bots).filter((b) => !b.deletedAt);

  useEffect(() => store.subscribe(setRows), [store]);

  return (
    <fieldset>
      <legend className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        Connector authorizations
      </legend>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Integrations you have authorized, one row per account. A grant applies
        to every bot whose own tool policy allows the tools; revoking it cuts
        off all bots at once.
      </p>

      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          No connectors authorized yet.
        </p>
      ) : (
        <ul aria-label="Connector authorizations" className="mt-3 space-y-2">
          {rows.map((grant) => {
            const eligible = eligibleBots(grant, toolRegistry, bots);
            return (
              <li
                key={grant.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {grant.integration}
                    <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {grant.accountLabel}
                    </span>
                  </span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    Granted {formatGrantedAt(grant.grantedAt)}
                  </span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    {eligible === null
                      ? "Usable by: — (server not connected)"
                      : eligible.length === 0
                        ? "Usable by: no bots (blocked by each bot's tool policy)"
                        : `Usable by: ${eligible.map((b) => b.name).join(", ")}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => store.revoke(grant.integration, grant.accountLabel)}
                  aria-label={`Revoke ${grant.integration} (${grant.accountLabel})`}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
