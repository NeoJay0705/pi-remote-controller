import type { SessionNameInfo } from "../shared/contracts.js";

export function sessionNameLabel(info?: SessionNameInfo): string {
  if (!info) return "名稱讀取未完成";
  if (info.status === "named") return info.name ?? "未命名 Session";
  if (info.status === "unnamed") return "未命名 Session";
  if (info.status === "incomplete") return "名稱讀取未完成";
  return "名稱讀取失敗";
}
