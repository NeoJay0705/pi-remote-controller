import type { SessionNameInfo } from "./contracts.js";

export type SessionNameValidation = { ok: true; name?: string } | { ok: false };

export function normalizeSessionName(value: unknown): SessionNameValidation {
  if (typeof value !== "string") return { ok: false };
  const name = value.trim();
  if (!name) return { ok: true };
  const forbidden = [...name].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
  if ([...name].length > 128 || forbidden) return { ok: false };
  return { ok: true, name };
}

export function unnamedSessionInfo(): SessionNameInfo {
  return { status: "unnamed" };
}
