// Flow: a run interrupted by the app closing resumes on next launch with the
// work it already did intact (task-execution spec, "Durable, resumable
// execution"). The reload is the interruption: nothing gets to run a
// terminal path, exactly as in a quit or a crash.

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { chatRequests, hangNextExec, queueChatReplies } from "./support/mocks";

test("an interrupted run picks up where it left off", async ({ page }) => {
  await openApp(page);
  await createBot(page, "Scout");

  // The model asks for a command that never returns, so the reload lands
  // while the step is genuinely in flight — the case where the log holds a
  // tool call with no result.
  await hangNextExec(page);
  await queueChatReplies(page, [
    {
      toolCalls: [
        { name: "session_exec", arguments: JSON.stringify({ cmd: "ls -la" }) },
      ],
    },
    { deltas: ["All done."] },
  ]);

  await composer(page).fill("List the files");
  await page.keyboard.press("Enter");

  // Wait for the state a crash would find: the call recorded, its result
  // not. Waiting on the request going out is too early — the assistant's
  // tool call is recorded only once that request comes back.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (localStorage.getItem("bots.engine.runLog") ?? "").includes("assistant-calls"),
      ),
    )
    .toBe(true);

  // The interruption — abrupt, with no chance to flush anything. Settled
  // messages are written through as they happen, so the thread history a
  // resumed run needs is already durable.
  await page.reload();

  // A relaunch opens on no thread, so open the bot's the way a user would.
  await page.getByRole("button", { name: /^Scout/ }).first().click();

  // The bot says it is resuming rather than starting over…
  await expect(
    messageLog(page).getByText(/Picking up where I left off/),
  ).toBeVisible();

  // …and the resumed request carries the earlier step: the assistant's tool
  // call and its result are both in the messages sent after the reload.
  const requests = await chatRequests(page);
  const resumed = requests[requests.length - 1];
  const roles = (resumed.messages as Array<{ role: string }>).map((m) => m.role);
  expect(roles).toContain("assistant");
  expect(roles).toContain("tool");
  expect(JSON.stringify(resumed.messages)).toContain("ls -la");
});
