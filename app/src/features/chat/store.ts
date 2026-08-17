// Chat store: direct and group threads (specs: openspec/specs/messaging
// "Group threads", openspec/specs/multi-bot-collaboration "Bot-to-bot
// messaging"). Local-only for now — no server queue.
//
// Thread model: `Thread` entities live in `threadsById`; messages live in
// `threads`, keyed by threadId. A direct thread's id IS its bot's id, so every
// pre-group caller that keyed messages/unread/selection by botId keeps working
// unchanged. Group threads get generated ids and 2+ participants.

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createLocalStorage, type KeyValueStorage } from "../../lib/storage";

export type MessageRole = "user" | "bot";
export type MessageStatus = "pending" | "delivered" | "error";
export type ThreadKind = "direct" | "group";
export type MessageMetaKind =
  | "delegation"
  | "report"
  | "session"
  | "routine-run"
  | "normal";

/**
 * Live status of a delegation card in its originating thread. "interrupted"
 * is assigned at load time only: a card persisted as "in-progress" can never
 * resolve after a restart (the run died with the app), so it surfaces as
 * interrupted with a retry affordance instead of spinning forever.
 */
export type DelegationStatus = "in-progress" | "done" | "failed" | "interrupted";

/**
 * Compute-session timeline events (agent-computer spec, "Isolation and
 * hygiene"): lifecycle indicators (provisioned / warm-resumed / stopped)
 * rendered subtly in-thread, and a "sync-warning" when sync-back had to
 * skip files (partial sync — visible, never silent). Individual commands
 * are deliberately NOT here: they go to the audit log, readable in the
 * Activity log, so the thread stays a conversation.
 */
export type SessionEventKind =
  | "provisioned"
  | "warm-resumed"
  | "stopped"
  | "sync-warning";

/**
 * Bot-to-bot markers carried by messages (multi-bot-collaboration spec,
 * "Delegation visibility without group chats"): a "delegation" message is the
 * inline delegation card rendered in the originating thread — target bot,
 * brief, live status, and (when resolved) the full report; a "report" message
 * records the target bot's side in its own thread.
 */
export interface MessageMeta {
  kind: MessageMetaKind;
  /** For "delegation" messages: the bot the task was delegated to. */
  targetBotId?: string;
  /** Stable id linking the delegation card and the target's report. */
  delegationId?: string;
  /** Live status shown on the delegation card. */
  status?: DelegationStatus;
  /** The self-contained brief the target received. */
  brief?: string;
  /** The target's report, embedded once the delegation resolves. */
  report?: string;
  /** Failure reason when status is "failed". */
  error?: string;
  /** The requesting bot (report messages record who asked). */
  fromBotId?: string;
  /** True when the delegated run executed on an ephemeral instance. */
  instance?: boolean;
  /** The ephemeral instance id, for instance-aware avatar badging. */
  instanceId?: string;
  /** For "session" messages: which session event this line records. */
  sessionEvent?: SessionEventKind;
  /** For "session" messages: which provider ran the session. */
  sessionKind?: string;
  /** For "routine-run" cards: the routine that fired. */
  routineName?: string;
  /** For "routine-run" cards: what set it off. */
  invokedBy?: "user" | "schedule" | "trigger";
}

/**
 * Structured choice prompt attached to a bot message (messaging spec,
 * "Structured choice prompts"): the options render as clickable chips under
 * the message. Answering — a chip tap or ANY free-text user reply in the
 * thread — records the answer in `answeredWith`, which makes the chips
 * inert. Chips always accompany, never replace, the free-text composer.
 */
