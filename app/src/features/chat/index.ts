// Chat / messaging feature (spec: openspec/specs/messaging).
// Public API for this feature is exported from here.

export {
  chatStore,
  createChatStore,
  useChatStore,
  type ChatMessage,
  type ChatState,
  type ChatStoreApi,
  type ChoiceBlock,
  type DelegationStatus,
  type MessageMeta,
  type MessageMetaKind,
  type MessageRole,
  type MessageStatus,
  type SessionEventKind,
  type Thread,
  type ThreadKind,
} from "./store";
export { ThreadView, type ThreadViewProps } from "./ThreadView";
export { Composer, type ComposerProps } from "./Composer";
export {
  Sidebar,
  type SidebarProps,
  type SidebarBot,
  type SidebarThreadItem,
  type BotState,
} from "./Sidebar";
export { Markdown, renderMarkdown } from "./markdown";
