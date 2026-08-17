// Settings surface for compute sessions (agent-computer spec): choose where
// bots' shell commands run. Local (default) executes sandboxed in each bot's
// workspace on this computer; Fly Machines runs them in disposable cloud
// micro-VMs (activates once FLY_API_TOKEN is in keys/.env — until then the
// option shows its unconfigured state and setup instructions). Provisioning
// is transparent either way: nothing spins up until a bot's first session
// tool call, and workspace-scoped work runs without per-command approval
// wherever it happens (task-execution spec).
//
// Also hosts MCP server registration (tool-extensibility spec): adding a
// server is strictly user-initiated here; its tools then enter the shared
// registry (namespaced mcp__<server>__<tool>) subject to each bot's policy —
// and the Activity log, the readable face of the audit trail (security spec).

import { useEffect, useState } from "react";
import { hostDiscover } from "../lib/native";
import {
  clearBrowsingState,
  HostSessionProvider,
  type SessionKind,
  type SessionStatus,
} from "../lib/sessions";

/**
 * Clearing browsing state is a user action, not a bot's, but the provider
 * API is keyed by bot (each bot gets its own workspace on the host). The
 * browser profile is shared across all of them, so any id reaches the same
 * profile; this one is reserved for user-initiated maintenance.
 */
const SIGN_OUT_BOT_ID = "user-maintenance";
import { ActivityLog } from "./ActivityLog";
import { COMPUTE_OPTIONS } from "./computeOptions";
import { GrantsView } from "./GrantsView";
import {
  connectMcpServer,
  listMcpServers,
  reconnectMcpServer,
  removeMcpServer,
  validateMcpServerName,
  type McpServerView,
} from "./mcpGlue";
import {
  flyProviderStatus,
  getHostTarget,
  getSessionProviderKind,
  hostProviderStatus,
  setHostTarget,
  setSessionProvider,
} from "./sessionGlue";

export interface SessionSettingsProps {
  onClose: () => void;
}

/**
 * Presentation order here differs from the shared list's (local, host, fly):
 * Settings has always led with the two cheapest-to-explain options. The set
 * itself comes from `computeOptions` so this surface and the onboarding card
 * can never describe the same provider differently.
 */
const SETTINGS_ORDER: readonly SessionKind[] = ["local", "fly", "host"];

const OPTIONS = SETTINGS_ORDER.map((kind) => {
  const option = COMPUTE_OPTIONS.find((o) => o.kind === kind);
  if (option === undefined) throw new Error(`no compute option for ${kind}`);
  return { kind, title: option.title, body: option.settingsBody };
});

