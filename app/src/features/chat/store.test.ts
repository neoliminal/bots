import { createMemoryStorage } from "../../lib/storage";
import { createChatStore, type ChatStoreApi } from "./store";

const BOT = "bot-1";

describe("chat store", () => {
  let store: ChatStoreApi;

  beforeEach(() => {
    store = createChatStore(createMemoryStorage());
  });

  describe("sendUserMessage", () => {
    it("appends a pending user message and returns its id", () => {
      const id = store.getState().sendUserMessage(BOT, "hello");
      const thread = store.getState().threads[BOT];
      expect(thread).toHaveLength(1);
      expect(thread[0]).toMatchObject({
        id,
        role: "user",
        threadId: BOT,
        text: "hello",
        status: "pending",
      });
      expect(thread[0].createdAt).toBeTypeOf("number");
    });

    it("creates the direct thread entity implicitly for botId-keyed callers", () => {
      store.getState().sendUserMessage(BOT, "hello");
      expect(store.getState().threadsById[BOT]).toMatchObject({
        id: BOT,
        kind: "direct",
        participantBotIds: [BOT],
      });
    });

    it("ignores blank text", () => {
      const id = store.getState().sendUserMessage(BOT, "   \n ");
      expect(id).toBe("");
      expect(store.getState().threads[BOT]).toBeUndefined();
    });

    it("keeps threads separate per bot", () => {
      store.getState().sendUserMessage(BOT, "a");
      store.getState().sendUserMessage("bot-2", "b");
      expect(store.getState().threads[BOT]).toHaveLength(1);
      expect(store.getState().threads["bot-2"]).toHaveLength(1);
    });
  });

  it("markDelivered updates status", () => {
    const id = store.getState().sendUserMessage(BOT, "hello");
    store.getState().markDelivered(BOT, id);
    expect(store.getState().threads[BOT][0].status).toBe("delivered");
  });

  describe("streaming", () => {
    it("appendBotDelta creates a streaming bot message on first delta", () => {
      store.getState().appendBotDelta(BOT, "m1", "Hel");
      const message = store.getState().threads[BOT][0];
      expect(message).toMatchObject({
        id: "m1",
        role: "bot",
        threadId: BOT,
        // In a direct thread the author defaults to the sole participant.
        authorBotId: BOT,
        text: "Hel",
        status: "pending",
        streaming: true,
      });
    });

    it("appendBotDelta attributes an explicit author in group threads", () => {
      const threadId = store.getState().createGroupThread(["b1", "b2"]);
      store.getState().appendBotDelta(threadId, "m1", "hi", "b2");
      expect(store.getState().threads[threadId][0]).toMatchObject({
        role: "bot",
        threadId,
        authorBotId: "b2",
      });
    });

    it("appendBotDelta accumulates subsequent deltas", () => {
      store.getState().appendBotDelta(BOT, "m1", "Hel");
      store.getState().appendBotDelta(BOT, "m1", "lo ");
      store.getState().appendBotDelta(BOT, "m1", "there");
      const message = store.getState().threads[BOT][0];
      expect(message.text).toBe("Hello there");
      expect(message.streaming).toBe(true);
    });

    it("finalizeBotMessage marks delivered and stops streaming", () => {
      store.getState().appendBotDelta(BOT, "m1", "done");
      store.getState().finalizeBotMessage(BOT, "m1");
      const message = store.getState().threads[BOT][0];
      expect(message.status).toBe("delivered");
      expect(message.streaming).toBe(false);
    });

    it("markError stops streaming with error status", () => {
      store.getState().appendBotDelta(BOT, "m1", "par");
      store.getState().markError(BOT, "m1");
      const message = store.getState().threads[BOT][0];
      expect(message.status).toBe("error");
      expect(message.streaming).toBe(false);
    });
  });

  describe("unread", () => {
    it("finalize increments unread for inactive threads", () => {
      store.getState().setActiveBot("other-bot");
      store.getState().appendBotDelta(BOT, "m1", "hi");
      store.getState().finalizeBotMessage(BOT, "m1");
      expect(store.getState().unread[BOT]).toBe(1);
    });

    it("finalize does not increment unread for the active thread", () => {
      store.getState().setActiveBot(BOT);
      store.getState().appendBotDelta(BOT, "m1", "hi");
      store.getState().finalizeBotMessage(BOT, "m1");
      expect(store.getState().unread[BOT] ?? 0).toBe(0);
    });

    it("setActiveBot clears unread for that bot", () => {
      store.getState().appendBotDelta(BOT, "m1", "hi");
      store.getState().finalizeBotMessage(BOT, "m1");
      expect(store.getState().unread[BOT]).toBe(1);
      store.getState().setActiveBot(BOT);
      expect(store.getState().unread[BOT]).toBe(0);
    });

    it("markThreadRead clears unread", () => {
      store.getState().appendBotDelta(BOT, "m1", "hi");
      store.getState().finalizeBotMessage(BOT, "m1");
      store.getState().markThreadRead(BOT);
      expect(store.getState().unread[BOT]).toBe(0);
    });
  });

  it("retryMessage resets an errored message to pending", () => {
    const id = store.getState().sendUserMessage(BOT, "hello");
    store.getState().markError(BOT, id);
    store.getState().retryMessage(BOT, id);
    expect(store.getState().threads[BOT][0].status).toBe("pending");
  });

  it("retryMessage leaves non-errored messages alone", () => {
    const id = store.getState().sendUserMessage(BOT, "hello");
    store.getState().markDelivered(BOT, id);
    store.getState().retryMessage(BOT, id);
    expect(store.getState().threads[BOT][0].status).toBe("delivered");
  });

  describe("group threads", () => {
    it("createGroupThread creates a group entity with deduped participants and a title", () => {
      const id = store.getState().createGroupThread(["b1", "b2", "b1"], "Q3 push");
      expect(id).not.toBe("");
      expect(store.getState().threadsById[id]).toMatchObject({
        id,
        kind: "group",
        participantBotIds: ["b1", "b2"],
        title: "Q3 push",
      });
      expect(store.getState().threadsById[id].createdAt).toBeTypeOf("number");
      expect(store.getState().threads[id]).toEqual([]);
    });

    it("addParticipant adds new members to group threads only", () => {
      const id = store.getState().createGroupThread(["b1"]);
      store.getState().addParticipant(id, "b2");
      store.getState().addParticipant(id, "b2"); // duplicate: no-op
      expect(store.getState().threadsById[id].participantBotIds).toEqual(["b1", "b2"]);

      store.getState().ensureDirectThread(BOT);
      store.getState().addParticipant(BOT, "b2"); // direct threads keep 1 participant
      expect(store.getState().threadsById[BOT].participantBotIds).toEqual([BOT]);
    });

    it("removeParticipant removes members from group threads only", () => {
      const id = store.getState().createGroupThread(["b1", "b2"]);
      store.getState().removeParticipant(id, "b2");
      store.getState().removeParticipant(id, "nope"); // non-member: no-op
      expect(store.getState().threadsById[id].participantBotIds).toEqual(["b1"]);

      store.getState().ensureDirectThread(BOT);
      store.getState().removeParticipant(BOT, BOT);
      expect(store.getState().threadsById[BOT].participantBotIds).toEqual([BOT]);
    });

    it("keeps messages separate per thread for group threads", () => {
      const g1 = store.getState().createGroupThread(["b1", "b2"]);
      store.getState().sendUserMessage(g1, "team hello");
      store.getState().sendUserMessage(BOT, "direct hello");
      expect(store.getState().threads[g1]).toHaveLength(1);
      expect(store.getState().threads[BOT]).toHaveLength(1);
    });
  });

  describe("addBotMessage (bot-to-bot)", () => {
    it("appends a delivered bot message with author and meta", () => {
      const id = store.getState().createGroupThread(["b1", "b2"]);
      const messageId = store
        .getState()
        .addBotMessage(id, "b1", "please compile anomalies", { kind: "delegation" });
      expect(store.getState().threads[id]).toHaveLength(1);
      expect(store.getState().threads[id][0]).toMatchObject({
        id: messageId,
        role: "bot",
        threadId: id,
        authorBotId: "b1",
        text: "please compile anomalies",
        status: "delivered",
        meta: { kind: "delegation" },
      });
    });

    it("rejects authors that are not participants", () => {
      const id = store.getState().createGroupThread(["b1"]);
      expect(store.getState().addBotMessage(id, "intruder", "hi")).toBe("");
      expect(store.getState().threads[id]).toHaveLength(0);
    });

    it("allows non-participant authors for delegation traffic (multi-bot spec)", () => {
      // A delegated bot two hops down posts its delegation card into the
      // originating thread it is not a participant of.
      const id = store.getState().createGroupThread(["b1"]);
      const messageId = store
        .getState()
        .addBotMessage(id, "outsider", "brief", { kind: "delegation", targetBotId: "b3" });
      expect(messageId).not.toBe("");
      expect(store.getState().threads[id][0]).toMatchObject({
        authorBotId: "outsider",
        meta: { kind: "delegation" },
      });
    });

    it("updateMessageMeta merges a patch into a message's meta", () => {
      const id = store.getState().createGroupThread(["b1", "b2"]);
      const messageId = store.getState().addBotMessage(id, "b1", "brief", {
        kind: "delegation",
        targetBotId: "b2",
        status: "in-progress",
        brief: "brief",
      });
      store.getState().updateMessageMeta(id, messageId, {
        status: "done",
        report: "all done",
      });
      expect(store.getState().threads[id][0].meta).toMatchObject({
        kind: "delegation",
        targetBotId: "b2",
        status: "done",
        brief: "brief",
        report: "all done",
      });
      // Unknown message: no-op, no crash.
      store.getState().updateMessageMeta(id, "nope", { status: "failed" });
    });

    it("rejects blank text", () => {
      const id = store.getState().createGroupThread(["b1"]);
      expect(store.getState().addBotMessage(id, "b1", "  \n")).toBe("");
    });

    it("works on direct threads keyed by botId", () => {
      const messageId = store.getState().addBotMessage(BOT, BOT, "report ready", {
        kind: "report",
      });
      expect(messageId).not.toBe("");
      expect(store.getState().threads[BOT][0]).toMatchObject({
        authorBotId: BOT,
        meta: { kind: "report" },
      });
    });

    it("bumps unread for inactive threads but not the active one", () => {
      const id = store.getState().createGroupThread(["b1", "b2"]);
      store.getState().setActiveThread(id);
      store.getState().addBotMessage(id, "b1", "seen live");
      expect(store.getState().unread[id] ?? 0).toBe(0);

      store.getState().setActiveThread(BOT);
      store.getState().addBotMessage(id, "b2", "while away");
      expect(store.getState().unread[id]).toBe(1);
    });
  });

  describe("addTimelineEvent (session task record)", () => {
    it("appends a delivered session event without bumping unread", () => {
      store.getState().setActiveThread("other");
      const id = store
        .getState()
        .addTimelineEvent(BOT, BOT, "Compute session provisioned (local)", {
          kind: "session",
          sessionEvent: "provisioned",
          sessionKind: "local",
        });
      expect(id).not.toBe("");
      expect(store.getState().threads[BOT][0]).toMatchObject({
        role: "bot",
        authorBotId: BOT,
        status: "delivered",
        meta: { kind: "session", sessionEvent: "provisioned" },
      });
      // Subtle indicator, not a message: unread stays untouched.
      expect(store.getState().unread[BOT] ?? 0).toBe(0);
    });

    it("records exec audit entries with the exact command, from any author", () => {
      const id = store.getState().createGroupThread(["b1"]);
      // The bot running the session need not be a thread participant
      // (delegated runs audit into the thread the work ran in).
      const messageId = store
        .getState()
        .addTimelineEvent(id, "outsider", "Compute session provisioned (local)", {
          kind: "session",
          sessionEvent: "provisioned",
          sessionKind: "local",
        });
      expect(messageId).not.toBe("");
      expect(store.getState().threads[id][0].meta?.sessionEvent).toBe("provisioned");
    });

    it("ignores blank event text", () => {
      expect(
        store.getState().addTimelineEvent(BOT, BOT, "  ", { kind: "session" }),
      ).toBe("");
      expect(store.getState().threads[BOT]).toBeUndefined();
    });
  });

  describe("selection", () => {
    it("setActiveThread clears unread for that thread", () => {
      const id = store.getState().createGroupThread(["b1"]);
      store.getState().addBotMessage(id, "b1", "ping");
      expect(store.getState().unread[id]).toBe(1);
      store.getState().setActiveThread(id);
      expect(store.getState().unread[id]).toBe(0);
    });

    it("mirrors activeBotId for direct threads and nulls it for group threads", () => {
      const g = store.getState().createGroupThread(["b1", "b2"]);
      store.getState().setActiveThread(g);
      expect(store.getState().activeThreadId).toBe(g);
      expect(store.getState().activeBotId).toBeNull();

      store.getState().setActiveBot(BOT);
      expect(store.getState().activeThreadId).toBe(BOT);
      expect(store.getState().activeBotId).toBe(BOT);

      store.getState().setActiveThread(null);
      expect(store.getState().activeBotId).toBeNull();
    });

    it("setActiveBot creates the direct thread entity if missing", () => {
      store.getState().setActiveBot("fresh-bot");
      expect(store.getState().threadsById["fresh-bot"]).toMatchObject({
        kind: "direct",
        participantBotIds: ["fresh-bot"],
      });
    });
  });

  it("ensureDirectThread returns the botId and is idempotent", () => {
    expect(store.getState().ensureDirectThread(BOT)).toBe(BOT);
    const entity = store.getState().threadsById[BOT];
    expect(store.getState().ensureDirectThread(BOT)).toBe(BOT);
    expect(store.getState().threadsById[BOT]).toBe(entity);
  });

  describe("persistence", () => {
    it("roundtrips threads and unread through storage", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      a.getState().sendUserMessage(BOT, "hello");
      a.getState().appendBotDelta(BOT, "m1", "world");
      a.getState().finalizeBotMessage(BOT, "m1");
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threads[BOT]).toHaveLength(2);
      expect(b.getState().threads[BOT][0].text).toBe("hello");
      expect(b.getState().threads[BOT][1]).toMatchObject({
        text: "world",
        status: "delivered",
      });
      expect(b.getState().unread[BOT]).toBe(1);
    });

    it("normalizes interrupted streams to error on load", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      a.getState().appendBotDelta(BOT, "m1", "half a mess");
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threads[BOT][0]).toMatchObject({
        status: "error",
        streaming: false,
      });
    });

    it("normalizes interrupted pending sends to error on load", async () => {
      // A user message still "pending" after a restart can never be delivered;
      // it must surface as an error (with Retry) instead of blocking the composer.
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      a.getState().sendUserMessage(BOT, "never delivered");
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threads[BOT][0]).toMatchObject({
        role: "user",
        status: "error",
      });
    });

    // F3 regression: a delegation card persisted "in-progress" lost its run
    // with the app — after a restart it must surface as "interrupted" (with
    // Retry) instead of spinning forever.
    it("normalizes persisted in-progress delegation cards to interrupted on load", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      const groupId = a.getState().createGroupThread(["b1", "b2"], "Push");
      a.getState().addBotMessage(groupId, "b1", "brief text", {
        kind: "delegation",
        targetBotId: "b2",
        delegationId: "d-1",
        status: "in-progress",
        brief: "brief text",
      });
      a.getState().addBotMessage(groupId, "b1", "done brief", {
        kind: "delegation",
        targetBotId: "b2",
        delegationId: "d-2",
        status: "done",
        report: "all good",
      });
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      const [card, resolved] = b.getState().threads[groupId];
      expect(card.meta).toMatchObject({
        kind: "delegation",
        delegationId: "d-1",
        status: "interrupted",
        brief: "brief text",
      });
      // The message itself stays delivered (it is a card, not a stream).
      expect(card.status).toBe("delivered");
      // Resolved delegations are untouched.
      expect(resolved.meta).toMatchObject({ status: "done", report: "all good" });
    });

    it("migrates v1 botId-keyed data losslessly into direct threads", async () => {
      // Fixture in the pre-group persisted shape: version 1, messages keyed by
      // botId, each message carrying botId and no threadId/authorBotId.
      const storage = createMemoryStorage();
      await storage.set("chat.threads", {
        version: 1,
        threads: {
          "bot-a": [
            {
              id: "u1",
              role: "user",
              botId: "bot-a",
              text: "hello",
              status: "delivered",
              createdAt: 100,
            },
            {
              id: "b1",
              role: "bot",
              botId: "bot-a",
              text: "hi there",
              status: "delivered",
              createdAt: 200,
              streaming: false,
            },
          ],
          "bot-b": [
            {
              id: "b2",
              role: "bot",
              botId: "bot-b",
              text: "interrupted strea",
              status: "pending",
              createdAt: 300,
              streaming: true,
            },
          ],
        },
        unread: { "bot-b": 2 },
      });

      const store2 = createChatStore(storage);
      await store2.getState().loadPersisted();
      const state = store2.getState();

      // Every old botId history becomes a direct thread whose id is the botId.
      expect(state.threadsById["bot-a"]).toEqual({
        id: "bot-a",
        kind: "direct",
        participantBotIds: ["bot-a"],
        createdAt: 100,
      });
      expect(state.threadsById["bot-b"]).toMatchObject({
        kind: "direct",
        participantBotIds: ["bot-b"],
      });

      // Messages are lossless: ids, text, roles, timestamps kept; bot messages
      // gain authorBotId; all gain threadId.
      expect(state.threads["bot-a"]).toHaveLength(2);
      expect(state.threads["bot-a"][0]).toMatchObject({
        id: "u1",
        role: "user",
        threadId: "bot-a",
        text: "hello",
        status: "delivered",
        createdAt: 100,
      });
      expect(state.threads["bot-a"][0].authorBotId).toBeUndefined();
      expect(state.threads["bot-a"][1]).toMatchObject({
        id: "b1",
        role: "bot",
        threadId: "bot-a",
        authorBotId: "bot-a",
        text: "hi there",
        createdAt: 200,
      });

      // Interrupted streams still normalize to error on migration.
      expect(state.threads["bot-b"][0]).toMatchObject({
        status: "error",
        streaming: false,
        authorBotId: "bot-b",
      });

      // Unread survives (keyed identically: direct threadId === botId).
      expect(state.unread["bot-b"]).toBe(2);
    });

    it("roundtrips group threads with participants and meta through storage", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      const groupId = a.getState().createGroupThread(["b1", "b2"], "Renewals");
      a.getState().sendUserMessage(groupId, "kick off");
      a.getState().addBotMessage(groupId, "b1", "on it", { kind: "delegation" });
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threadsById[groupId]).toMatchObject({
        kind: "group",
        title: "Renewals",
        participantBotIds: ["b1", "b2"],
      });
      expect(b.getState().threads[groupId]).toHaveLength(2);
      expect(b.getState().threads[groupId][1]).toMatchObject({
        authorBotId: "b1",
        meta: { kind: "delegation" },
      });
    });

    it("auto-persists participant changes (threadsById-only updates)", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemoryStorage();
        const a = createChatStore(storage, 100);
        await a.getState().loadPersisted();
        const groupId = a.getState().createGroupThread(["b1"]);
        await vi.advanceTimersByTimeAsync(150);
        a.getState().addParticipant(groupId, "b2");
        await vi.advanceTimersByTimeAsync(150);
        const persisted = await storage.get<{
          threadsById: Record<string, { participantBotIds: string[] }>;
        }>("chat.threads");
        expect(persisted?.threadsById[groupId].participantBotIds).toEqual(["b1", "b2"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("hydrates cleanly when storage is empty or corrupt", async () => {
      const storage = createMemoryStorage();
      await storage.set("chat.threads", { nonsense: true });
      const a = createChatStore(storage);
      await a.getState().loadPersisted();
      expect(a.getState().hydrated).toBe(true);
      expect(a.getState().threads).toEqual({});
    });

    it("writes settled messages through immediately (task-execution spec, 'Model-visible means logged')", async () => {
      // The thread is the durable half of a resumed run's context, so a
      // message that is finished must not sit in memory waiting for a timer.
      const storage = createMemoryStorage();
      const setSpy = vi.spyOn(storage, "set");
      const a = createChatStore(storage, 100);
      await a.getState().loadPersisted();

      a.getState().sendUserMessage(BOT, "one");
      expect(setSpy).toHaveBeenCalledTimes(1);

      await vi.waitFor(async () => {
        const persisted = await storage.get<{
          version: number;
          messages: Record<string, unknown[]>;
        }>("chat.threads");
        expect(persisted?.version).toBe(2);
        expect(persisted?.messages[BOT]).toHaveLength(1);
      });
    });

    it("debounces streamed deltas rather than writing per token", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemoryStorage();
        const setSpy = vi.spyOn(storage, "set");
        const a = createChatStore(storage, 100);
        await a.getState().loadPersisted();

        a.getState().appendBotDelta(BOT, "b1", "Hel");
        a.getState().appendBotDelta(BOT, "b1", "lo");
        expect(setSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(150);
        expect(setSpy).toHaveBeenCalledTimes(1);

        // Finishing the message settles it: that writes through at once.
        setSpy.mockClear();
        a.getState().finalizeBotMessage(BOT, "b1");
        expect(setSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a long stream cannot starve the write (max wait)", async () => {
      // Reset-on-every-change debouncing never fires while deltas keep
      // arriving, which would leave a chatty bot's thread unwritten for as
      // long as it talks. The cap is what bounds the loss.
      vi.useFakeTimers();
      try {
        const storage = createMemoryStorage();
        const setSpy = vi.spyOn(storage, "set");
        const a = createChatStore(storage, 100, 500);
        await a.getState().loadPersisted();

        // A delta every 50ms — always sooner than the 100ms debounce, so a
        // resetting timer would never fire.
        for (let i = 0; i < 20; i++) {
          a.getState().appendBotDelta(BOT, "b1", `${i} `);
          await vi.advanceTimersByTimeAsync(50);
        }
        expect(setSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-persist before hydration", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemoryStorage();
        const setSpy = vi.spyOn(storage, "set");
        const a = createChatStore(storage, 100);
        a.getState().sendUserMessage(BOT, "early");
        await vi.advanceTimersByTimeAsync(500);
        expect(setSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("choice blocks (messaging spec, 'Structured choice prompts')", () => {
    /** A finalized bot message to hang a choice block on; returns its id. */
    function botMessage(text = "Pick one"): string {
      store.getState().appendBotDelta(BOT, "b1", text);
      store.getState().finalizeBotMessage(BOT, "b1");
      return "b1";
    }

    it("attachChoices attaches a block to a bot message", () => {
      const id = botMessage();
      store
        .getState()
        .attachChoices(BOT, id, { prompt: "How?", options: ["Email", "Slack"] });
      const message = store.getState().threads[BOT][0];
      expect(message.choices).toEqual({ prompt: "How?", options: ["Email", "Slack"] });
      expect(message.text).toBe("Pick one"); // text untouched when omitted
    });

    it("attachChoices replaces the display text when given (marker stripping)", () => {
      const id = botMessage('Pick one\n<<choices>>["A"]<</choices>>');
      store.getState().attachChoices(BOT, id, { options: ["A"] }, "Pick one");
      const message = store.getState().threads[BOT][0];
      expect(message.text).toBe("Pick one");
      expect(message.choices).toEqual({ options: ["A"] });
    });

    it("attachChoices is a no-op for unknown messages", () => {
      botMessage();
      const before = store.getState().threads;
      store.getState().attachChoices(BOT, "nope", { options: ["A"] });
      expect(store.getState().threads).toBe(before);
    });

    it("sendUserMessage marks open choice blocks answered with the sent text (chip tap or free text)", () => {
      const id = botMessage();
      store.getState().attachChoices(BOT, id, { options: ["Email", "Slack"] });
      store.getState().sendUserMessage(BOT, "Email");
      const message = store.getState().threads[BOT][0];
      expect(message.choices?.answeredWith).toBe("Email");
    });

    it("sendUserMessage leaves already-answered blocks untouched", () => {
      const id = botMessage();
      store
        .getState()
        .attachChoices(BOT, id, { options: ["Email", "Slack"], answeredWith: "Slack" });
      store.getState().sendUserMessage(BOT, "actually, carrier pigeon");
      expect(store.getState().threads[BOT][0].choices?.answeredWith).toBe("Slack");
    });

    it("only answers blocks in the same thread", () => {
      const id = botMessage();
      store.getState().attachChoices(BOT, id, { options: ["A", "B"] });
      store.getState().sendUserMessage("bot-2", "hello other bot");
      expect(store.getState().threads[BOT][0].choices?.answeredWith).toBeUndefined();
    });

    it("app-handled cards answer through the same path (one message, card collapses)", () => {
      const id = botMessage("Where should I run commands?");
      store.getState().attachChoices(BOT, id, {
        options: ["This Mac", "A machine I own"],
        handler: "onboarding.compute",
      });
      const sent = store.getState().sendUserMessage(BOT, "This Mac");
      store.getState().markDelivered(BOT, sent);
      const messages = store.getState().threads[BOT];
      // Exactly one user message: the local handler reuses sendUserMessage
      // rather than posting its own copy of the answer.
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(messages[0].choices?.answeredWith).toBe("This Mac");
      expect(messages[0].choices?.handler).toBe("onboarding.compute");
      expect(messages[1].status).toBe("delivered");
    });

    it("roundtrips the handler tag through storage", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      a.getState().appendBotDelta(BOT, "b1", "Where should I run commands?");
      a.getState().finalizeBotMessage(BOT, "b1");
      a.getState()
        .attachChoices(BOT, "b1", { options: ["A"], handler: "onboarding.compute" });
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threads[BOT][0].choices?.handler).toBe("onboarding.compute");
    });

    it("blank sends never answer a block", () => {
      const id = botMessage();
      store.getState().attachChoices(BOT, id, { options: ["A"] });
      store.getState().sendUserMessage(BOT, "   ");
      expect(store.getState().threads[BOT][0].choices?.answeredWith).toBeUndefined();
    });

    it("roundtrips choice blocks through storage", async () => {
      const storage = createMemoryStorage();
      const a = createChatStore(storage);
      a.getState().appendBotDelta(BOT, "b1", "Pick one");
      a.getState().finalizeBotMessage(BOT, "b1");
      a.getState()
        .attachChoices(BOT, "b1", { prompt: "How?", options: ["A", "B"], answeredWith: "A" });
      await a.persistNow();

      const b = createChatStore(storage);
      await b.getState().loadPersisted();
      expect(b.getState().threads[BOT][0].choices).toEqual({
        prompt: "How?",
        options: ["A", "B"],
        answeredWith: "A",
      });
    });
  });
});
