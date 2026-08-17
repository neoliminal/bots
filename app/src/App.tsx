// App shell: thread sidebar (Bots + Teams) + chat thread for the selected
// bot or team, New Bot / New Team / settings modals, and a dev-only avatar
// gallery view. Delegation works from ANY thread — direct included — via
// inline delegation cards (multi-bot-collaboration spec); group threads
// remain as optional UI.
//
// Visual language (docs/design/visual-style.md): light-first, iMessage-like
// three-column window — white sidebar (~260px), white chat column, and a
// collapsible off-white detail panel toggled from the chat header.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AvatarGallery,
  STATE_LABELS,
  usePrefersReducedMotion,
} from "./features/avatars";
import {
  Composer,
  Sidebar,
  ThreadView,
  chatStore,
  useChatStore,
  type ChatMessage,
  type SidebarThreadItem,
  type Thread,
} from "./features/chat";
import { DEFAULT_MODEL_CONFIG, selectBotConfig, useModelConfigStore } from "./features/models";
import {
  botInstances,
  botRuntime,
  haltInstances,
  syncPauseState,
  useBotsStore,
  type Bot,
  type BotRuntimeState,
} from "./lib/engine";
import { workspaceWrite } from "./lib/native";
import { bootstrapApp } from "./app/bootstrap";
import {
  cancelBotRuns,
  cancelDelivery,
  cancelThreadDelivery,
  retryFromMessage,
  sendToBot,
  sendToThread,
} from "./app/chatGlue";
import { LiveAvatar } from "./app/LiveAvatar";
import { BotEditor, BOT_PALETTE, type BotEditorValues } from "./app/BotEditor";
import {
  computeIntroCard,
  computeIntroText,
  handleOnboardingAnswer,
  isOnboardingHandler,
  markComputeAsked,
  shouldAskComputeLocation,
} from "./app/onboardingCompute";
import { ROLE_LIBRARY, starterOptionsFor } from "./app/roleSuggestions";
import { SessionSettings } from "./app/SessionSettings";
import { stopAllSessions } from "./app/sessionGlue";
import { TeamEditor } from "./app/TeamEditor";
import { useRuntimeStates } from "./app/runtimeHooks";
import { usePendingApprovals } from "./app/approvalHooks";
import { ApprovalCard } from "./app/ApprovalCard";
import { ApprovalsInbox } from "./app/ApprovalsInbox";
import { DetailPanel } from "./app/DetailPanel";

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Per-thread composer drafts, module-scoped so half-typed text survives
 * thread switches (design pillar: typed work is never lost). The Composer
 * is keyed by threadId, so each thread gets its own instance restored from
 * here on mount.
 */
const composerDrafts = new Map<string, string>();

/**
 * Post the starter-task card (bot-management spec, "Bot introduction with
 * starter options"). Seeded at creation for every bot except the first,
 * whose compute-location question comes first and calls this when settled.
 * Prompt and text are identical so the card renders it once.
 */
function seedStarterCard(botId: string, roleDescription: string): void {
  const prompt = "What should I take on first?";
  const chat = chatStore.getState();
  const id = chat.addBotMessage(botId, botId, prompt);
  if (id !== "") {
    chat.attachChoices(botId, id, {
      prompt,
      options: starterOptionsFor(roleDescription),
    });
  }
}

/**
 * Answer a card the APP owns rather than the model (agent-computer spec,
 * "Onboarding compute location choice"). The answer still posts as an
 * ordinary user message — chip taps are messages — but nothing is dispatched
 * to a model: the reply is composed locally, so onboarding works with no API
 * key configured.
 */
async function answerOnboardingCard(
  botId: string,
  handler: string,
  option: string,
): Promise<void> {
  const chat = chatStore.getState();
  const sent = chat.sendUserMessage(botId, option);
  // Nothing downstream will deliver this one — the app is the recipient.
  if (sent !== "") chat.markDelivered(botId, sent);
  const roleDescription =
    useBotsStore.getState().listBots().find((b) => b.id === botId)?.roleDescription ?? "";
  await handleOnboardingAnswer(handler, option, {
    botId,
    post: ({ text, card }) => {
      const state = chatStore.getState();
      const id = state.addBotMessage(botId, botId, text);
      if (id !== "" && card !== undefined) state.attachChoices(botId, id, card);
    },
    starterTasks: () => seedStarterCard(botId, roleDescription),
  });
}

