import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bot } from "../lib/engine";
import { TeamEditor } from "./TeamEditor";

function bot(id: string, name: string, isCoordinator = false): Bot {
  return {
    id,
    name,
    color: "#14b8a6",
    roleDescription: `${name}'s job`,
    createdAt: 1,
    paused: false,
    isCoordinator,
  };
}

const roster = [bot("b1", "EA", true), bot("b2", "Scout"), bot("b3", "Sales")];

describe("TeamEditor", () => {
  it("requires a name and at least two members before enabling Create Team", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<TeamEditor bots={roster} onCreate={onCreate} onCancel={() => {}} />);

    const submit = screen.getByRole("button", { name: "Create Team" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Team name"), "Q3 Push");
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "EA" }));
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Scout" }));
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(onCreate).toHaveBeenCalledWith("Q3 Push", ["b1", "b2"]);
  });

  it("lists every active bot with a coordinator badge on the EA", () => {
    render(<TeamEditor bots={roster} onCreate={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("Coordinator")).toBeInTheDocument();
    expect(screen.getByText("Scout's job")).toBeInTheDocument();
  });

  it("deselecting drops below the minimum and disables submit again", async () => {
    const user = userEvent.setup();
    render(<TeamEditor bots={roster} onCreate={() => {}} onCancel={() => {}} />);
    await user.type(screen.getByLabelText("Team name"), "Duo");
    await user.click(screen.getByRole("checkbox", { name: "EA" }));
    await user.click(screen.getByRole("checkbox", { name: "Scout" }));
    const submit = screen.getByRole("button", { name: "Create Team" });
    expect(submit).toBeEnabled();

    await user.click(screen.getByRole("checkbox", { name: "Scout" }));
    expect(submit).toBeDisabled();
  });

  it("cancel closes without creating", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    render(<TeamEditor bots={roster} onCreate={onCreate} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("prefills (design pillar: minimize typing)", () => {
  const two = [
    { id: "b1", name: "Scout" },
    { id: "b2", name: "Rex" },
  ] as never[];

  it("preselects both bots and suggests the name when exactly two exist", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<TeamEditor bots={two} onCreate={onCreate} onCancel={vi.fn()} />);
    // Zero typing: name suggested from members, both preselected, submit live.
    expect(screen.getByLabelText("Team name")).toHaveValue("Scout & Rex");
    await user.click(screen.getByRole("button", { name: "Create Team" }));
    expect(onCreate).toHaveBeenCalledWith("Scout & Rex", ["b1", "b2"]);
  });

  it("keeps a hand-typed name when the selection changes", async () => {
    const user = userEvent.setup();
    render(<TeamEditor bots={two} onCreate={vi.fn()} onCancel={vi.fn()} />);
    const nameField = screen.getByLabelText("Team name");
    await user.clear(nameField);
    await user.type(nameField, "Growth Pod");
    await user.click(screen.getByRole("checkbox", { name: /Rex/ }));
    await user.click(screen.getByRole("checkbox", { name: /Rex/ }));
    expect(nameField).toHaveValue("Growth Pod");
  });
});
