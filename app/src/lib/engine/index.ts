// Bot engine: runtime state machine, tool-calling loop, approvals, memory,
// and delegation driving bot behavior and status.
export type {
  Bot,
  BotRuntimeState,
  ChatMessage,
  ChatMessageToolCall,
  ChatRole,
  ChatStreamFn,
  ChatStreamRequest,
  EngineEvents,
  LoopChatFn,
  LoopChatRequest,
  LoopChatResult,
  StorageLike,
  ThreadMessage,
  ToolCallRequest,
  ToolDef,
} from "./types";
export { BOT_RUNTIME_STATES } from "./types";

export {
  BOTS_STORAGE_KEY,
  configureEngineStorage,
  createBotsStore,
  createMemoryStorage,
  getEngineStorage,
  useBotsStore,
} from "./bots";
export type { BotsState, BotsStore, CreateBotInput, UpdateBotPatch } from "./bots";

export {
  botRuntime,
  createRuntime,
  DEFAULT_CELEBRATE_MS,
  DEFAULT_HANDOFF_MS,
} from "./runtime";
export type { RuntimeListener, RuntimeStore } from "./runtime";

export {
  BotPausedError,
  buildMessages,
  buildSystemPrompt,
  UNTRUSTED_CONTENT_GUIDANCE,
  sendMessage,
  syncPauseState,
} from "./engine";
export type { EngineDeps } from "./engine";

export { ToolRegistry, toToolDef } from "./tools";
export type { EngineTool, ToolContext, ToolRunContext } from "./tools";

export {
  classifyConnectorTool,
  classifyFormField,
  decide,
  decideForChain,
  DEFAULT_CATEGORY_RULES,
  ESCALATE_WHEN_TAINTED,
  HARD_FLOOR_CATEGORIES,
  isVisible,
  tightest,
} from "./policy";

export {
  discoverSkills,
  enabledSkills,
  isSkillPath,
  parseSkillMd,
  renderSkillsSection,
  SKILLS_CHAR_BUDGET,
} from "./skills";
export type { SkillPack, SkillsFs } from "./skills";
export type {
  ActionCategory,
  DecisionContext,
  PolicyDecision,
  PolicyRule,
  ToolPolicy,
} from "./policy";

export {
  createRoutineScheduler,
  createRoutinesStore,
  createSaveRoutineTool,
  describeSchedule,
  dueSlot,
  nextRunAt,
  ROUTINE_LATE_AFTER_MS,
  ROUTINE_RUN_HISTORY_LIMIT,
  ROUTINES_STORAGE_KEY,
  useRoutinesStore,
} from "./routines";
export type {
  CreateRoutineInput,
  Routine,
  RoutineInvoker,
  RoutineRunRecord,
  RoutineSchedule,
  RoutineScheduler,
  RoutineSchedulerDeps,
  RoutinesState,
  RoutinesStore,
  UpdateRoutinePatch,
} from "./routines";

export {
  createRunLogStore,
  MAX_RESUME_ATTEMPTS,
  reconstructMessages,
  runLog,
  RUN_LOG_STORAGE_KEY,
} from "./runLog";
export type {
  NewRunLogEntry,
  OpenRun,
  RunLogEntry,
  RunLogSink,
  RunLogState,
  RunLogStore,
} from "./runLog";

export {
  auditLog,
  AUDIT_LOG_LIMIT,
  AUDIT_STORAGE_KEY,
  createAuditStore,
  exportAuditLog,
  kindForDecision,
} from "./audit";
export type { AuditEvent, AuditEventKind, AuditSink, AuditState, AuditStore } from "./audit";

export {
  botApprovals,
  createApprovalManager,
  resolveApproval,
} from "./approvals";
export type {
  ApprovalDecision,
  ApprovalManager,
  ApprovalProvenance,
  ApprovalResolution,
  ApprovalsListener,
  PendingApproval,
} from "./approvals";

