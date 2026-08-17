import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./bots";
import {
  createWorklogStore,
  GENERAL_CATEGORY_ID,
  hydrateWorklog,
  inferTaskCategory,
  MAX_WORKLOG_ENTRIES,
  recordCompletedWork,
  resetWorklogStores,
  worklogStorageKey,
  type CompletedWorkInput,
  type WorkRecord,
} from "./worklog";

function makeWork(overrides: Partial<CompletedWorkInput> = {}): CompletedWorkInput {
  return {
    taskTitle: "Process March invoices",
    threadId: "thread-1",
    toolsUsed: ["pdf_extract", "spreadsheet"],
    deliverables: ["march-invoices.csv"],
    at: 1_700_000_000_000,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("inferTaskCategory", () => {
  it("clusters titles by keyword, first matching cluster wins", () => {
    expect(inferTaskCategory("Process March invoices")).toBe("invoice-processing");
    expect(inferTaskCategory("Research the ACME account")).toBe("research");
    expect(inferTaskCategory("Follow up with cold leads")).toBe("outreach");
    expect(inferTaskCategory("Triage overnight support tickets")).toBe("support-triage");
    expect(inferTaskCategory("Prepare the meeting agenda")).toBe("scheduling");
    expect(inferTaskCategory("Draft the launch announcement")).toBe("writing");
    expect(inferTaskCategory("Build the weekly metrics report")).toBe("reporting");
  });

  it("falls back to the general bucket when nothing matches", () => {
    expect(inferTaskCategory("Water the office plants")).toBe(GENERAL_CATEGORY_ID);
  });
});

describe("WorklogStore", () => {
  it("record appends, assigns ids, and persists", async () => {
    const storage = createMemoryStorage();
    const store = createWorklogStore("bot-1", storage);

    const entry = store.record(makeWork());
    expect(entry.id).toBeTruthy();
    expect(store.list()).toEqual([entry]);

    await flush();
    const fresh = createWorklogStore("bot-1", storage);
    await fresh.hydrate();
    expect(fresh.list()).toEqual([entry]);
  });

  it("retains only the latest MAX_WORKLOG_ENTRIES records", async () => {
    const storage = createMemoryStorage();
    const store = createWorklogStore("bot-1", storage);

    for (let i = 0; i < MAX_WORKLOG_ENTRIES + 5; i++) {
      store.record(makeWork({ taskTitle: `task ${i}`, at: i }));
    }

    const list = store.list();
    expect(list).toHaveLength(MAX_WORKLOG_ENTRIES);
    expect(list[0].taskTitle).toBe("task 5"); // oldest five trimmed
    expect(list[list.length - 1].taskTitle).toBe(`task ${MAX_WORKLOG_ENTRIES + 4}`);

    await flush();
    const persisted = await storage.get<WorkRecord[]>(worklogStorageKey("bot-1"));
    expect(persisted).toHaveLength(MAX_WORKLOG_ENTRIES);
  });

  it("recent returns newest first with a limit", () => {
    const store = createWorklogStore("bot-1", createMemoryStorage());
    store.record(makeWork({ taskTitle: "old", at: 100 }));
    store.record(makeWork({ taskTitle: "newest", at: 300 }));
    store.record(makeWork({ taskTitle: "middle", at: 200 }));

    expect(store.recent(2).map((r) => r.taskTitle)).toEqual(["newest", "middle"]);
  });

  it("countsByTool counts records per tool, deduped within a record", () => {
    const store = createWorklogStore("bot-1", createMemoryStorage());
    store.record(makeWork({ toolsUsed: ["web_search", "web_search", "pdf_extract"] }));
    store.record(makeWork({ toolsUsed: ["web_search"] }));

    expect(store.countsByTool()).toEqual({ web_search: 2, pdf_extract: 1 });
  });

  it("records which execution path a step used via tool names (CLI session vs MCP)", () => {
    // Task-execution "Execution preference order": the timeline/worklog
    // evidence for the chosen path is the tool name itself — session_exec
    // for the CLI path, mcp__<server>__<tool> for the connector path.
    const store = createWorklogStore("bot-1", createMemoryStorage());
    store.record(makeWork({ toolsUsed: ["session_exec"] }));
    store.record(makeWork({ toolsUsed: ["mcp__helpdesk__create_ticket"] }));

    expect(store.countsByTool()).toEqual({
      session_exec: 1,
      mcp__helpdesk__create_ticket: 1,
    });
  });

  it("countsByCategory buckets by inferred task category", () => {
    const store = createWorklogStore("bot-1", createMemoryStorage());
    store.record(makeWork({ taskTitle: "Process invoices" }));
    store.record(makeWork({ taskTitle: "File expense receipts" }));
    store.record(makeWork({ taskTitle: "Research competitors" }));
    store.record(makeWork({ taskTitle: "Feed the goldfish" }));

    expect(store.countsByCategory()).toEqual({
      "invoice-processing": 2,
      research: 1,
      [GENERAL_CATEGORY_ID]: 1,
    });
  });

  it("subscribe fires immediately and on every record", () => {
    const store = createWorklogStore("bot-1", createMemoryStorage());
    const seen: number[] = [];
    const unsub = store.subscribe((records) => seen.push(records.length));

    store.record(makeWork());
    unsub();
    store.record(makeWork());

    expect(seen).toEqual([0, 1]);
  });
});

describe("shared store cache / recordCompletedWork", () => {
  it("hydrates persisted history before appending", async () => {
    resetWorklogStores();
    const storage = createMemoryStorage();
    const seeded = createWorklogStore("bot-2", storage);
    seeded.record(makeWork({ taskTitle: "seeded run", at: 1 }));
    await flush();

    const entry = await recordCompletedWork(
      "bot-2",
      makeWork({ taskTitle: "new run", at: 2 }),
      storage,
    );

    const store = await hydrateWorklog("bot-2", storage);
    expect(store.list().map((r) => r.taskTitle)).toEqual(["seeded run", "new run"]);
    expect(entry.taskTitle).toBe("new run");
    resetWorklogStores();
  });

  it("returns the same instance per bot id", async () => {
    resetWorklogStores();
    const storage = createMemoryStorage();
    const a = await hydrateWorklog("bot-3", storage);
    const b = await hydrateWorklog("bot-3", storage);
    expect(a).toBe(b);
    resetWorklogStores();
  });
});
