import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionView,
  parseSessionView,
  readSessionView,
  resolveSessionView,
  SESSION_VIEW_KEY,
  writeSessionView,
} from "../../src/web/session-view.js";

afterEach(() => vi.unstubAllGlobals());

describe("versioned session view storage", () => {
  it("accepts identifiers only and rejects malformed, oversized, and unknown versions", () => {
    expect(
      parseSessionView('{"version":1,"projectId":"p","sessionId":"s"}'),
    ).toEqual({ version: 1, projectId: "p", sessionId: "s" });
    expect(parseSessionView('{"version":2,"projectId":"p"}')).toBeUndefined();
    expect(parseSessionView('{"version":1,"projectId":""}')).toBeUndefined();
    expect(parseSessionView("x".repeat(2049))).toBeUndefined();
    expect(
      parseSessionView('{"version":1,"projectId":"p","token":"secret"}'),
    ).toEqual({ version: 1, projectId: "p" });
  });
  it("tolerates inaccessible storage and a throwing sessionStorage getter", () => {
    const denied = {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
      removeItem() {
        throw Error();
      },
    };
    expect(readSessionView(denied)).toBeUndefined();
    expect(() =>
      writeSessionView({ version: 1, projectId: "p" }, denied),
    ).not.toThrow();
    expect(() => clearSessionView(denied)).not.toThrow();
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "sessionStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    );
    expect(readSessionView()).toBeUndefined();
    expect(() =>
      writeSessionView({ version: 1, projectId: "p" }),
    ).not.toThrow();
    expect(() => clearSessionView()).not.toThrow();
  });
  it("resolves only sessions and projects still present in accepted lists", () => {
    const projects = [{ id: "default" }, { id: "other" }];
    const sessions = [{ id: "s", projectId: "other" }];
    expect(
      resolveSessionView(
        { version: 1, projectId: "default", sessionId: "s" },
        projects,
        sessions,
        "default",
      ),
    ).toEqual({ projectId: "other", sessionId: "s" });
    expect(
      resolveSessionView(
        { version: 1, projectId: "other", sessionId: "gone" },
        projects,
        sessions,
        "default",
      ),
    ).toEqual({ projectId: "other" });
    expect(
      resolveSessionView(
        { version: 1, projectId: "gone" },
        projects,
        sessions,
        "default",
      ),
    ).toEqual({ projectId: "default" });
  });
  it("writes and removes the versioned key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    writeSessionView({ version: 1, projectId: "p", sessionId: "s" }, storage);
    expect(values.has(SESSION_VIEW_KEY)).toBe(true);
    clearSessionView(storage);
    expect(values.has(SESSION_VIEW_KEY)).toBe(false);
  });
});