function toSidebarState(state: BotRuntimeState): "idle" | "thinking" | "working" | "waiting" | "sleeping" {
  switch (state) {
    case "thinking":
      return "thinking";
    case "working":
    case "talkingToUser":
    case "talkingToBot":
    case "handoff":
    case "celebrating":
      return "working";
    case "waitingOnUser":
    case "error":
    case "disconnected":
      return "waiting";
    case "sleeping":
      return "sleeping";
    default:
      return "idle";
  }
}

/** First sentence of a role description, for the introduction greeting. */
function firstSentenceOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "Ready when you are.";
  const period = trimmed.indexOf(". ");
  return period === -1 ? trimmed : `${trimmed.slice(0, period + 1)}`;
}

type ModalState =
  | { mode: "create" }
  | { mode: "edit"; botId: string }
  | { mode: "team" }
  | { mode: "settings" }
  | null;

type AppView = "chat" | "gallery" | "inbox";

function EmptyState({
  onQuickCreate,
  onNewBot,
}: {
  onQuickCreate: () => void;
  onNewBot: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex gap-2" aria-hidden="true">
        {["#14b8a6", "#8b5cf6", "#f97316"].map((c) => (
          <span key={c} className="h-4 w-4 rounded-full opacity-60" style={{ backgroundColor: c }} />
        ))}
      </div>
      <h2 className="text-lg font-semibold text-[#1c1c1e] dark:text-neutral-100">
        No bots yet
      </h2>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
        Bots are durable teammates with a name, a role, and their own thread.
        Start with a ready-made assistant — everything stays editable later.
      </p>
      <button
        type="button"
        onClick={onQuickCreate}
        className="mt-2 rounded-full bg-[#007aff] px-4 py-2 text-sm font-medium text-white hover:bg-[#0a66d0]"
      >
        Start with an Assistant
      </button>
      <button
        type="button"
        onClick={onNewBot}
        className="text-sm text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
      >
        Customize your own…
      </button>
    </div>
  );
}