export interface ChoiceBlock {
  /** Optional short prompt shown with the chips. */
  prompt?: string;
  /** The offered options, in offer order. */
  options: string[];
  /** The user's answer (chip text or free text). Set ⇒ chips are inert. */
  answeredWith?: string;
  /**
   * Marks a card the APP answers rather than the model (currently the
   * first-run compute-location flow, tags `onboarding.*`). The tag rides on
   * the persisted message so a card answered after a restart still routes to
   * its local handler instead of being sent to a model. Untagged cards —
   * every card a bot emits — take the normal send path.
   */
  handler?: string;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  /** Direct threads keep exactly 1 participant (the bot whose id === thread id). */
  participantBotIds: string[];
  title?: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Thread the message belongs to. For direct threads this equals the botId. */
  threadId: string;
  /** Authoring bot for role "bot" messages — attribution in group threads. */
  authorBotId?: string;
  text: string;
  status: MessageStatus;
  createdAt: number;
  /** True while a bot message is still receiving streamed deltas. */
  streaming?: boolean;
  /** Optional EA-flow marker (delegation/report/normal). */
  meta?: MessageMeta;
  /** Optional structured choice prompt rendered as chips (bot messages). */
  choices?: ChoiceBlock;
}

export interface ChatState {
  /** Messages keyed by threadId (direct threadId === botId). */
  threads: Record<string, ChatMessage[]>;
  /** Thread entities keyed by threadId. */
  threadsById: Record<string, Thread>;
  /** Unread bot-message counts keyed by threadId. */
  unread: Record<string, number>;
  /** Thread currently open (its messages never count as unread). */
  activeThreadId: string | null;
  /**
   * Compat mirror of activeThreadId: equals it while a direct thread is open,
   * null while a group thread (or nothing) is open.
   */
  activeBotId: string | null;
  /** True once loadPersisted has run; auto-persist is suppressed before then. */
  hydrated: boolean;

  // --- Thread management ---
  /** Create a group thread; returns its id. Participants are deduped. */
  createGroupThread: (participantBotIds: string[], title?: string) => string;
  /** Add a bot to a group thread (no-op on direct threads or duplicates). */
  addParticipant: (threadId: string, botId: string) => void;
  /** Remove a bot from a group thread (no-op on direct threads / non-members). */
  removeParticipant: (threadId: string, botId: string) => void;
  /** Ensure the direct thread for a bot exists; returns its id (=== botId). */
  ensureDirectThread: (botId: string) => string;

  // --- Message actions (thread-keyed; direct threadId === botId keeps old botId callers working) ---
  /** Append a user message (status "pending"). Returns the new message id, or "" for blank text. */
  sendUserMessage: (threadId: string, text: string) => string;
  /** Mark a message delivered (e.g. once handed to the engine). */
  markDelivered: (threadId: string, messageId: string) => void;
  /**
   * Append a streamed delta to a bot message, creating the streaming message on
   * first delta. `authorBotId` attributes the message in group threads; omitted,
   * it defaults to the direct thread's sole participant.
   */
  appendBotDelta: (threadId: string, messageId: string, delta: string, authorBotId?: string) => void;
  /** Finish a streaming bot message: delivered, not streaming; bumps unread for inactive threads. */
  finalizeBotMessage: (threadId: string, messageId: string) => void;
  /**
   * Append a complete (non-streamed) bot message from a participant — the
   * bot-to-bot path. Returns the message id, or "" for blank text or when
   * `authorBotId` is not a participant of the thread.
   */
  addBotMessage: (threadId: string, authorBotId: string, text: string, meta?: MessageMeta) => string;
  /**
   * Merge a patch into a message's meta (e.g. a delegation card's live
   * status/report). No-op for unknown messages.
   */
  updateMessageMeta: (threadId: string, messageId: string, patch: Partial<MessageMeta>) => void;
  /**
   * Attach a choice block to a message (messaging spec, "Structured choice
   * prompts"). `text`, when given, replaces the message's display text —
   * used to strip the structured marker out of the streamed reply. No-op
   * for unknown messages.
   */
  attachChoices: (
    threadId: string,
    messageId: string,
    choices: ChoiceBlock,
    text?: string,
  ) => void;
  /**
   * Append a subtle timeline event (meta kind "session") to a thread's task
   * record: session lifecycle indicators and session_exec audit lines.
   * Never bumps unread and skips the participant guard — the event belongs
   * to whichever thread the work ran in. Returns the message id.
   */
  addTimelineEvent: (
    threadId: string,
    authorBotId: string,
    text: string,
    meta: MessageMeta,
  ) => string;
  /** Mark a message as errored (stops streaming if applicable). */
  markError: (threadId: string, messageId: string) => void;
  /** Reset an errored message back to "pending" so delivery can be reattempted. */
  retryMessage: (threadId: string, messageId: string) => void;

