// Message composer: Enter sends, Shift+Enter inserts a newline,
// textarea grows with content (capped), supports a disabled state.
// While the bot is replying (`busy`) sending is blocked and the Send button
// becomes a Stop control (spec: messaging, "Interruption and cancellation").
//
// Visual language (docs/design/visual-style.md): a pill field with a hairline
// border on white, a leading circular "+" button, and a trailing circular
// near-black send (or stop) button.

import { useRef, useState, type KeyboardEvent } from "react";

export interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** True while a reply is in flight: sending is blocked, Stop is shown. */
  busy?: boolean;
  /** Called when the user hits Stop on an in-flight reply. */
  onStop?: () => void;
  /**
   * Draft restored on mount and reported on every keystroke, so half-typed
   * text survives thread switches (design pillar: typed work is never lost).
   * The host keys the Composer by thread and persists drafts per thread.
   */
  initialDraft?: string;
  onDraftChange?: (text: string) => void;
}

const MAX_HEIGHT_PX = 200;

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function Composer({
  onSend,
  disabled = false,
  placeholder = "Message…",
  busy = false,
  onStop,
  initialDraft = "",
  onDraftChange,
}: ComposerProps) {
  const [text, setTextState] = useState(initialDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const setText = (value: string) => {
    setTextState(value);
    onDraftChange?.(value);
  };

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const send = () => {
    const trimmed = text.trim();
    if (disabled || busy || trimmed === "") return;
    onSend(trimmed);
    setText("");
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="flex items-end gap-2 bg-white px-4 pb-4 pt-2 dark:bg-neutral-950">
      {/* Attachments are not implemented yet: the "+" is intentionally
          absent rather than a live-looking no-op (design pillar: unlabeled
          dead controls are pure mental load). Restore with the plus-menu
          (Attach files / Teach a task) when the messaging attachment
          requirement ships. */}
      <div className="flex min-w-0 flex-1 items-end rounded-[19px] border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            resize();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          aria-label="Message"
          className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-3.5 py-2 text-sm text-[#1c1c1e] outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-100"
        />
        {busy ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onStop}
            disabled={disabled || !onStop}
            className="m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1c1c1e] text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#f2f2f7] dark:text-[#1c1c1e] dark:hover:bg-white"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            onClick={send}
            disabled={disabled || text.trim() === ""}
            className="m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1c1c1e] text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-30 dark:bg-[#f2f2f7] dark:text-[#1c1c1e] dark:hover:bg-white"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}
