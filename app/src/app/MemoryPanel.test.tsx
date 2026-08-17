import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  botInstances,
  configureEngineStorage,
  createMemoryStorage,
  getMemoryStore,
  resetMemoryStores,
} from "../lib/engine";
import { MemoryPanel } from "./MemoryPanel";

describe("MemoryPanel", () => {
  beforeEach(() => {
    configureEngineStorage(createMemoryStorage());
    resetMemoryStores();
    botInstances.reset();
  });

  it("shows an empty state when the bot has no memories", async () => {
    render(<MemoryPanel botId="b1" />);
    expect(await screen.findByTestId("memory-empty")).toBeInTheDocument();
  });

  it("lists entries with their text and updated time", async () => {
    getMemoryStore("b1").remember("User prefers short emails");
    getMemoryStore("b1").remember("Never contact accounts owned by Dana");

    render(<MemoryPanel botId="b1" />);
    expect(await screen.findByText("User prefers short emails")).toBeInTheDocument();
    expect(screen.getByText("Never contact accounts owned by Dana")).toBeInTheDocument();
    expect(screen.getAllByText(/^Updated /)).toHaveLength(2);
  });

  it("edits an entry in place", async () => {
    const user = userEvent.setup();
    getMemoryStore("b1").remember("Old pricing sheet");

    render(<MemoryPanel botId="b1" />);
    await user.click(
      await screen.findByRole("button", { name: "Edit memory: Old pricing sheet" }),
    );
    const textarea = screen.getByLabelText("Edit memory text");
    await user.clear(textarea);
    await user.type(textarea, "Use the March pricing sheet");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Use the March pricing sheet")).toBeInTheDocument();
    const entries = getMemoryStore("b1").list();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("Use the March pricing sheet");
    expect(entries[0].updatedAt).toBeGreaterThanOrEqual(entries[0].createdAt);
  });

  it("deletes an entry immediately", async () => {
    const user = userEvent.setup();
    getMemoryStore("b1").remember("Obsolete note");

    render(<MemoryPanel botId="b1" />);
    await user.click(
      await screen.findByRole("button", { name: "Delete memory: Obsolete note" }),
    );

    expect(await screen.findByTestId("memory-empty")).toBeInTheDocument();
    expect(getMemoryStore("b1").list()).toHaveLength(0);
  });

  // Bot-memory spec, "Instance memory merge": conflicts are flagged in the
  // panel's history showing both versions, restorable by the user.
  it("shows instance merge history with conflicts and restores the discarded version", async () => {
    const user = userEvent.setup();
    const store = getMemoryStore("b1");
    const entry = store.remember("Use the old pricing sheet");

    // Real instance flow: spawn from a snapshot, then both sides edit the
    // same entry; the instance's newer edit wins on merge-back.
    const spawned = botInstances.spawn({ id: "b1", name: "Scout" });
    expect(spawned.ok).toBe(true);
    const instanceId = spawned.ok ? spawned.instance.instanceId : "";
    store.editEntry(entry.id, "Canonical edit");
    await new Promise((resolve) => setTimeout(resolve, 5));
    botInstances.memoryOf(instanceId)!.editEntry(entry.id, "Instance edit");
    const record = botInstances.complete(instanceId);
    expect(record?.conflicts).toHaveLength(1);

    render(<MemoryPanel botId="b1" />);
    expect(await screen.findByTestId("merge-record")).toBeInTheDocument();
    const conflict = screen.getByTestId("merge-conflict");
    expect(conflict).toHaveTextContent("Kept: Instance edit");
    expect(conflict).toHaveTextContent("Discarded: Canonical edit");
    // The entry currently holds the kept (instance) version.
    expect(getMemoryStore("b1").list()[0].text).toBe("Instance edit");

    await user.click(
      screen.getByRole("button", {
        name: "Restore discarded version: Canonical edit",
      }),
    );
    expect(getMemoryStore("b1").list()[0].text).toBe("Canonical edit");
  });

  it("re-adds a restored conflict version when the entry was deleted", async () => {
    const user = userEvent.setup();
    const store = getMemoryStore("b1");
    const entry = store.remember("Original");
    const spawned = botInstances.spawn({ id: "b1", name: "Scout" });
    const instanceId = spawned.ok ? spawned.instance.instanceId : "";
    store.editEntry(entry.id, "Canonical edit");
    await new Promise((resolve) => setTimeout(resolve, 5));
    botInstances.memoryOf(instanceId)!.editEntry(entry.id, "Instance edit");
    botInstances.complete(instanceId);
    // The user then deletes the merged entry entirely.
    store.deleteEntry(entry.id);

    render(<MemoryPanel botId="b1" />);
    await user.click(
      await screen.findByRole("button", {
        name: "Restore discarded version: Canonical edit",
      }),
    );
    const texts = getMemoryStore("b1").list().map((e) => e.text);
    expect(texts).toContain("Canonical edit");
  });
});
