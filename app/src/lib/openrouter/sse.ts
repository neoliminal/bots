// Minimal incremental SSE parser: feed decoded text chunks (which may split
// lines arbitrarily), get back the `data:` payloads of completed lines.

export class SseParser {
  private buffer = "";

  /** Push a decoded text chunk; returns the data payloads completed by it. */
  push(text: string): string[] {
    this.buffer += text;
    const payloads: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) {
        payloads.push(line.slice("data:".length).trimStart());
      }
      // Other lines (comments like ": OPENROUTER PROCESSING", blank
      // separators, event/id fields) are ignored.
    }
    return payloads;
  }
}
