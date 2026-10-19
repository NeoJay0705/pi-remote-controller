import { describe, expect, it } from "vitest";
import { parseBoundedJson } from "../../src/server/bounded-json.js";

type JsonObject = Record<string, unknown>;

async function* chunks(text: string) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
}
async function* repeatedString(bytes: number) {
  yield Buffer.from('{"text":"');
  const block = Buffer.alloc(64 * 1024, 0x78);
  for (let left = bytes; left > 0; left -= block.length)
    yield left >= block.length ? block : block.subarray(0, left);
  yield Buffer.from('"}');
}
async function* blockChunks(text: string, size = 32 * 1024) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, i + size);
}

describe("bounded JSON projection", () => {
  it("parses chunked UTF-8 and removes sensitive data", async () => {
    const parsed = await parseBoundedJson<Record<string, unknown>>(
      chunks(
        '{"id":"é","parentId":null,"thinking":"secret","signature":"private","message":{"role":"user","content":"hi"}}',
      ),
    );
    expect(parsed.value).toEqual({
      id: "é",
      parentId: null,
      message: { role: "user", content: "hi" },
    });
    expect(parsed.retainedBytes).toBeGreaterThan(0);
  });
  it("parses split escapes, surrogate pairs, numbers, literals, and safe property names", async () => {
    const { value } = await parseBoundedJson<JsonObject>(
      chunks(
        '{"s":"\\uD83D\\uDE00\\n\\"","n":-1.2e+3,"a":[true,false,null],"__proto__":{"polluted":1}}',
      ),
    );
    expect(value.s).toBe('😀\n"');
    expect(value.n).toBe(-1200);
    expect(value.a).toEqual([true, false, null]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });
  it("retains numeric IDs inside nested details without rejecting root IDs", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks('{"details":{"id":42,"parentId":7},"id":"root","parentId":null}'),
    );
    const details = result.value.details as JsonObject;
    expect(details.id).toBe(42);
    expect(details.parentId).toBe(7);
    expect(result.value.id).toBe("root");
    expect(result.value.parentId).toBeNull();
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("omits ambiguous nested type arrays and role objects independently", async () => {
    for (const field of ['"type":["business"]', '"role":{"name":"operator"}']) {
      const result = await parseBoundedJson<JsonObject>(
        chunks(
          `{"details":{${field}},"id":"root","parentId":null,"type":"message"}`,
        ),
      );
      expect(result.value.details).toBeUndefined();
      expect(result.value.id).toBe("root");
      expect(result.value.parentId).toBeNull();
      expect(result.value.type).toBe("message");
      expect(result.truncated).toBe(true);
      expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
      expect(
        Buffer.byteLength(JSON.stringify(result.value)),
      ).toBeLessThanOrEqual(1024 * 1024);
    }
  });
  it("retains one hundred text blocks and root structural fields", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        JSON.stringify({
          id: "root",
          parentId: null,
          type: "message",
          content: Array.from({ length: 100 }, (_, i) => ({
            type: "text",
            text: `block-${i}`,
          })),
        }),
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.value.id).toBe("root");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("retains nested assistant text blocks and root structural fields", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        JSON.stringify({
          id: "root",
          parentId: null,
          type: "message",
          messages: Array.from({ length: 80 }, (_, i) => ({
            message: {
              role: "assistant",
              content: [{ type: "text", text: `nested-${i}` }],
            },
          })),
        }),
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.value.id).toBe("root");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("preserves root fields after metadata exhaustion in details", async () => {
    const details = `{"role":"user",${Array(140)
      .fill('"role":"user"')
      .join(",")}}`;
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        `{"details":${details},"id":"late-root","parentId":null,"type":"message"}`,
      ),
    );
    expect(result.value.id).toBe("late-root");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("keeps late private markers sticky after metadata exhaustion", async () => {
    const details = `{"role":"user",${Array(140)
      .fill('"role":"user"')
      .join(",")}}`;
    const input = `{"details":${details},"role":"system","content":"system-private-secret","type":"thinking","content":"thinking-private-secret","role":"user","type":"message","content":"public-duplicate-content"}`;
    const result = await parseBoundedJson<JsonObject>(chunks(input));
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("system-private-secret");
    expect(serialized).not.toContain("thinking-private-secret");
    expect(serialized).not.toContain("public-duplicate-content");
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(1024 * 1024);
  });
  it("accepts oversized metadata in an unretained subtree", async () => {
    const input = JSON.stringify({
      payload: "x".repeat(300 * 1024),
      omitted: { role: "r".repeat(300), type: "t".repeat(300) },
      id: "late-root",
      parentId: null,
      type: "message",
    });
    const result = await parseBoundedJson<JsonObject>(chunks(input));
    expect(result.value.id).toBe("late-root");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("rejects malformed syntax, UTF-8, IDs, and excessive depth", async () => {
    for (const text of [
      '{"x":1,}',
      '{"x":',
      "true false",
      "[01]",
      "[1.]",
      '"\\q"',
      "[1,,2]",
      "[1]x",
    ])
      await expect(parseBoundedJson(chunks(text))).rejects.toThrow(
        "invalid_record",
      );
    await expect(parseBoundedJson([Buffer.from([0xff])])).rejects.toThrow(
      "invalid_record",
    );
    await expect(
      parseBoundedJson(
        chunks(JSON.stringify({ id: "x".repeat(257), parentId: null })),
      ),
    ).rejects.toThrow("invalid_record");
    await expect(parseBoundedJson(chunks('{"id":4}'))).rejects.toThrow(
      "invalid_record",
    );
    await expect(
      parseBoundedJson(chunks("[".repeat(34) + "0" + "]".repeat(34))),
    ).rejects.toThrow("invalid_record");
  });
  it("truncates payload within retained budget and drops large arrays and keys", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        JSON.stringify({
          text: "x".repeat(300),
          arr: Array(1000).fill(null),
          ["k".repeat(2000)]: "v",
        }),
      ),
      128,
    );
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(128);
    const text = result.value.text;
    expect(typeof text).toBe("string");
    expect((typeof text === "string" ? text : "").length).toBeLessThan(300);
  });
  it("keeps structural IDs after huge payloads and does not retain oversized keys", async () => {
    const input = JSON.stringify({
      payload: "p".repeat(20_000),
      ["k".repeat(2_000)]: "collision",
      id: "entry-id",
      parentId: null,
      type: "message",
    });
    const result = await parseBoundedJson<JsonObject>(chunks(input), 2048);
    expect(result.value.id).toBe("entry-id");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.value["k".repeat(1024)]).toBeUndefined();
    expect(result.retainedBytes).toBeLessThanOrEqual(2048);
  });
  it("finds structural and privacy fields after 129 earlier keys", async () => {
    const input: Record<string, unknown> = {
      id: "late-id",
      parentId: null,
      type: "message",
      message: {
        content: "private",
        ...Object.fromEntries(
          Array.from({ length: 129 }, (_, i) => [`k${i}`, "x"]),
        ),
        role: "system",
      },
    };
    Object.assign(
      input,
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`r${i}`, "x"])),
    );
    const result = await parseBoundedJson<JsonObject>(
      chunks(JSON.stringify(input)),
    );
    expect(result.value.id).toBe("late-id");
    expect(result.value.parentId).toBeNull();
    expect(JSON.stringify(result.value)).not.toContain("private");
  });
  it("drops thinking objects when type appears after 129 keys", async () => {
    const block = {
      text: "sensitive",
      ...Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [`k${i}`, "x"]),
      ),
      type: "thinking",
    };
    const { value } = await parseBoundedJson<JsonObject>(
      chunks(JSON.stringify({ id: "entry", parentId: null, block })),
    );
    expect(JSON.stringify(value)).not.toContain("sensitive");
  });
  it("keeps root structural fields and conservatively omits ambiguous nested metadata", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        '{"details":{"id":42,"parentId":7,"type":["business"],"role":{"name":"operator"}},"id":"root","parentId":null,"type":"message"}',
      ),
    );
    expect(result.value.id).toBe("root");
    expect(result.value.parentId).toBeNull();
    expect(result.value.type).toBe("message");
    expect(result.truncated).toBe(true);
    expect(result.value.details).toBeUndefined();
  });
  it("does not mark private-only omission, preserves public truncation, and omits signatures", async () => {
    for (const marker of [
      '{"role":"system","content":"PRIVATE-START","textSignature":"SIG-START","thinkingSignature":"THINK-SIG-START"}',
      '{"content":"PRIVATE-END","role":"system","textSignature":"SIG-END","thinkingSignature":"THINK-SIG-END"}',
    ]) {
      const short = await parseBoundedJson<JsonObject>(
        chunks(`{"content":"short public text","block":${marker}}`),
      );
      expect(short.value.content).toBe("short public text");
      expect(short.truncated).toBe(false);
      expect(JSON.stringify(short.value)).not.toMatch(/PRIVATE-|SIG-/);
    }
    const sensitiveLargeSubtree = await parseBoundedJson<JsonObject>(
      chunks(
        JSON.stringify({
          public: "short public text",
          stderr: Array.from({ length: 140 }, (_, i) => `sensitive-${i}`),
          signature: { values: Array.from({ length: 140 }, () => "secret") },
        }),
      ),
    );
    expect(sensitiveLargeSubtree.value.public).toBe("short public text");
    expect(sensitiveLargeSubtree.truncated).toBe(false);
    expect(JSON.stringify(sensitiveLargeSubtree.value)).not.toMatch(
      /sensitive-|secret/,
    );
    const publicSibling = await parseBoundedJson<JsonObject>(
      chunks(
        `{"public":"${"x".repeat(300)}","private":{"role":"system","content":"PRIVATE"}}`,
      ),
      128,
    );
    expect(publicSibling.truncated).toBe(true);
    const longPublic = await parseBoundedJson<JsonObject>(
      chunks(`{"text":"${"y".repeat(70 * 1024)}"}`),
    );
    expect(longPublic.truncated).toBe(true);
  });
  it("separates private omission from public truncation when privacy markers are at the end", async () => {
    const publicThenPrivate = await parseBoundedJson<JsonObject>(
      chunks(
        `{"content":"short public","details":{"text":"${"s".repeat(70 * 1024)}","type":"thinking"}}`,
      ),
    );
    expect(publicThenPrivate.value.content).toBe("short public");
    expect(publicThenPrivate.truncated).toBe(false);

    const privateThenPublic = await parseBoundedJson<JsonObject>(
      chunks(
        `{"details":{"type":"thinking","text":"private"},"content":"${"p".repeat(70 * 1024)}"}`,
      ),
    );
    expect(privateThenPublic.truncated).toBe(true);

    for (const block of [
      `{"text":"${"s".repeat(70 * 1024)}","type":"thinking"}`,
      `{"type":"thinking","text":"${"s".repeat(70 * 1024)}"}`,
    ]) {
      const result = await parseBoundedJson<JsonObject>(
        chunks(`{"block":${block}}`),
      );
      expect(result.truncated).toBe(false);
      expect(JSON.stringify(result.value)).not.toContain("s".repeat(128));
    }
  });
  it("omits ordinary text and thinking signatures without hiding public content", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "public message",
            textSignature: "text-secret",
            thinkingSignature: "thinking-secret",
          },
          event: {
            type: "text",
            text: "public block",
            signature: "signature-secret",
          },
        }),
      ),
    );
    const serialized = JSON.stringify(result.value);
    expect(serialized).toContain("public message");
    expect(serialized).toContain("public block");
    expect(serialized).not.toMatch(
      /text-secret|thinking-secret|signature-secret/,
    );
  });
  it("does not retain system or thinking content", async () => {
    const result = await parseBoundedJson<JsonObject>(
      chunks('{"role":"system","content":"secret","extra":{"x":1}}'),
    );
    expect(result.value).toEqual({ role: "system" });
    const block = await parseBoundedJson<JsonObject>(
      chunks(
        '{"type":"thinking","content":[{"type":"text","text":"secret"}],"text":"secret"}',
      ),
    );
    expect(JSON.stringify(block.value)).not.toContain("secret");
  });
  it("keeps late privacy metadata after the payload budget is exhausted", async () => {
    const payload = "x".repeat(64 * 1024 * 4);
    for (const suffix of [
      ',"role":"system","content":"system-secret"}',
      ',"type":"thinking","content":"thinking-secret"}',
    ]) {
      const input = `{"payload":"${payload}"${suffix}`;
      const result = await parseBoundedJson<JsonObject>(
        blockChunks(input),
        8192,
        {
          previewBytes: 2048,
        },
      );
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toContain("system-secret");
      expect(serialized).not.toContain("thinking-secret");
      expect(result.retainedBytes).toBeLessThanOrEqual(8192);
    }
  });
  it("scans nested arrays after exhausting payload without retaining them", async () => {
    const nested = `[${Array(128)
      .fill(`[${Array(128).fill("null").join(",")}]`)
      .join(",")}]`;
    const input = `{"payload":"${"x".repeat(64 * 1024 * 4)}","nested":${nested}}`;
    const inputBytes = Buffer.byteLength(input);
    const result = await parseBoundedJson<JsonObject>(
      blockChunks(input),
      8192,
      {
        previewBytes: 2048,
      },
    );
    expect(result.stats?.inputBytes).toBe(inputBytes);
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
      8192,
    );
    expect(result.retainedBytes).toBeLessThanOrEqual(8192);
  });
  it("streams a single oversized string and returns a bounded preview", async () => {
    const result = await parseBoundedJson<JsonObject>(
      repeatedString(33 * 1024 * 1024),
    );
    const text = result.value.text;
    expect(typeof text).toBe("string");
    expect((typeof text === "string" ? text : "").length).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(result.truncated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.stats?.inputBytes).toBeGreaterThan(32 * 1024 * 1024);
  }, 60000);
});
