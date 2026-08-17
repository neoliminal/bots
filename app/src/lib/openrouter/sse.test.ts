import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

describe("SseParser", () => {
  it("emits data payloads only for completed lines", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\ndata: [DONE]\n')).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("ignores comments, blank lines, and other fields; handles CRLF", () => {
    const parser = new SseParser();
    const payloads = parser.push(
      ": OPENROUTER PROCESSING\r\n\r\nevent: message\r\ndata: hello\r\n\r\n",
    );
    expect(payloads).toEqual(["hello"]);
  });
});