export function SessionSettings({ onClose }: SessionSettingsProps) {
  const [selected, setSelected] = useState<SessionKind>(getSessionProviderKind());
  const [flyStatus, setFlyStatus] = useState<SessionStatus | "checking">(
    "checking",
  );
  const [hostTargetInput, setHostTargetInput] = useState(() => getHostTarget());
  const [hostStatus, setHostStatus] = useState<SessionStatus | "checking" | null>(
    null,
  );
  // Discovery (agent-computer spec, "Personal host discovery"): null = never
  // scanned, "scanning" = in flight, array = results of the last scan.
  const [discovered, setDiscovered] = useState<string[] | "scanning" | null>(null);
  /** "" idle, "working" in flight, otherwise the result message. */
  const [signOutState, setSignOutState] = useState("");
  const [servers, setServers] = useState<McpServerView[]>(() => listMcpServers());
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpEnvKeys, setMcpEnvKeys] = useState("");
  const [mcpIntegration, setMcpIntegration] = useState("");
  const [mcpAccountLabel, setMcpAccountLabel] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const addServer = async () => {
    const name = mcpName.trim();
    const commandLine = mcpCommand.trim().split(/\s+/).filter(Boolean);
    const [command, ...args] = commandLine;
    if (name === "" || command === undefined) {
      setMcpError("A server name and a command are required.");
      return;
    }
    const nameError = validateMcpServerName(name);
    if (nameError !== null) {
      setMcpError(nameError);
      return;
    }
    setMcpBusy(true);
    setMcpError(null);
    const integration = mcpIntegration.trim();
    const accountLabel = mcpAccountLabel.trim();
    try {
      await connectMcpServer({
        name,
        command,
        args,
        envKeys: mcpEnvKeys
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        ...(integration !== "" ? { integration } : {}),
        ...(accountLabel !== "" ? { accountLabel } : {}),
      });
      setServers(listMcpServers());
      setMcpName("");
      setMcpCommand("");
      setMcpEnvKeys("");
      setMcpIntegration("");
      setMcpAccountLabel("");
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      setMcpBusy(false);
    }
  };

  const dropServer = async (name: string) => {
    await removeMcpServer(name);
    setServers(listMcpServers());
  };

  const retryServer = async (name: string) => {
    setMcpError(null);
    try {
      await reconnectMcpServer(name);
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    }
    setServers(listMcpServers());
  };

  useEffect(() => {
    let cancelled = false;
    void flyProviderStatus()
      .then((status) => {
        if (!cancelled) setFlyStatus(status);
      })
      .catch(() => {
        if (!cancelled) setFlyStatus("unconfigured");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = (kind: SessionKind) => {
    setSelected(kind);
    void setSessionProvider(kind);
  };

  const scanForHosts = async () => {
    setDiscovered("scanning");
    try {
      setDiscovered(await hostDiscover());
    } catch {
      setDiscovered([]);
    }
  };

  const applyHostTarget = async (raw: string) => {
    const target = raw.trim();
    if (target !== "" && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(target)) {
      setHostStatus("error");
      return;
    }
    await setHostTarget(target);
    if (target === "") {
      setHostStatus(null);
      return;
    }
    setHostStatus("checking");
    try {
      setHostStatus(await hostProviderStatus());
    } catch {
      setHostStatus("error");
    }
  };

  const saveHostTarget = () => applyHostTarget(hostTargetInput);

  /** Clear the host browser's shared login state (user-initiated). */
  const signOutSites = async () => {
    setSignOutState("working");
    try {
      const message = await clearBrowsingState(
        new HostSessionProvider(getHostTarget()),
        SIGN_OUT_BOT_ID,
      );
      setSignOutState(message);
    } catch (err) {
      setSignOutState(
        `Could not sign out: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // A discovered-host click does everything in one go: prefill the target
  // (keeping any typed username) and immediately save + probe reachability
  // (design pillar: one click should yield a verdict, not a form state).
  const chooseDiscoveredHost = (host: string) => {
    const typedUser = hostTargetInput.split("@")[0]?.trim();
    const user =
      hostTargetInput.includes("@") && typedUser !== "" ? typedUser : "user";
    const target = `${user}@${host}`;
    setHostTargetInput(target);
    void applyHostTarget(target);
  };

  const flyUnconfigured = flyStatus === "unconfigured";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <fieldset>
            <legend className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Compute sessions
            </legend>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Where bots run shell commands. Sessions provision automatically
              on a bot's first command and stop on their own when idle — no
              setup per task.
            </p>
            <div className="mt-3 space-y-2">
              {OPTIONS.map((option) => {
                const active = selected === option.kind;
                const isFly = option.kind === "fly";
                return (
                  <label
                    key={option.kind}
                    className={`block cursor-pointer rounded-xl border px-3 py-2.5 ${
                      active
                        ? "border-[#007aff] bg-[#007aff]/5 dark:border-sky-600 dark:bg-sky-950/20"
                        : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600"
                    }`}
                  >
                    <span className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="session-provider"
                        className="mt-0.5"
                        checked={active}
                        onChange={() => choose(option.kind)}
                        aria-label={option.title}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                          {option.title}
                          {option.kind === "local" && (
                            <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                              default
                            </span>
                          )}
                          {isFly && flyStatus !== "checking" && (
                            <span
                              data-testid="fly-status"
                              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                flyUnconfigured
                                  ? "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                                  : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                              }`}
                            >
                              {flyUnconfigured ? "not configured" : "configured"}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                          {option.body}
                        </span>
                        {option.kind === "host" && (
                          <span
                            className="mt-2 block"
                            onClick={(e) => e.preventDefault()}
                          >
                            <span className="flex items-center gap-2">
                              <input
                                type="text"
                                value={hostTargetInput}
                                onChange={(e) => setHostTargetInput(e.target.value)}
                                placeholder="you@minipc.local"
                                aria-label="Personal host SSH target"
                                className="w-48 rounded-lg border border-neutral-200 px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800"
                              />
                              <button
                                type="button"
                                onClick={() => void saveHostTarget()}
                                className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                              >
                                Save &amp; test
                              </button>
                              {hostStatus !== null && (
                                <span
                                  data-testid="host-status"
                                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                    hostStatus === "running"
                                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                                      : hostStatus === "checking"
                                        ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                                        : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                                  }`}
                                >
                                  {hostStatus === "running"
                                    ? "reachable"
                                    : hostStatus === "checking"
                                      ? "checking…"
                                      : hostStatus === "unconfigured"
                                        ? "no target"
                                        : "unreachable"}
                                </span>
                              )}
                            </span>
                            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void scanForHosts()}
                                disabled={discovered === "scanning"}
                                className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                              >
                                {discovered === "scanning" ? "Scanning…" : "Scan network"}
                              </button>
                              {Array.isArray(discovered) &&
                                discovered.map((host) => (
                                  <button
                                    key={host}
                                    type="button"
                                    data-testid="discovered-host"
                                    onClick={() => chooseDiscoveredHost(host)}
                                    className="rounded-full border border-[#007aff]/40 px-2.5 py-0.5 font-mono text-xs text-[#007aff] hover:bg-[#007aff]/10 dark:border-[#409cff]/50 dark:text-[#409cff]"
                                  >
                                    {host}
                                  </button>
                                ))}
                              {Array.isArray(discovered) && discovered.length === 0 && (
                                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                                  No SSH services found — enter the address manually.
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
                              Key-based SSH must work without a prompt. To set
                              the machine up, run the provisioning package —
                              see host/README.md in the project folder.
                            </span>
                            {/* Every bot browses through ONE profile that stays
                                signed in to the user's accounts. Revoking that
                                shared state has to be reachable here. */}
                            <span className="mt-2 block">
                              <button
                                type="button"
                                onClick={() => void signOutSites()}
                                disabled={signOutState === "working"}
                                className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                              >
                                {signOutState === "working"
                                  ? "Signing out…"
                                  : "Sign out of all sites"}
                              </button>
                              <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
                                {signOutState !== "" && signOutState !== "working"
                                  ? signOutState
                                  : "Clears the shared browser profile's cookies on the host. Bots share one signed-in browser."}
                              </span>
                            </span>
                          </span>
                        )}
                        {isFly && flyUnconfigured && (
                          <span
                            data-testid="fly-instructions"
                            className="mt-2 block rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                          >
                            To enable Fly sessions, add{" "}
                            <code className="font-mono">
                              FLY_API_TOKEN=&lt;your token&gt;
                            </code>{" "}
                            to <code className="font-mono">keys/.env</code> in
                            the project folder, then restart the app. Bots
                            will fall back to errors until the token is set.
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              MCP servers
            </legend>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Connect external tool servers (Model Context Protocol, stdio).
              Their tools become available to bots — subject to each
              bot&apos;s tool policy — under names like{" "}
              <code className="font-mono">mcp__server__tool</code>. Bots
              prefer CLI tools in their compute session where one can do the
              job; MCP covers services without one. Secret values stay in{" "}
              <code className="font-mono">keys/.env</code> — list only the
              entry names to pass through.
            </p>

            {servers.length > 0 && (
              <ul aria-label="Connected MCP servers" className="mt-3 space-y-2">
                {servers.map((server) => (
                  <li
                    key={server.name}
                    className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
                        {server.name}
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            server.healthy
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                              : "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                          }`}
                        >
                          {server.healthy ? "connected" : "unavailable"}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                        {server.command} {server.args.join(" ")} —{" "}
                        {server.toolNames.length}{" "}
                        {server.toolNames.length === 1 ? "tool" : "tools"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {!server.healthy && (
                        <button
                          type="button"
                          onClick={() => void retryServer(server.name)}
                          aria-label={`Reconnect MCP server ${server.name}`}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#007aff] hover:bg-[#007aff]/10 dark:text-[#409cff]"
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void dropServer(server.name)}
                        aria-label={`Remove MCP server ${server.name}`}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 space-y-2 rounded-xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-700">
              <input
                aria-label="MCP server name"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="Name, e.g. helpdesk"
                className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <input
                aria-label="MCP server command"
                value={mcpCommand}
                onChange={(e) => setMcpCommand(e.target.value)}
                placeholder="Command, e.g. npx -y @acme/helpdesk-mcp"
                className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <input
                aria-label="MCP server env key names"
                value={mcpEnvKeys}
                onChange={(e) => setMcpEnvKeys(e.target.value)}
                placeholder="keys/.env entries to pass (names only), e.g. HELPDESK_API_KEY"
                className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <div className="flex gap-2">
                <input
                  aria-label="Integration name"
                  value={mcpIntegration}
                  onChange={(e) => setMcpIntegration(e.target.value)}
                  placeholder="Integration (optional), e.g. slack"
                  className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
                <input
                  aria-label="Account label"
                  value={mcpAccountLabel}
                  onChange={(e) => setMcpAccountLabel(e.target.value)}
                  placeholder='Account label (optional), e.g. "work"'
                  className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
              </div>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                Connecting a second account of the same service: register it as
                its own server (e.g. <code className="font-mono">slack-work</code>),
                set the integration to the shared service name and give the
                account a label. Each account is granted and revocable
                independently.
              </p>
              {mcpError !== null && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {mcpError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void addServer()}
                disabled={mcpBusy}
                className="rounded-full bg-[#007aff] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#0a66d0] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mcpBusy ? "Connecting…" : "Connect server"}
              </button>
            </div>
          </fieldset>

          <GrantsView />

          <ActivityLog />
        </div>
      </div>
    </div>
  );
}
