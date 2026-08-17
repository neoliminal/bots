// Flow: the dev-only avatar gallery (spec: openspec/specs/bot-avatars —
// one avatar per runtime state, labeled) opens from the developer menu and
// returns to chat.

import { expect, test } from "@playwright/test";
import { openApp } from "./support/helpers";

test("avatar gallery opens from the dev menu and returns to chat", async ({ page }) => {
  await openApp(page);

  // Open the developer menu and switch to the gallery.
  await page.getByRole("button", { name: "Developer menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Avatar gallery" }).click();

  await expect(page.getByRole("heading", { name: "Avatar gallery" })).toBeVisible();

  // One labeled avatar per runtime state (spot-check a few distinct states).
  await expect(page.getByRole("img", { name: "Bot 1 — idle" })).toBeVisible();
  await expect(page.getByRole("img", { name: /— thinking$/ })).toBeVisible();
  await expect(page.getByText("sleeping", { exact: true })).toBeVisible();

  // Back to chat restores the normal view.
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("heading", { name: "Avatar gallery" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Start with an Assistant" }),
  ).toBeVisible();
});
