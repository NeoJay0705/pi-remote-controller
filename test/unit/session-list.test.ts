import { describe, expect, it } from "vitest";
import type { NativeCandidate, Session } from "../../src/web/api.js";
import {
  formatFileUpdatedAt,
  sortManagedSessions,
  sortNativeCandidates,
  validFileUpdatedAt,
} from "../../src/web/session-list.js";

const managed = (id: string, time?: number): Session => ({
  id,
  nativeId: id,
  projectId: "p",
  profileId: "x",
  profileRevision: 0,
  fileUpdatedAt: time,
});
const candidate = (file: string, time?: number): NativeCandidate => ({
  file,
  fileUpdatedAt: time,
});

describe("session-list time ordering", () => {
  it("orders newest first, uses fixed keys for ties, and puts invalid times last without mutation", () => {
    const sessions = [
      managed("z", 10),
      managed("b", 20),
      managed("a", 20),
      managed("unknown"),
      managed("negative", -1),
      managed("infinity", Number.POSITIVE_INFINITY),
      managed("bad", Number.NaN),
      managed("unrepresentable", 8.64e15 + 10000),
    ];
    const original = [...sessions];
    expect(sortManagedSessions(sessions).map((item) => item.id)).toEqual([
      "a",
      "b",
      "z",
      "bad",
      "infinity",
      "negative",
      "unknown",
      "unrepresentable",
    ]);
    expect(sessions).toEqual(original);
    const candidates = [
      candidate("z", 10),
      candidate("b", 20),
      candidate("a", 20),
      candidate("unknown"),
      candidate("negative", -1),
      candidate("infinity", Number.POSITIVE_INFINITY),
      candidate("bad", Number.NaN),
      candidate("unrepresentable", 8.64e15 + 10000),
    ];
    const originalCandidates = [...candidates];
    expect(sortNativeCandidates(candidates).map((item) => item.file)).toEqual([
      "a",
      "b",
      "z",
      "bad",
      "infinity",
      "negative",
      "unknown",
      "unrepresentable",
    ]);
    expect(candidates).toEqual(originalCandidates);
  });

  it("validates representable dates and formats local timezone or unknown", () => {
    expect(validFileUpdatedAt(0)).toBe(true);
    expect(validFileUpdatedAt(-1)).toBe(false);
    expect(validFileUpdatedAt(Number.NaN)).toBe(false);
    expect(validFileUpdatedAt(Number.POSITIVE_INFINITY)).toBe(false);
    expect(validFileUpdatedAt(8.64e15 + 10000)).toBe(false);
    expect(formatFileUpdatedAt(undefined)).toBe("檔案更新：時間未知");
    expect(formatFileUpdatedAt(0)).toMatch(/^檔案更新：.*GMT/);
  });
});
