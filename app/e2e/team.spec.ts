// Flow: creating a team (group thread) and messaging it (specs:
// openspec/specs/messaging "Group threads"; group threads are OPTIONAL UI —
// delegation itself needs no group thread per multi-bot-collaboration). The
// reply is the mocked OpenRouter SSE stream, routed to the first participant.

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { DEFAULT_REPLY_TEXT } from "./support/mocks";

test("create a team, message it, and see the first participant's attributed reply", async ({
  page,
}) => {
  await openApp(page);

  // An Executive Assistant (just a well-described bot) plus a specialist.
  await createBot(page, "EA");
  await createBot(page, "Scout");

  // Create the team through the New Team modal.
  await page.getByRole("button", { name: "New Team", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Team" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Team name").fill("Q3 Push");
  await dialog.getByRole("checkbox", { name: "EA", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Scout", exact: true }).check();
  await dialog.getByRole("button", { name: "Create Team" }).click();
  await expect(dialog).toBeHidden();

  // The group thread opens and the sidebar gains a Teams section.
  await expect(page.getByRole("heading", { name: "Q3 Push" })).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Bots" });
  await expect(sidebar).toContainText("Teams");
  await expect(sidebar).toContainText("Q3 Push");

  // Messaging the team routes to the first participant; the reply is attributed.
  await composer(page).fill("Team, kick off the renewal push");
  await composer(page).press("Enter");

  const log = messageLog(page);
  await expect(log.getByText("Team, kick off the renewal push")).toBeVisible();
  await expect(log.getByText(DEFAULT_REPLY_TEXT)).toBeVisible();
  await expect(log.getByText("EA", { exact: true })).toBeVisible();

  // Switching back to a direct thread still works from the Bots section.
  await sidebar.getByRole("button", { name: /Scout/ }).click();
  await expect(
    page.getByRole("heading", { name: "Scout", exact: true }),
  ).toBeVisible();
});