export {
  composeSystemPrompt,
  createMemoryStore,
  getMemoryStore,
  hydrateMemory,
  memoryStorageKey,
  registerMemoryTools,
  resetMemoryStores,
} from "./memory";
export type {
  CreateMemoryStoreOptions,
  MemoryEntry,
  MemoryListener,
  MemoryStore,
} from "./memory";

export {
  createContactBotTool,
  DELEGATION_MAX_DEPTH,
  delegationRefusals,
  registerDelegationTool,
} from "./delegation";
export type {
  DelegateFn,
  DelegationDeps,
  DelegationRequest,
  TeammateCardText,
  TeammateInfo,
} from "./delegation";

export {
  buildTemplateFromBot,
  MAX_STARTER_FILE_BYTES,
  MAX_STARTER_FILES,
  parseTemplate,
  serializeTemplate,
  TEMPLATE_VERSION,
  templatePrefill,
} from "./templates";
export type {
  PersonaTemplate,
  TemplateFile,
  TemplateParseResult,
} from "./templates";

export { botRuns, createRunTracker, DELEGATION_MAX_FAN_OUT } from "./runs";
export type { RegisterRunOptions, RunTracker } from "./runs";

export {
  botInstances,
  createInstanceRegistry,
  haltInstances,
  MAX_INSTANCES_PER_BOT,
  mergeHistoryStorageKey,
} from "./instances";
export type {
  BotInstance,
  InstanceRegistry,
  InstanceRegistryDeps,
  InstancesListener,
  InstanceState,
  MemoryVersion,
  MergeConflict,
  MergeHistoryListener,
  MergeRecord,
  SpawnResult,
} from "./instances";

export {
  ACCOUNT_TARGETING_GUIDANCE,
  CLI_FIRST_GUIDANCE,
  MAX_TOOL_ROUNDS,
  runLoop,
  UNTRUSTED_MAX_CHARS,
  wrapUntrusted,
  WRAP_UP_PROMPT,
} from "./loop";
export type { RunLoopDeps } from "./loop";

export {
  connectorServerOf,
  createGrantsStore,
  DEFAULT_ACCOUNT_LABEL,
  getGrantsStore,
  grantServerOf,
  GRANTS_STORAGE_KEY,
  hydrateGrants,
  isConnectorToolName,
  recordGrant,
  resetGrantsStore,
  revokeGrant,
  revokeGrantsForServer,
} from "./grants";
export type {
  ConnectorGrant,
  GrantsListener,
  GrantsReader,
  GrantsStore,
} from "./grants";

export {
  categorySummary,
  createWorklogStore,
  GENERAL_CATEGORY_ID,
  getWorklogStore,
  hydrateWorklog,
  inferTaskCategory,
  MAX_WORKLOG_ENTRIES,
  recordCompletedWork,
  resetWorklogStores,
  WORK_CATEGORIES,
  worklogStorageKey,
} from "./worklog";
export type {
  CompletedWorkInput,
  WorkCategory,
  WorklogListener,
  WorklogStore,
  WorkRecord,
} from "./worklog";

export {
  AVAILABILITY_STATES,
  buildCapabilityCard,
  cardStorageKey,
  clearPin,
  compileExperience,
  CONTACT_PERMISSIONS_STORAGE_KEY,
  createAvailabilityGetter,
  createCardStore,
  createContactPermissionsStore,
  DEFAULT_CONTACT_PERMISSIONS,
  deriveAvailability,
  EXPERIENCE_CHAR_BUDGET,
  getCardHistory,
  getCardStore,
  getContactPermissionsStore,
  MAX_CARD_VERSIONS,
  pinExperience,
  resetCardStores,
  resetContactPermissionsStore,
} from "./cards";
export type {
  AvailabilityDeps,
  AvailabilityState,
  CapabilityCard,
  CardBot,
  CardSnapshot,
  CardStore,
  ContactPermissions,
  ContactPermissionsStore,
} from "./cards";