  // --- Selection / unread ---
  /** Set the open thread and clear its unread count. */
  setActiveThread: (threadId: string | null) => void;
  /** Compat: open a bot's direct thread (creates it if missing). */
  setActiveBot: (botId: string | null) => void;
  /** Clear the unread count for a thread. */
  markThreadRead: (threadId: string) => void;

  /** Load threads from storage, migrating v1 (botId-keyed) data to the thread model. */
  loadPersisted: () => Promise<void>;
}

export type ChatStoreApi = StoreApi<ChatState> & {
  /** Flush any debounced write immediately (mainly for tests / app shutdown). */
  persistNow: () => Promise<void>;
};

const STORAGE_KEY = "chat.threads";

/** v1 (pre-group) message shape: keyed/attributed by botId, no thread entities. */
interface LegacyChatMessage {
  id: string;
  role: MessageRole;
  botId: string;
  text: string;
  status: MessageStatus;
  createdAt: number;
  streaming?: boolean;
}

interface PersistedChatV1 {
  version: 1;
  threads: Record<string, LegacyChatMessage[]>;
  unread: Record<string, number>;
}

interface PersistedChatV2 {
  version: 2;
  threadsById: Record<string, Thread>;
  messages: Record<string, ChatMessage[]>;
  unread: Record<string, number>;
}

type PersistedChat = PersistedChatV1 | PersistedChatV2;

function newId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function directThread(botId: string, createdAt = Date.now()): Thread {
  return { id: botId, kind: "direct", participantBotIds: [botId], createdAt };
}

/** Threads map with a direct-thread entity guaranteed for `threadId`. */
function withThreadEntity(
  threadsById: Record<string, Thread>,
  threadId: string,
): Record<string, Thread> {
  if (threadsById[threadId]) return threadsById;
  return { ...threadsById, [threadId]: directThread(threadId) };
}

function patchMessage(
  threads: Record<string, ChatMessage[]>,
  threadId: string,
  messageId: string,
  patch: (m: ChatMessage) => ChatMessage,
): Record<string, ChatMessage[]> | null {
  const thread = threads[threadId];
  if (!thread) return null;
  const index = thread.findIndex((m) => m.id === messageId);
  if (index === -1) return null;
  const next = thread.slice();
  next[index] = patch(thread[index]);
  return { ...threads, [threadId]: next };
}

/**
 * Restart normalization: streams/pending sends interrupted by a restart can
 * never complete → error; likewise a delegation card persisted "in-progress"
 * lost its run with the app → "interrupted" (rendered with Retry).
 */
function normalizeInterrupted(m: ChatMessage): ChatMessage {
  let next =
    m.streaming || m.status === "pending"
      ? { ...m, streaming: false, status: "error" as MessageStatus }
      : m;
  if (next.meta?.kind === "delegation" && next.meta.status === "in-progress") {
    next = { ...next, meta: { ...next.meta, status: "interrupted" } };
  }
  return next;
}

/** Lossless v1 → v2 migration: each botId-keyed history becomes a direct thread. */
function migrateV1(data: PersistedChatV1): Omit<PersistedChatV2, "version"> {
  const threadsById: Record<string, Thread> = {};
  const messages: Record<string, ChatMessage[]> = {};
  for (const [botId, legacy] of Object.entries(data.threads)) {
    const createdAt =
      legacy.length > 0 ? Math.min(...legacy.map((m) => m.createdAt)) : Date.now();
    threadsById[botId] = directThread(botId, createdAt);
    messages[botId] = legacy.map((m) =>
      normalizeInterrupted({
        id: m.id,
        role: m.role,
        threadId: botId,
        ...(m.role === "bot" ? { authorBotId: m.botId ?? botId } : {}),
        text: m.text,
        status: m.status,
        createdAt: m.createdAt,
        streaming: m.streaming,
      }),
    );
  }
  return { threadsById, messages, unread: data.unread ?? {} };
}

