import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends trimmed text on Enter and clears the textarea", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.type(textarea, "  hello bot  {Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello bot");
    expect(textarea).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter without sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\nline two");
  });

  it("does not send blank input on Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.type(textarea, "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends via the Send button", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "click me");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("click me");
  });

  it("disables input and button when disabled", () => {
    render(<Composer onSend={vi.fn()} disabled />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows a Stop control instead of Send while busy, wired to onStop", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer onSend={vi.fn()} busy onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("blocks Enter-to-send while busy but keeps the draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} busy onStop={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.type(textarea, "queued thought{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("queued thought");
  });
});

describe("per-thread drafts (design pillar: typed work is never lost)", () => {
  it("restores an initial draft and reports every keystroke", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <Composer onSend={vi.fn()} initialDraft="half a thought" onDraftChange={onDraftChange} />,
    );
    const textarea = screen.getByRole("textbox", { name: "Message" });
    expect(textarea).toHaveValue("half a thought");
    await user.type(textarea, "!");
    expect(onDraftChange).toHaveBeenLastCalledWith("half a thought!");
  });

  it("clears the field (and reports it) on send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    render(<Composer onSend={onSend} initialDraft="ship it" onDraftChange={onDraftChange} />);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("has no dead attachment button", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Add attachment" })).not.toBeInTheDocument();
  });
});
