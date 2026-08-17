// Flow: messaging a bot (spec: openspec/specs/messaging, "Direct message
// threads with Bots" + "Interruption and cancellation"). The reply is a
// mocked OpenRouter SSE stream (see support/mocks.ts) so streaming UI is
// deterministic.

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { DEFAULT_REPLY_TEXT, chatRequests, setChatReply } from "./support/mocks";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createBot(page, "Scout");
});

test("send a message and watch the reply stream in", async ({ page }) => {
  // Slow the default stream a little so the mid-stream assertions have a
  // comfortable window (7 deltas x 250ms ≈ 1.75s).
  await setChatReply(page, { delayMs: 250 });

  await composer(page).fill("Hello Scout, what can you do?");
  await composer(page).press("Enter");

  const log = messageLog(page);
  // The user message lands in the thread immediately. It matches twice by
  // design: once as the message bubble, once as the receipt of the bot's
  // starter-task card, which free text answers and collapses (messaging
  // spec, "Structured choice prompts").
  const sent = log.getByText("Hello Scout, what can you do?");
  await expect(sent.first()).toBeVisible();
  await expect(log.getByTestId("choice-chips").last()).toHaveAttribute(
    "data-answered",
    "true",
  );

  // A streaming indicator shows while deltas arrive…
  await expect(log.getByLabel("Bot is typing")).toBeVisible();

  // …and the assembled reply is the full fixture text, with the
  // indicator gone once the stream completes.
  await expect(log.getByText(DEFAULT_REPLY_TEXT)).toBeVisible();
  await expect(log.getByLabel("Bot is typing")).toBeHidden();

  // The request went to the (mocked) provider with the default model.
  const requests = await chatRequests(page);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("anthropic/claude-sonnet-4.5");
  expect(requests[0].stream).toBe(true);
});

test("stop button appears while streaming and cancels the reply", async ({ page }) => {
  // A long, slow stream so the in-flight window is wide and deterministic.
  await setChatReply(page, {
    deltas: Array.from({ length: 200 }, (_, i) => `word${i} `),
    delayMs: 100,
  });

  await composer(page).fill("Write me something long");
  await composer(page).press("Enter");

  // While the reply is in flight the Send control becomes Stop.
  const stopButton = page.getByRole("button", { name: "Stop" });
  await expect(stopButton).toBeVisible();
  await expect(messageLog(page).getByLabel("Bot is typing")).toBeVisible();

  // Let a little of the reply arrive, then cancel.
  await expect(messageLog(page).getByText(/word2 /)).toBeVisible();
  await stopButton.click();

  // Streaming ends: Stop reverts to Send, indicator goes away, and the
  // partial reply is kept in the thread.
  await expect(stopButton).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(messageLog(page).getByLabel("Bot is typing")).toBeHidden();
  await expect(messageLog(page).getByText(/word0 word1 /)).toBeVisible();

  // The composer accepts a new message after cancelling.
  await composer(page).fill("Follow-up after stop");
  await composer(page).press("Enter");
  await expect(messageLog(page).getByText("Follow-up after stop")).toBeVisible();
});
