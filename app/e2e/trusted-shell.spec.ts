// Flow: a bot does workspace work without asking, and the record of it lives
// in the Activity log rather than the thread (task-execution spec,
// "Workspace-scoped work needs no per-action approval"; agent-computer spec,
// "Isolation and hygiene"; security spec, "Comprehensive audit log").

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { queueChatReplies } from "./support/mocks";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createBot(page, "Scout");
});

test("shell runs with no approval and no command in the thread", async ({ page }) => {
  // First reply runs a shell command; second is the bot's account of it.
  await queueChatReplies(page, [
    {
      toolCalls: [
        { name: "session_exec", arguments: JSON.stringify({ cmd: "ls -la" }) },
      ],
    },
    { deltas: ["Tidied that up — ", "43 files, 2.1 GB freed."] },
  ]);

  await composer(page).fill("Clean up the temp files");
  await page.keyboard.press("Enter");

  // The bot's account arrives with no approval in between…
  await expect(messageLog(page)).toContainText("43 files, 2.1 GB freed.");
  await expect(page.getByRole("group", { name: /Approval request/ })).toBeHidden();

  // …and the command itself is nowhere in the conversation.
  await expect(messageLog(page).getByText("$ ls -la")).toBeHidden();
  await expect(messageLog(page).getByText("ls -la")).toBeHidden();
});

test("the activity log is where the command actually is", async ({ page }) => {
  await queueChatReplies(page, [
    {
      toolCalls: [
        { name: "session_exec", arguments: JSON.stringify({ cmd: "ls -la" }) },
      ],
    },
    { deltas: ["Done."] },
  ]);

  await composer(page).fill("List the files");
  await page.keyboard.press("Enter");
  await expect(messageLog(page)).toContainText("Done.");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const log = dialog.getByRole("list", { name: "Activity log" });
  const row = log.getByRole("listitem").filter({ hasText: "session_exec" }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("ls -la");
  // Recorded as autonomous, not approved — the distinction the log exists for.
  await expect(row).toContainText("Ran on its own");
  await expect(row).toContainText("Scout");
});
