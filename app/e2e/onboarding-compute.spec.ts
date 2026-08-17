// First-run compute-location flow (agent-computer spec, "Onboarding compute
// location choice" + "Guided personal-host setup during onboarding").
//
// The whole flow is app-answered: no chat-completions request may be made
// while it runs, which these specs assert directly — onboarding has to work
// before an API key exists.

import { expect, test } from "@playwright/test";
import { composer, messageLog, openApp } from "./support/helpers";
import { chatRequests, setHostState } from "./support/mocks";

/** Quick-create the first bot from the empty state. */
async function startFirstBot(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Start with an Assistant" }).click();
  await expect(messageLog(page).getByText("Where should I run commands?")).toBeVisible();
}

test("the first bot asks where it should work, and every answer is one click", async ({
  page,
}) => {
  await openApp(page);
  await startFirstBot(page);
  const log = messageLog(page);

  await expect(log.getByRole("button", { name: /^This computer —/ })).toBeVisible();
  await expect(log.getByRole("button", { name: /^A machine I own —/ })).toBeVisible();
  await expect(log.getByRole("button", { name: /^A cloud VM —/ })).toBeVisible();
  await expect(log.getByRole("button", { name: /^Decide later/ })).toBeVisible();
  // Starter tasks wait their turn; the composer is never blocked.
  await expect(log.getByText("What should I take on first?")).toBeHidden();
  await expect(composer(page)).toBeEnabled();

  await log.getByRole("button", { name: /^This computer —/ }).click();
  await expect(log.getByText(/Right here it is/)).toBeVisible();
  await expect(log.getByText("What should I take on first?")).toBeVisible();
  // Answered entirely by the app — no model was involved.
  expect(await chatRequests(page)).toHaveLength(0);
});

test("a discovered machine is one click from being verified and selected", async ({
  page,
}) => {
  await openApp(page);
  await setHostState(page, { hosts: ["minipc.local"], reachable: true, user: "neo" });
  await startFirstBot(page);
  const log = messageLog(page);

  await log.getByRole("button", { name: /^A machine I own —/ }).click();
  // Discovery result offered as a chip, with the account name filled in.
  const chip = log.getByRole("button", { name: "neo@minipc.local" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(log.getByText(/neo@minipc\.local answered/)).toBeVisible();
  await expect(log.getByText("What should I take on first?")).toBeVisible();
  expect(await chatRequests(page)).toHaveLength(0);
});

test("an unreachable machine says what to fix and offers the local fallback", async ({
  page,
}) => {
  await openApp(page);
  await setHostState(page, { hosts: ["minipc.local"], reachable: false, user: "neo" });
  await startFirstBot(page);
  const log = messageLog(page);

  await log.getByRole("button", { name: /^A machine I own —/ }).click();
  await log.getByRole("button", { name: "neo@minipc.local" }).click();
  await expect(log.getByText(/couldn't reach neo@minipc\.local/)).toBeVisible();
  // Never a dead end: both next steps are clickable.
  await expect(log.getByRole("button", { name: "Look again" })).toBeVisible();
  const fallback = log.getByRole("button", { name: "Use this computer for now" });
  await expect(fallback).toBeVisible();

  await fallback.click();
  await expect(log.getByText("What should I take on first?")).toBeVisible();
});

test("no machines found still leads somewhere, and only the first bot is asked", async ({
  page,
}) => {
  await openApp(page);
  await setHostState(page, { hosts: [] });
  await startFirstBot(page);
  const log = messageLog(page);

  await log.getByRole("button", { name: /^A machine I own —/ }).click();
  await expect(log.getByText(/couldn't spot one/)).toBeVisible();
  await log.getByRole("button", { name: "Use this computer for now" }).click();
  await expect(log.getByText("What should I take on first?")).toBeVisible();

  // A second bot goes straight to starter tasks.
  await page.getByRole("button", { name: "New Bot", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Bot" });
  await dialog.getByLabel("Name").fill("Scout");
  await dialog.getByRole("button", { name: "Create Bot" }).click();
  await expect(dialog).toBeHidden();
  await expect(log.getByText("What should I take on first?")).toBeVisible();
  await expect(log.getByText("Where should I run commands?")).toBeHidden();
});
