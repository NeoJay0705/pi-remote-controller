import { describe, expect, it } from "vitest";
import {
  MAX_STREAM_TEXT,
  reconstructStreamEvent,
  resetStream,
} from "../../src/web/streaming.js";

describe("RPC delta-only stream reconstruction", () => {
  it("appends deltas and replaces them with authoritative text_end content", () => {
    let state = resetStream();
    for (const delta of ["hello ", "world"]) {
      const result = reconstructStreamEvent(state, {
        type: "text_delta",
        contentIndex: 0,
        delta,
      });
      state = result.state;
    }
    let result = reconstructStreamEvent(state, {
      type: "text_end",
      contentIndex: 0,
      content: "hello world!",
    });
    state = result.state;
    expect(result.text).toBe("hello world!");
    result = reconstructStreamEvent(state, {
      type: "text_delta",
      contentIndex: 0,
      delta: "duplicate",
    });
    expect(result.text).toBe("hello world!");
  });

  it("sorts multiple text blocks and ignores private or invalid data", () => {
    let state = resetStream();
    for (const event of [
      { type: "text_delta", contentIndex: 3, delta: "second" },
      { type: "thinking_delta", contentIndex: 1, delta: "secret" },
      { type: "text_delta", contentIndex: 0, delta: "first" },
      { type: "toolcall_delta", contentIndex: 2, delta: "private" },
      { type: "text_delta", contentIndex: 128, delta: "invalid" },
    ])
      state = reconstructStreamEvent(state, event).state;
    expect(
      reconstructStreamEvent(state, {
        type: "text_end",
        contentIndex: 3,
        content: { type: "text", text: "second!" },
      }).text,
    ).toBe("first\nsecond!");
  });

  it("resets independently and caps total text with a visible marker", () => {
    let state = resetStream();
    const result = reconstructStreamEvent(state, {
      type: "text_delta",
      contentIndex: 0,
      delta: "x".repeat(MAX_STREAM_TEXT + 10),
    });
    expect(result.text.length).toBeLessThanOrEqual(MAX_STREAM_TEXT);
    expect(result.text).toContain("[內容已截斷]");
    state = resetStream();
    expect(
      reconstructStreamEvent(state, {
        type: "text_delta",
        contentIndex: 0,
        delta: "fresh",
      }).text,
    ).toBe("fresh");
  });
});
