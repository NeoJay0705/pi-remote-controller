import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, createOperationId } from "../../src/web/browser-support.js";

afterEach(() => vi.unstubAllGlobals());
describe("browser compatibility helpers", () => {
  it("creates unique RFC4122 UUIDv4 IDs when randomUUID is unavailable", () => {
    let sequence = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0);
        bytes[15] = sequence++;
        return bytes;
      },
    });
    const one = createOperationId(),
      two = createOperationId();
    expect(one).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(two).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(one).not.toBe(two);
    expect(one.split("-")[2]![0]).toBe("4");
    expect("89ab").toContain(one.split("-")[3]![0]!.toLowerCase());
  });
  it("prefers crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "generated-id" });
    expect(createOperationId()).toBe("generated-id");
  });
  it("fails explicitly when secure randomness is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createOperationId()).toThrow("Secure random");
  });
  it("returns false when clipboard is absent or rejects writes", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("content")).toBe(false);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    expect(await copyText("content")).toBe(false);
  });
});
