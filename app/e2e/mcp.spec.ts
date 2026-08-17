// Flow: register an MCP server in settings, then use its tool end-to-end
// (specs: tool-extensibility "MCP server integration" — zero-code tool
// addition, namespacing, per-bot visibility; policy-hook gating — the
// external-comms default parks an approval before the call runs).
//
// The Tauri bridge mock answers mcp_connect with a single "echo" tool and
// mcp_call by echoing the text argument (see support/mocks.ts).

import { expect, test } from "@playwright/test";
import { composer, createBot, messageLog, openApp } from "./support/helpers";
import { chatRequests, queueChatReplies } from "./support/mocks";

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

/** Register the fixture MCP server through the settings UI. */
async function addHelpdeskServer(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("textbox", { name: "MCP server name" }).fill("helpdesk");
  await dialog.getByRole("textbox", { name: "MCP server command" }).fill("hd --stdio");
  await dialog.getByRole("button", { name: "Connect server" }).click();
  const row = dialog.getByRole("list", { name: "Connected MCP servers" }).getByRole("listitem");
  await expect(row).toContainText("helpdesk");
  await expect(row).toContainText("connected");
  await expect(row).toContainText("1 tool");
  await dialog.getByRole("button", { name: "Close" }).click();
}

test("register server, approve the gated call, tool result feeds the reply", async ({ page }) => {
  await createBot(page, "Scout");
  await addHelpdeskServer(page);

  // The model's first reply calls the MCP tool; the second is text.
  await queueChatReplies(page, [
    {
      toolCalls: [
        { name: "mcp__helpdesk__echo", arguments: JSON.stringify({ text: "ping" }) },
      ],
    },
    { deltas: ["The helpdesk says: ", "echo: ping"] },
  ]);

  await composer(page).fill("Ask the helpdesk to echo ping");
  await page.keyboard.press("Enter");

  // external-comms default policy: the call parks an approval first.
  const approval = page.getByRole("group", { name: /Approval request/ });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("mcp__helpdesk__echo");
  await approval.getByRole("button", { name: "Allow" }).click();

  // Approved: the tool ran (mock echoes) and the follow-up reply streamed.
  await expect(messageLog(page)).toContainText("The helpdesk says: echo: ping");

  // The tool schema went to the model under its namespaced name.
  const requests = await chatRequests(page);
  const offered = (requests[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? [];
  expect(offered.map((t) => t.function.name)).toContain("mcp__helpdesk__echo");
});

test("a bot whose policy blocks external comms never sees the MCP tool", async ({ page }) => {
  await createBot(page, "Scout");
  await addHelpdeskServer(page);

  // Block external messages & connectors for this bot.
  await page.getByRole("button", { name: "Bot settings" }).click();
  const editor = page.getByRole("dialog", { name: "Scout settings" });
  await editor
    .getByRole("combobox", { name: "External messages & connectors access" })
    .selectOption("deny");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toBeHidden();

  await composer(page).fill("hi");
  await page.keyboard.press("Enter");
  await expect(messageLog(page)).toContainText("mocked bot reply");

  const requests = await chatRequests(page);
  const offered = (requests[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? [];
  const names = offered.map((t) => t.function.name);
  expect(names).not.toContain("mcp__helpdesk__echo");
  // send_email shares the category and is likewise hidden.
  expect(names).not.toContain("send_email");
  // Unrelated tools remain offered.
  expect(names).toContain("workspace_write");
});
