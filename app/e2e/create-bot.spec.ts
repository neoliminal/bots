// Flow: create a bot (spec: openspec/specs/bot-management, "Bot creation
// with role definition" + "Role description first guess"; model pick per
// openspec/specs/model-configuration, "Picker ergonomics").

import { expect, test } from "@playwright/test";
import { composer, messageLog, openApp, settleComputeQuestion } from "./support/helpers";
import { chatRequests } from "./support/mocks";

test("create a bot: role prefill, featured model pick, save", async ({ page }) => {
  await openApp(page);

  // Empty state offers one-click creation, with the full editor secondary
  // (design pillar: typing is optional). This spec covers the editor.
  await page.getByRole("button", { name: "Customize your own…" }).click();

  const dialog = page.getByRole("dialog", { name: "New Bot" });
  await expect(dialog).toBeVisible();

  // Role description never starts blank: prefilled with the Personal
  // Assistant first guess, with suggestion chips beneath it.
  const role = dialog.getByLabel("Role description");
  await expect(role).toHaveValue(/general-purpose helper/i);
  await expect(
    dialog.getByRole("group", { name: "Role suggestions" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Personal Assistant" }),
  ).toHaveAttribute("aria-pressed", "true");

  await dialog.getByLabel("Name").fill("Scout");

  // Featured shortlist (flagships + utility pick) renders from the mocked
  // catalog; pick a featured model.
  const featured = dialog.getByRole("listbox", { name: "Featured models" });
  await expect(featured.getByRole("option", { name: /Claude Sonnet 4\.5/ })).toBeVisible();
  await expect(featured.getByRole("option", { name: /Claude Haiku 4\.5/ })).toBeVisible();
  await featured.getByRole("option", { name: /^GPT-5 openai/ }).click();
  await expect(dialog.getByText("anthropic/claude-sonnet-4.5")).toBeHidden();
  await expect(dialog.getByText("openai/gpt-5", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Create Bot" }).click();
  await expect(dialog).toBeHidden();

  // The bot is immediately messageable: sidebar entry + open thread. The
  // row is matched as a whole (its preview repeats the name, which the
  // introduction greeting puts there too).
  await expect(
    page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
      name: /^Scout — idle/,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scout" })).toBeVisible();

  // The first bot is asked where it should work before anything else; this
  // spec is about creation, so take the default (agent-computer spec).
  await settleComputeQuestion(page);

  // First message goes out using the model chosen at creation. It matches
  // twice — bubble plus the starter card's receipt — so take the first.
  await composer(page).fill("Hello Scout");
  await composer(page).press("Enter");
  await expect(messageLog(page).getByText("Hello Scout").first()).toBeVisible();
  await expect.poll(async () => (await chatRequests(page)).length).toBeGreaterThan(0);
  const requests = await chatRequests(page);
  expect(requests[0].model).toBe("openai/gpt-5");
});
