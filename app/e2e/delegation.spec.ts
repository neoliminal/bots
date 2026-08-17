// Flow: transparent peer delegation (spec: openspec/specs/
// multi-bot-collaboration — "Delegation visibility without group chats").
// The mocked model has the requesting bot call contact_bot; the app renders
// an inline collapsible delegation card in the ORIGINATING (direct) thread
// with the target's name, live status, and — once the delegated run
// resolves — the target's report.

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { queueChatReplies } from "./support/mocks";

test("a delegating bot shows an inline delegation card that resolves with the report", async ({
  page,
}) => {
  await openApp(page);

  await createBot(page, "EA");
  await createBot(page, "Scout");

  // Open EA's direct thread (delegation needs no group thread).
  const sidebar = page.getByRole("navigation", { name: "Bots" });
  await sidebar.getByRole("button", { name: /EA/ }).click();
  await expect(page.getByRole("heading", { name: "EA", exact: true })).toBeVisible();

  // Script the model: EA's first round calls contact_bot(Scout); the next
  // request (Scout handling the brief) returns the report; EA's wrap-up
  // round falls through to the default streamed reply.
  await queueChatReplies(page, [
    {
      toolCalls: [
        {
          name: "contact_bot",
          arguments: JSON.stringify({
            botName: "Scout",
            brief: "Compile this week's findings into a short summary.",
          }),
        },
      ],
    },
    { deltas: ["Here is the compiled", " findings summary."] },
  ]);

  await composer(page).fill("Have Scout compile this week's findings");
  await composer(page).press("Enter");

  // The inline delegation card appears in EA's thread, targeting Scout.
  const log = messageLog(page);
  const card = log.getByTestId("delegation-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("asked Scout");
  await expect(card).toContainText("Compile this week's findings");

  // Live status resolves to done once Scout's run finishes.
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  // Expanding the card reveals the full brief and Scout's report.
  await card.getByRole("button", { name: /Delegation to Scout/ }).click();
  const detail = log.getByTestId("delegation-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(
    "Compile this week's findings into a short summary.",
  );
  await expect(detail).toContainText("Here is the compiled findings summary.");

  // EA still delivers its own (default mocked) reply after the delegation.
  await expect(log.getByText("I am your mocked bot reply.")).toBeVisible();
});
