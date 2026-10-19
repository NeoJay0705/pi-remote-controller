import { describe, expect, it } from "vitest";
import { normalizeSessionName } from "../../src/shared/session-names.js";

describe("session name normalization", () => {
  it("accepts optional whitespace, Unicode, and 128 code points", () => {
    expect(normalizeSessionName("  工作 🚀  ")).toEqual({
      ok: true,
      name: "工作 🚀",
    });
    expect(normalizeSessionName("  ")).toEqual({ ok: true });
    expect(normalizeSessionName("😀".repeat(128))).toMatchObject({ ok: true });
    expect(normalizeSessionName("😀".repeat(129))).toEqual({ ok: false });
  });
  it("rejects controls and line separators without replacing them", () => {
    for (const value of [
      "a\nb",
      "a\rB",
      "a\u0000b",
      "a\u0085b",
      "a\u2028b",
      "a\u2029b",
    ])
      expect(normalizeSessionName(value)).toEqual({ ok: false });
    expect(normalizeSessionName(12)).toEqual({ ok: false });
  });
});