/**
 * True when a settled (non-streaming) message appeared in any thread whose
 * contents changed — a sent user message, a finished bot reply, a timeline
 * event. Streaming deltas mutate an existing streaming message and so do
 * NOT count, which is what keeps a chatty bot from writing per delta.
 *
 * Only threads whose array identity changed are examined, so the cost is
 * proportional to what moved rather than to the whole history.
 */
function settledGrew(
  next: Record<string, ChatMessage[]>,
  prev: Record<string, ChatMessage[]>,
): boolean {
  const settled = (messages: ChatMessage[] | undefined): number =>
    (messages ?? []).reduce((n, m) => (m.streaming === true ? n : n + 1), 0);
  for (const [threadId, messages] of Object.entries(next)) {
    if (prev[threadId] === messages) continue;
    if (settled(messages) > settled(prev[threadId])) return true;
  }
  return false;
}

export function createChatStore(
  storage: KeyValueStorage = createLocalStorage(),
  debounceMs = 250,
  /** Longest a pending change may wait, however busy the stream is. */
  maxWaitMs = 1_000,
): ChatStoreApi {
  const store = createStore<ChatState>()((set, get) => ({
    threads: {},
    threadsById: {},
    unread: {},
    activeThreadId: null,
    activeBotId: null,
    hydrated: false,

    createGroupThread: (participantBotIds, title) => {
      const id = newId();
      const thread: Thread = {
        id,
        kind: "group",
        participantBotIds: [...new Set(participantBotIds)],
        ...(title === undefined ? {} : { title }),
        createdAt: Date.now(),
      };
      set((state) => ({
        threadsById: { ...state.threadsById, [id]: thread },
        threads: { ...state.threads, [id]: [] },
      }));
      return id;
    },

    addParticipant: (threadId, botId) => {
      const thread = get().threadsById[threadId];
      if (!thread || thread.kind !== "group") return;
      if (thread.participantBotIds.includes(botId)) return;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...thread,
            participantBotIds: [...thread.participantBotIds, botId],
          },
        },
      }));
    },

    removeParticipant: (threadId, botId) => {
      const thread = get().threadsById[threadId];
      if (!thread || thread.kind !== "group") return;
      if (!thread.participantBotIds.includes(botId)) return;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...thread,
            participantBotIds: thread.participantBotIds.filter((id) => id !== botId),
          },
        },
      }));
    },

    ensureDirectThread: (botId) => {
      if (!get().threadsById[botId]) {
        set((state) => ({ threadsById: withThreadEntity(state.threadsById, botId) }));
      }
      return botId;
    },

    sendUserMessage: (threadId, text) => {
      if (text.trim() === "") return "";
      const id = newId();
      const message: ChatMessage = {
        id,
        role: "user",
        threadId,
        text,
        status: "pending",
        createdAt: Date.now(),
      };
      set((state) => {
        // Any still-open choice prompt in the thread is superseded by this
        // reply — chip tap and free text alike land here, so both make the
        // thread's chips inert (messaging spec, "Free text still wins").
        const prior = (state.threads[threadId] ?? []).map((m) =>
          m.choices !== undefined && m.choices.answeredWith === undefined
            ? { ...m, choices: { ...m.choices, answeredWith: text } }
            : m,
        );
        return {
          threadsById: withThreadEntity(state.threadsById, threadId),
          threads: { ...state.threads, [threadId]: [...prior, message] },
        };
      });
      return id;
    },

    markDelivered: (threadId, messageId) => {
      const threads = patchMessage(get().threads, threadId, messageId, (m) => ({
        ...m,
        status: "delivered",
      }));
      if (threads) set({ threads });
    },

    appendBotDelta: (threadId, messageId, delta, authorBotId) => {
      const state = get();
      const threads = patchMessage(state.threads, threadId, messageId, (m) => ({
        ...m,
        text: m.text + delta,
        streaming: true,
      }));
      if (threads) {
        set({ threads });
        return;
      }
      const threadsById = withThreadEntity(state.threadsById, threadId);
      const thread = threadsById[threadId];
      const author =
        authorBotId ?? (thread.kind === "direct" ? thread.participantBotIds[0] : undefined);
      const message: ChatMessage = {
        id: messageId,
        role: "bot",
        threadId,
        ...(author === undefined ? {} : { authorBotId: author }),
        text: delta,
        status: "pending",
        createdAt: Date.now(),
        streaming: true,
      };
      set((s) => ({
        threadsById,
        threads: { ...s.threads, [threadId]: [...(s.threads[threadId] ?? []), message] },
      }));
    },

    finalizeBotMessage: (threadId, messageId) => {
      const state = get();
      const threads = patchMessage(state.threads, threadId, messageId, (m) => ({
        ...m,
        status: "delivered",
        streaming: false,
      }));
      if (!threads) return;
      const isActive =
        state.activeThreadId === threadId || state.activeBotId === threadId;
      set({
        threads,
        unread: isActive
          ? state.unread
          : { ...state.unread, [threadId]: (state.unread[threadId] ?? 0) + 1 },
      });
    },

    addBotMessage: (threadId, authorBotId, text, meta) => {
      if (text.trim() === "") return "";
      const state = get();
      const threadsById = withThreadEntity(state.threadsById, threadId);
      const thread = threadsById[threadId];
      // Delegation traffic surfaces where the need arose (multi-bot spec):
      // a delegated bot two hops down may post its card into a thread it is
      // not a participant of. Everything else keeps the participant guard.
      const isDelegationTraffic = meta?.kind === "delegation" || meta?.kind === "report";
      if (!isDelegationTraffic && !thread.participantBotIds.includes(authorBotId)) return "";
      const id = newId();
      const message: ChatMessage = {
        id,
        role: "bot",
        threadId,
        authorBotId,
        text,
        status: "delivered",
        createdAt: Date.now(),
        ...(meta === undefined ? {} : { meta }),
      };
      const isActive =
        state.activeThreadId === threadId || state.activeBotId === threadId;
      set((s) => ({
        threadsById,
        threads: { ...s.threads, [threadId]: [...(s.threads[threadId] ?? []), message] },
        unread: isActive
          ? s.unread
          : { ...s.unread, [threadId]: (s.unread[threadId] ?? 0) + 1 },
      }));
      return id;
    },

    addTimelineEvent: (threadId, authorBotId, text, meta) => {
      if (text.trim() === "") return "";
      const id = newId();
      const message: ChatMessage = {
        id,
        role: "bot",
        threadId,
        authorBotId,
        text,
        status: "delivered",
        createdAt: Date.now(),
        meta,
      };
      set((state) => ({
        threadsById: withThreadEntity(state.threadsById, threadId),
        threads: {
          ...state.threads,
          [threadId]: [...(state.threads[threadId] ?? []), message],
        },
      }));
      return id;
    },

    updateMessageMeta: (threadId, messageId, patch) => {
      const threads = patchMessage(get().threads, threadId, messageId, (m) => ({
        ...m,
        meta: { kind: m.meta?.kind ?? "normal", ...m.meta, ...patch },
      }));
      if (threads) set({ threads });
    },

    attachChoices: (threadId, messageId, choices, text) => {
      const threads = patchMessage(get().threads, threadId, messageId, (m) => ({
        ...m,
        ...(text === undefined ? {} : { text }),
        choices,
      }));
      if (threads) set({ threads });
    },

    markError: (threadId, messageId) => {
      const threads = patchMessage(get().threads, threadId, messageId, (m) => ({
        ...m,
        status: "error",
        streaming: false,
      }));
      if (threads) set({ threads });
    },

    retryMessage: (threadId, messageId) => {
      const threads = patchMessage(get().threads, threadId, messageId, (m) =>
        m.status === "error" ? { ...m, status: "pending" } : m,
      );
      if (threads) set({ threads });
    },

    setActiveThread: (threadId) => {
      set((state) => {
        if (threadId === null) return { activeThreadId: null, activeBotId: null };
        const thread = state.threadsById[threadId];
        return {
          activeThreadId: threadId,
          // Unknown ids are treated as direct (botId-keyed compat callers).
          activeBotId: thread && thread.kind === "group" ? null : threadId,
          unread: { ...state.unread, [threadId]: 0 },
        };
      });
    },

    setActiveBot: (botId) => {
      if (botId !== null) get().ensureDirectThread(botId);
      get().setActiveThread(botId);
    },

    markThreadRead: (threadId) => {
      set((state) => ({ unread: { ...state.unread, [threadId]: 0 } }));
    },

    loadPersisted: async () => {
      const data = await storage.get<PersistedChat>(STORAGE_KEY);
      if (!data || typeof data !== "object") {
        set({ hydrated: true });
        return;
      }
      if (data.version === 1 && typeof data.threads === "object") {
        const migrated = migrateV1(data);
        set({
          threads: migrated.messages,
          threadsById: migrated.threadsById,
          unread: migrated.unread,
          hydrated: true,
        });
        return;
      }
      if (data.version === 2 && typeof data.messages === "object") {
        let threadsById = data.threadsById ?? {};
        const threads: Record<string, ChatMessage[]> = {};
        for (const [threadId, messages] of Object.entries(data.messages)) {
          threadsById = withThreadEntity(threadsById, threadId);
          threads[threadId] = messages.map(normalizeInterrupted);
        }
        set({ threads, threadsById, unread: data.unread ?? {}, hydrated: true });
        return;
      }
      set({ hydrated: true });
    },
  }));

  // Persistence of thread entities + messages + unread.
  //
  // The thread is the durable half of a run's model context (task-execution
  // spec, "Model-visible means logged"): the run log holds a run's tool
  // steps, this holds the conversation they sit in. A crash that loses
  // recent messages therefore costs a resumed run its context, so what gets
  // written when matters more than it looks.
  //
  // Three rules:
  //  - A settled message — a user message, a finished bot reply, a timeline
  //    event — writes THROUGH, immediately. These are human-paced and are
  //    exactly what a resumed run needs.
  //  - Streaming deltas debounce; half a sentence is not worth a write.
  //  - The debounce cannot be starved. Reset-on-every-change means a bot
  //    that streams for thirty seconds would never write at all, so a
  //    pending change older than `maxWaitMs` forces the write.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSince: number | null = null;
  const write = async () => {
    pendingSince = null;
    const { threads, threadsById, unread } = store.getState();
    await storage.set<PersistedChatV2>(STORAGE_KEY, {
      version: 2,
      threadsById,
      messages: threads,
      unread,
    });
  };
  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void write();
  };
  store.subscribe((state, prev) => {
    if (!state.hydrated) return; // never clobber storage before the initial load
    if (
      state.threads === prev.threads &&
      state.threadsById === prev.threadsById &&
      state.unread === prev.unread
    ) {
      return;
    }
    if (settledGrew(state.threads, prev.threads)) {
      flushNow();
      return;
    }
    const now = Date.now();
    pendingSince ??= now;
    if (now - pendingSince >= maxWaitMs) {
      flushNow();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, debounceMs);
  });

  const persistNow = async () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await write();
  };

  return Object.assign(store, { persistNow });
}

/** App-wide chat store, persisted to localStorage. */
export const chatStore: ChatStoreApi = createChatStore();

/** React hook bound to the app-wide chat store. */
export function useChatStore<T>(selector: (state: ChatState) => T): T {
  return useStore(chatStore, selector);
}
