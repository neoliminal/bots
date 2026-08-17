// Compute-session layer public surface.
// Spec: openspec/specs/agent-computer/spec.md
export type {
  SessionKind,
  SessionStatus,
  SessionExecOpts,
  SessionExecResult,
  SessionFileEntry,
  SessionProvisionResult,
  SessionStopOpts,
  SessionProvider,
  SessionStatusEvent,
} from "./types";
export { SessionManager, DEFAULT_IDLE_MS } from "./store";
export type { SessionManagerOptions } from "./store";
export {
  LocalSessionProvider,
  LOCAL_SESSION_PREFIX,
  localSessionBotId,
} from "./local";
export { FlySessionProvider, LIST_FILES_CMD, parseListOutput } from "./fly";
export {
  HostSessionProvider,
  HOST_SESSION_PREFIX,
  HOST_ROOT,
  hostSessionBotId,
  shQuote,
  validateRelPath,
  workspaceDir,
} from "./host";
export type { HostExecFn, HostProviderDeps } from "./host";
export {
  clearBrowsingState,
  createBrowseTools,
  formatBrowseResponse,
  BROWSE_TOOL_NAMES,
} from "./browse";
export type { BrowseToolsDeps } from "./browse";
export {
  SyncEngine,
  CHECKPOINT_INTERVAL_MS,
  signatureOf,
} from "./sync";
export type {
  ExecWithSyncResult,
  LocalWriteFn,
  SyncChangedResult,
  SyncFailure,
} from "./sync";
export { createSessionTools, formatExecResult } from "./tools";
export type { SessionToolsDeps } from "./tools";
