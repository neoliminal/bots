// Flow: edit a bot's settings, focusing on the model picker search (spec:
// openspec/specs/model-configuration, "Picker ergonomics — featured
// shortlist plus search": typing "anthropic" narrows the ENTIRE catalog to
// Anthropic models instantly; incompatible models are unselectable with the
// reason shown).

import { expect, test } from "@playwright/test";
import { createBot, openApp } from "./support/helpers";
import { ANTHROPIC_FIXTURE_COUNT } from "./support/mocks";

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createBot(page, "Scout");
});

test("edit bot: model search filters by 'anthropic' and saves the pick", async ({ page }) => {
  await page.getByRole("button", { name: "Bot settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Scout settings" });
  await expect(dialog).toBeVisible();

  // Search filters the whole catalog down to Anthropic models only.
  const search = dialog.getByRole("searchbox", { name: "Search models" });
  await search.fill("anthropic");
  const results = dialog.getByRole("listbox", { name: "Search results" });
  await expect(results.getByRole("option")).toHaveCount(ANTHROPIC_FIXTURE_COUNT);
  await expect(results.getByRole("option", { name: /Claude Sonnet 4\.5/ })).toBeVisible();
  await expect(results.getByRole("option", { name: /Claude Opus 4\.1/ })).toBeVisible();
  await expect(results.getByRole("option", { name: /Claude Haiku 4\.5/ })).toBeVisible();
  await expect(dialog.getByText("GPT-5", { exact: true })).toBeHidden();
  await expect(dialog.getByText("Gemini 2.5 Pro")).toBeHidden();

  // Pick a filtered model and save.
  await results.getByRole("option", { name: /Claude Opus 4\.1/ }).click();
  await expect(dialog.getByText("anthropic/claude-opus-4.1")).toBeVisible();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  // Reopen: the saved primary model is shown as current.
  await page.getByRole("button", { name: "Bot settings" }).click();
  const reopened = page.getByRole("dialog", { name: "Scout settings" });
  await expect(reopened.getByText("anthropic/claude-opus-4.1")).toBeVisible();
  await reopened.getByRole("button", { name: "Close" }).click();
});

test("edit bot: tool access policy saves and persists (blocked shell, floor never loosens)", async ({ page }) => {
  await page.getByRole("button", { name: "Bot settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Scout settings" });
  await expect(dialog).toBeVisible();

  // The Tool access section lists tool groups with per-group rules.
  const section = dialog.getByRole("group", { name: "Tool access" });
  await expect(section).toBeVisible();

  // Block local shell for this bot and save.
  await section
    .getByRole("combobox", { name: "Shell on your own machines access" })
    .selectOption("deny");

  // Hard floor: Permanent deletion offers Ask first / Blocked but no Allowed.
  const floor = section.getByRole("combobox", { name: "Permanent deletion access" });
  await expect(floor.getByRole("option", { name: "Allowed", exact: true })).toHaveCount(0);
  await expect(floor.getByRole("option", { name: "Ask first", exact: true })).toHaveCount(1);

  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  // Reopen: the choice persisted.
  await page.getByRole("button", { name: "Bot settings" }).click();
  const reopened = page.getByRole("dialog", { name: "Scout settings" });
  await expect(
    reopened.getByRole("combobox", { name: "Shell on your own machines access" }),
  ).toHaveValue("deny");
  await reopened.getByRole("button", { name: "Close" }).click();
});

test("edit bot: models without tool calling are unselectable with a reason", async ({ page }) => {
  await page.getByRole("button", { name: "Bot settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Scout settings" });

  await dialog.getByRole("searchbox", { name: "Search models" }).fill("mistral");
  const results = dialog.getByRole("listbox", { name: "Search results" });
  const noTools = results.getByRole("option", { name: /Mistral Small 3\.2/ });
  await expect(noTools).toBeDisabled();
  await expect(noTools).toContainText("No tool calling — Bots require tool support");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
