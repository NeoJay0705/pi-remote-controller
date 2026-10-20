import type { NativeCandidate, Session } from "./api.js";

type TimedItem = { fileUpdatedAt?: number };

export function validFileUpdatedAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function sortManagedSessions<T extends Session>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => compare(a, b, a.id, b.id));
}

export function sortNativeCandidates<T extends NativeCandidate>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => compare(a, b, a.file, b.file));
}

function compare(a: TimedItem, b: TimedItem, keyA: string, keyB: string) {
  const validA = validFileUpdatedAt(a.fileUpdatedAt);
  const validB = validFileUpdatedAt(b.fileUpdatedAt);
  if (
    validA &&
    validB &&
    a.fileUpdatedAt !== undefined &&
    b.fileUpdatedAt !== undefined &&
    a.fileUpdatedAt !== b.fileUpdatedAt
  )
    return b.fileUpdatedAt - a.fileUpdatedAt;
  if (validA !== validB) return validA ? -1 : 1;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

export function formatFileUpdatedAt(value: unknown): string {
  if (!validFileUpdatedAt(value)) return "檔案更新：時間未知";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).format(new Date(value));
  return `檔案更新：${parts}`;
}