function DevMenu({
  view,
  onSetView,
  onOpenSettings,
}: {
  view: AppView;
  onSetView: (view: AppView) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Developer menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-2 py-0.5 text-neutral-400 hover:bg-[#f2f2f7] hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        ···
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenSettings();
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-[#f2f2f7] dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSetView(view === "gallery" ? "chat" : "gallery");
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-[#f2f2f7] dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {view === "gallery" ? "Back to chat" : "Avatar gallery"}
          </button>
        </div>
      )}
    </div>
  );
}

function PanelToggleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4" fill="none">
      <rect x="2" y="3" width="14" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11.5 3v12" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4" fill="none">
      <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M9 2.2v2M9 13.8v2M2.2 9h2M13.8 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M13.8 4.2l-1.4 1.4M5.6 12.4l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function App() {
  const reduceMotion = usePrefersReducedMotion();
  const [view, setView] = useState<AppView>("chat");
  const [modal, setModal] = useState<ModalState>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const bots = useBotsStore((s) => s.bots);
  const hydrated = useBotsStore((s) => s.hydrated);
  const activeBots = useMemo(() => bots.filter((b) => !b.deletedAt), [bots]);
  const botNames = useMemo(
    () => Object.fromEntries(bots.map((b) => [b.id, b.name])),
    [bots],
  );

  const selectedThreadId = useChatStore((s) => s.activeThreadId);
  const threadsById = useChatStore((s) => s.threadsById);
  const messagesByThread = useChatStore((s) => s.threads);
  const unread = useChatStore((s) => s.unread);
  const groupThreads = useMemo(
    () =>
      Object.values(threadsById)
        .filter((t) => t.kind === "group")
        .sort((a, b) => a.createdAt - b.createdAt),
    [threadsById],
  );

  const selectedThread: Thread | undefined =
    selectedThreadId !== null ? threadsById[selectedThreadId] : undefined;
  const isGroupSelected = selectedThread?.kind === "group";
  const selectedBot: Bot | undefined = isGroupSelected
    ? undefined
    : activeBots.find((b) => b.id === selectedThreadId);
  const messages = useChatStore((s) =>
    selectedThreadId ? (s.threads[selectedThreadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );

  const botIds = useMemo(() => activeBots.map((b) => b.id), [activeBots]);
  const runtimeStates = useRuntimeStates(botIds);

  // Pending approvals across all bots ("Waiting on you" — human-handoff spec).
  const pendingApprovals = usePendingApprovals();
  const pendingForSelected = selectedThreadId
    ? pendingApprovals.filter((a) => a.threadId === selectedThreadId)
    : [];

  // Startup: hydrate stores; on quit flush pending chat writes and stop any
  // compute sessions best-effort (files are already local via sync-back, so
  // a missed stop only costs idle compute until the provider reaps it).
  useEffect(() => {
    void bootstrapApp();
    const flush = () => {
      void chatStore.persistNow();
      void stopAllSessions();
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // Keep a valid selection: an active bot's direct thread or a group thread.
  useEffect(() => {
    if (!hydrated) return;
    const valid =
      selectedThreadId !== null &&
      (activeBots.some((b) => b.id === selectedThreadId) ||
        threadsById[selectedThreadId]?.kind === "group");
    if (!valid) {
      const fallback = activeBots[0]?.id ?? groupThreads[0]?.id ?? null;
      chatStore.getState().setActiveThread(fallback);
    }
  }, [hydrated, selectedThreadId, activeBots, threadsById, groupThreads]);

  // Last non-session message of a thread → sidebar preview + timestamp.
  const lastMessageOf = (threadId: string): ChatMessage | undefined => {
    const msgs = messagesByThread[threadId];
    if (!msgs) return undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].meta?.kind !== "session") return msgs[i];
    }
    return undefined;
  };

  const previewFor = (threadId: string): { preview?: string; timestamp?: number } => {
    const last = lastMessageOf(threadId);
    if (!last) return {};
    const text =
      last.meta?.kind === "delegation"
        ? `asked ${botNames[last.meta.targetBotId ?? ""] ?? "a teammate"}`
        : last.text;
    return { preview: text.replace(/\s+/g, " ").trim(), timestamp: last.createdAt };
  };

  const sidebarThreads: SidebarThreadItem[] = [
    ...activeBots.map((bot): SidebarThreadItem => {
      const state = runtimeStates[bot.id] ?? "idle";
      return {
        id: bot.id,
        kind: "direct",
        title: bot.name,
        color: bot.color,
        state: toSidebarState(state),
        currentTaskTitle: STATE_LABELS[state],
        ...previewFor(bot.id),
      };
    }),
    ...groupThreads.map(
      (t): SidebarThreadItem => ({
        id: t.id,
        kind: "group",
        title: t.title ?? "Team",
        participantBotIds: t.participantBotIds,
        ...previewFor(t.id),
      }),
    ),
  ];

  const modelConfigState = useModelConfigStore();
  const editingBot =
    modal?.mode === "edit" ? activeBots.find((b) => b.id === modal.botId) : undefined;

  const handleCreate = (values: BotEditorValues) => {
    // Asked before the bot exists: only the FIRST bot opens with the
    // compute-location question (bot-management spec, "First Bot's
    // introduction covers compute location").
    const firstBot = useBotsStore.getState().listBots().length === 0;
    const bot = useBotsStore.getState().createBot({
      name: values.name,
      color: values.color,
      roleDescription: values.roleDescription,
      ...(values.toolPolicy !== undefined ? { toolPolicy: values.toolPolicy } : {}),
    });
    // Seed the introduction (bot-management spec, "Bot introduction with
    // starter options"): local + instant, no model call — the first model
    // turn happens when the user answers the card. For the first bot the
    // greeting leads with where it should work; the starter-task card
    // follows once that is settled or skipped.
    const chat = chatStore.getState();
    const askCompute = firstBot && shouldAskComputeLocation();
    const greeting = `Hi — I'm ${bot.name}. ${firstSentenceOf(values.roleDescription)}`;
    const introId = chat.addBotMessage(
      bot.id,
      bot.id,
      askCompute ? computeIntroText(greeting) : greeting,
    );
    if (introId !== "") {
      chat.attachChoices(
        bot.id,
        introId,
        askCompute
          ? computeIntroCard()
          : {
              prompt: "What should I take on first?",
              options: starterOptionsFor(values.roleDescription),
            },
      );
      if (askCompute) markComputeAsked();
    }
    // Persona-template starter files land in the new bot's workspace
    // (bot-management spec, "Persona templates"). Best-effort: outside the
    // desktop app the workspace fs is a no-op.
    for (const file of values.starterFiles ?? []) {
      void workspaceWrite(bot.id, file.path, file.contents).catch((err: unknown) => {
        console.error(`[app] failed to write starter file ${file.path}:`, err);
      });
    }
    if (values.primaryModelId !== DEFAULT_MODEL_CONFIG.primaryModelId) {
      useModelConfigStore.getState().setBotConfig(bot.id, {
        primaryModelId: values.primaryModelId,
      });
    }
    chatStore.getState().setActiveBot(bot.id);
    setModal(null);
    setView("chat");
  };

  // One-click first bot (design pillar): every field of a first bot is
  // inferable — name, random color, the default Personal Assistant role,
  // and the default model. The full editor stays one click away.
  const handleQuickCreate = () => {
    handleCreate({
      name: "Assistant",
      color: BOT_PALETTE[Math.floor(Math.random() * BOT_PALETTE.length)],
      roleDescription: ROLE_LIBRARY[0].description,
      primaryModelId: modelConfigState.defaultConfig.primaryModelId,
    });
  };

  const handleSaveEdit = (values: BotEditorValues) => {
    if (!editingBot) return;
    useBotsStore.getState().updateBot(editingBot.id, {
      name: values.name,
      color: values.color,
      roleDescription: values.roleDescription,
      // Explicitly clears back to platform defaults when all rows are Default.
      toolPolicy: values.toolPolicy,
      // Same contract: undefined = all workspace skills enabled.
      enabledSkills: values.enabledSkills,
    });
    const current = selectBotConfig(useModelConfigStore.getState(), editingBot.id);
    if (values.primaryModelId !== current.primaryModelId) {
      useModelConfigStore.getState().setBotConfig(editingBot.id, {
        primaryModelId: values.primaryModelId,
      });
    }
    setModal(null);
  };

  const handleCreateTeam = (name: string, memberBotIds: string[]) => {
    const threadId = chatStore.getState().createGroupThread(memberBotIds, name);
    chatStore.getState().setActiveThread(threadId);
    setModal(null);
    setView("chat");
  };

  const handleTogglePause = () => {
    if (!editingBot) return;
    const pausing = !editingBot.paused;
    const updated = useBotsStore
      .getState()
      .updateBot(editingBot.id, { paused: pausing });
    if (updated) syncPauseState(updated);
    // Pausing the canonical bot halts its ephemeral instances at their next
    // safe boundary (multi-bot-collaboration spec).
    if (pausing) haltInstances(editingBot.id);
  };

  const handleDelete = () => {
    if (!editingBot) return;
    // Deletion stops all the bot's activity immediately (bot-management
    // spec): abort its in-flight and queued runs, which also withdraws any
    // approvals it parked ("Waiting on you" must not act for a deleted bot).
    cancelBotRuns(editingBot.id);
    useBotsStore.getState().softDeleteBot(editingBot.id);
    botRuntime.clear(editingBot.id);
    if (selectedThreadId === editingBot.id) {
      const next = activeBots.find((b) => b.id !== editingBot.id);
      chatStore.getState().setActiveBot(next?.id ?? null);
    }
    setModal(null);
  };

  const selectedState: BotRuntimeState = selectedBot
    ? (runtimeStates[selectedBot.id] ?? "idle")
    : "idle";

  // A reply is in flight for the open thread: block concurrent sends (a second
  // request would race the first and miss its answer in context) and offer Stop.
  const deliveryInFlight = messages.some(
    (m) => m.streaming === true || m.status === "pending",
  );

  // Avatar for a bot id OR an ephemeral instance id: instance avatars use
  // the parent bot's color but keep their own runtime feed and are labeled
  // as copies ("Scout · copy" — multi-bot-collaboration spec, instances are
  // visibly marked everywhere).
  const renderBotAvatarById = (id: string, size: number) => {
    const bot = bots.find((b) => b.id === id);
    if (bot) {
      return (
        <LiveAvatar
          botId={bot.id}
          color={bot.color}
          name={bot.name}
          size={size}
          reduceMotion={reduceMotion}
        />
      );
    }
    const instance = botInstances.get(id);
    if (!instance) return null;
    const parent = bots.find((b) => b.id === instance.parentBotId);
    return (
      <LiveAvatar
        botId={id}
        color={parent?.color ?? "#64748b"}
        name={`${instance.parentBotName} · copy`}
        size={size}
        reduceMotion={reduceMotion}
      />
    );
  };

  const approvalsPanel =
    pendingForSelected.length > 0 ? (
      <div className="space-y-2 border-t border-neutral-200 bg-[#f7f7f9] px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
        {pendingForSelected.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            botName={botNames[approval.botId] ?? "Bot"}
            botNames={botNames}
          />
        ))}
      </div>
    ) : null;

  const groupParticipants: Bot[] = isGroupSelected
    ? (selectedThread?.participantBotIds ?? [])
        .map((id) => activeBots.find((b) => b.id === id))
        .filter((b): b is Bot => b !== undefined)
    : [];

  return (
    <div className="flex h-screen overflow-hidden bg-white font-sans text-[13px] text-[#1c1c1e] antialiased dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <header className="flex items-center justify-between px-4 pb-0.5 pt-3">
          <h1 className="text-sm font-semibold tracking-tight">Bots</h1>
          <DevMenu
            view={view}
            onSetView={setView}
            onOpenSettings={() => setModal({ mode: "settings" })}
          />
        </header>
        <div className="min-h-0 flex-1">
          <Sidebar
            threads={sidebarThreads}
            selectedThreadId={selectedThreadId}
            unreadCounts={unread}
            onSelectThread={(id) => {
              chatStore.getState().setActiveThread(id);
              setView("chat");
            }}
            onNewBot={() => setModal({ mode: "create" })}
            onCreateGroup={
              activeBots.length >= 2 ? () => setModal({ mode: "team" }) : undefined
            }
            renderAvatar={(bot) => (
              <LiveAvatar
                botId={bot.id}
                color={bot.color}
                name={bot.name}
                size={40}
                reduceMotion={reduceMotion}
                // The open conversation's row watches the cursor, and does
                // it harder than the header avatars: it is the bot you are
                // working with, so it should look like it is paying
                // attention. Every other row stays ambient.
                followCursor={bot.id === selectedThreadId}
                gazeIntensity={3.2}
              />
            )}
          />
        </div>
        <footer className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setView("inbox")}
            aria-current={view === "inbox" ? "true" : undefined}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] font-medium ${
              view === "inbox"
                ? "bg-[#e9e9eb] dark:bg-neutral-800"
                : "hover:bg-[#f2f2f7] dark:hover:bg-neutral-800/60"
            }`}
          >
            <span>Waiting on you</span>
            {pendingApprovals.length > 0 && (
              <span
                aria-label={`${pendingApprovals.length} pending approval${
                  pendingApprovals.length === 1 ? "" : "s"
                }`}
                className="rounded-full bg-[#007aff] px-1.5 py-0.5 text-[11px] font-semibold text-white"
              >
                {pendingApprovals.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setModal({ mode: "settings" })}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-neutral-600 hover:bg-[#f2f2f7] dark:text-neutral-300 dark:hover:bg-neutral-800/60"
          >
            <span className="text-neutral-400">
              <GearIcon />
            </span>
            Settings
          </button>
        </footer>
      </div>

      <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950">
        {view === "gallery" ? (
          <>
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <h2 className="text-sm font-semibold">Avatar gallery</h2>
              <button
                type="button"
                onClick={() => setView("chat")}
                className="rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-[#f2f2f7] dark:hover:bg-neutral-800"
              >
                Back to chat
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AvatarGallery reduceMotion={reduceMotion} />
            </div>
          </>
        ) : view === "inbox" ? (
          <>
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <h2 className="text-sm font-semibold">Waiting on you</h2>
              <button
                type="button"
                onClick={() => setView("chat")}
                className="rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-[#f2f2f7] dark:hover:bg-neutral-800"
              >
                Back to chat
              </button>
            </header>
            <ApprovalsInbox
              approvals={pendingApprovals}
              bots={activeBots}
              onOpenThread={(threadId) => {
                chatStore.getState().setActiveThread(threadId);
                setView("chat");
              }}
              renderAvatar={(botId) => renderBotAvatarById(botId, 32)}
            />
          </>
        ) : !hydrated ? (
          <div className="flex-1" />
        ) : activeBots.length === 0 ? (
          <EmptyState
            onQuickCreate={handleQuickCreate}
            onNewBot={() => setModal({ mode: "create" })}
          />
        ) : isGroupSelected && selectedThread ? (
          <>
            <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
              <div className="flex shrink-0 -space-x-2">
                {groupParticipants.slice(0, 4).map((bot) => (
                  <span key={bot.id} className="inline-block rounded-full ring-2 ring-white dark:ring-neutral-950">
                    <LiveAvatar
                      botId={bot.id}
                      color={bot.color}
                      name={bot.name}
                      size={28}
                      reduceMotion={reduceMotion}
                      followCursor
                    />
                  </span>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[13px] font-semibold">
                  {selectedThread.title ?? "Team"}
                </h2>
                <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                  {groupParticipants.map((b) => b.name).join(", ")}
                </p>
              </div>
            </header>

            <ThreadView
              messages={messages}
              thread={selectedThread}
              botNames={botNames}
              renderBotAvatar={renderBotAvatarById}
              onRetry={(messageId) => {
                void retryFromMessage(selectedThread.id, messageId);
              }}
              onChoiceSelect={(_messageId, option) => {
                // A chip tap posts the option through the NORMAL send path;
                // sending also marks the block answered (chips go inert).
                void sendToThread(selectedThread.id, option);
              }}
              pendingApprovals={pendingForSelected}
            />
            {approvalsPanel}
            <Composer
              key={selectedThread.id}
              disabled={groupParticipants.length === 0}
              busy={deliveryInFlight}
              onStop={() => {
                cancelThreadDelivery(selectedThread.id);
              }}
              placeholder={`Message ${selectedThread.title ?? "the team"}…`}
              initialDraft={composerDrafts.get(selectedThread.id) ?? ""}
              onDraftChange={(text) => composerDrafts.set(selectedThread.id, text)}
              onSend={(text) => {
                composerDrafts.delete(selectedThread.id);
                void sendToThread(selectedThread.id, text);
              }}
            />
          </>
        ) : selectedBot ? (
          <>
            <header className="flex items-center gap-2.5 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
              <LiveAvatar
                botId={selectedBot.id}
                color={selectedBot.color}
                name={selectedBot.name}
                size={28}
                reduceMotion={reduceMotion}
                followCursor
              />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[13px] font-semibold">{selectedBot.name}</h2>
                <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                  {selectedBot.paused ? "paused" : STATE_LABELS[selectedState]}
                </p>
              </div>
              <button
                type="button"
                aria-label="Bot settings"
                onClick={() => setModal({ mode: "edit", botId: selectedBot.id })}
                className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-[#f2f2f7] hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                <GearIcon />
              </button>
              <button
                type="button"
                aria-label="Toggle details"
                aria-expanded={detailOpen}
                onClick={() => setDetailOpen((v) => !v)}
                className={`flex h-7 w-7 items-center justify-center rounded-full ${
                  detailOpen
                    ? "bg-[#e9e9eb] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                    : "text-neutral-400 hover:bg-[#f2f2f7] hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                }`}
              >
                <PanelToggleIcon />
              </button>
            </header>

            {selectedBot.paused && (
              <div className="flex items-center justify-between border-b border-neutral-200 bg-[#f7f7f9] px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                <span>This bot is paused and won't respond to new messages.</span>
                <button
                  type="button"
                  onClick={() => {
                    const updated = useBotsStore
                      .getState()
                      .updateBot(selectedBot.id, { paused: false });
                    if (updated) syncPauseState(updated);
                  }}
                  className="rounded-full border border-neutral-300 px-2.5 py-0.5 font-medium hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  Resume
                </button>
              </div>
            )}

            <ThreadView
              messages={messages}
              thread={selectedThread}
              botNames={botNames}
              renderBotAvatar={renderBotAvatarById}
              onRetry={(messageId) => {
                void retryFromMessage(selectedBot.id, messageId);
              }}
              onChoiceSelect={(messageId, option) => {
                // A chip tap posts the option through the NORMAL send path;
                // sending also marks the block answered (chips go inert).
                // The exception is a card the app owns (first-run compute
                // location), which is answered locally instead.
                const card = messages.find((m) => m.id === messageId)?.choices;
                if (card?.handler !== undefined && isOnboardingHandler(card.handler)) {
                  void answerOnboardingCard(selectedBot.id, card.handler, option);
                  return;
                }
                void sendToBot(selectedBot.id, option);
              }}
              pendingApprovals={pendingForSelected}
            />
            {approvalsPanel}
            <Composer
              key={selectedBot.id}
              disabled={selectedBot.paused}
              busy={deliveryInFlight}
              onStop={() => {
                cancelDelivery(selectedBot.id);
              }}
              placeholder={
                selectedBot.paused
                  ? `${selectedBot.name} is paused`
                  : `Message ${selectedBot.name}…`
              }
              initialDraft={composerDrafts.get(selectedBot.id) ?? ""}
              onDraftChange={(text) => composerDrafts.set(selectedBot.id, text)}
              onSend={(text) => {
                composerDrafts.delete(selectedBot.id);
                void sendToBot(selectedBot.id, text);
              }}
            />
          </>
        ) : (
          <div className="flex-1" />
        )}
      </main>

      {view === "chat" && detailOpen && selectedBot && (
        <DetailPanel
          bot={selectedBot}
          statusLabel={STATE_LABELS[selectedState]}
          approvals={pendingForSelected}
          botNames={botNames}
          renderAvatar={renderBotAvatarById}
        />
      )}

      {modal?.mode === "create" && (
        <BotEditor
          title="New Bot"
          submitLabel="Create Bot"
          reduceMotion={reduceMotion}
          initial={{
            name: "",
            color: BOT_PALETTE[Math.floor(Math.random() * BOT_PALETTE.length)],
            roleDescription: "",
            primaryModelId: modelConfigState.defaultConfig.primaryModelId,
          }}
          onSubmit={handleCreate}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.mode === "settings" && (
        <SessionSettings onClose={() => setModal(null)} />
      )}

      {modal?.mode === "team" && (
        <TeamEditor
          bots={activeBots}
          onCreate={handleCreateTeam}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.mode === "edit" && editingBot && (
        <BotEditor
          title={`${editingBot.name} settings`}
          submitLabel="Save changes"
          reduceMotion={reduceMotion}
          botId={editingBot.id}
          initial={{
            name: editingBot.name,
            color: editingBot.color,
            roleDescription: editingBot.roleDescription,
            primaryModelId: selectBotConfig(modelConfigState, editingBot.id).primaryModelId,
            ...(editingBot.toolPolicy !== undefined
              ? { toolPolicy: editingBot.toolPolicy }
              : {}),
            ...(editingBot.enabledSkills !== undefined
              ? { enabledSkills: editingBot.enabledSkills }
              : {}),
          }}
          onSubmit={handleSaveEdit}
          onCancel={() => setModal(null)}
          paused={editingBot.paused}
          onTogglePause={handleTogglePause}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

export default App;
