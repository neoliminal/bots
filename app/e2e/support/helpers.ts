// Shared flow helpers. All selection is by accessible role/label/text —
// never DOM structure — so thread-internals refactors don't break these.

import { expect, type Page } from "@playwright/test";
import { installMocks } from "./mocks";

/** Install all mocks and open the app on a fresh origin (clean localStorage). */
export async function openApp(page: Page): Promise<void> {
  await installMocks(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Bots", exact: true }),
  ).toBeVisible();
}

/**
 * Create a bot through the real UI: open the editor, name it, optionally pick
 * a model from the Featured list, and submit. Resolves once the bot's thread
 * header is showing.
 */
export async function createBot(
  page: Page,
  name: string,
  options: { featuredModelName?: string } = {},
): Promise<void> {
  // The sidebar's "New Bot" button is present in both the empty state and a
  // populated roster (the empty state's own CTA is covered by create-bot.spec).
  await page.getByRole("button", { name: "New Bot", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "New Bot" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);

  if (options.featuredModelName) {
    const featured = dialog.getByRole("listbox", { name: "Featured models" });
    await featured
      .getByRole("option", { name: options.featuredModelName })
      .click();
  }

  await dialog.getByRole("button", { name: "Create Bot" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await settleComputeQuestion(page);
}

/**
 * The first bot ever created opens with the compute-location question
 * (agent-computer spec). Specs that aren't about onboarding answer it with
 * "This computer" — the default — so they start from a settled thread.
 * A no-op for every later bot, which is never asked.
 */
export async function settleComputeQuestion(page: Page): Promise<void> {
  const thisComputer = messageLog(page).getByRole("button", { name: /^This computer —/ });
  if ((await thisComputer.count()) > 0) await thisComputer.click();
}

/** The message composer textarea. */
export function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message" });
}

/** The thread message log region. */
export function messageLog(page: Page) {
  return page.getByRole("log", { name: "Messages" });
}
