import type { RuntimeSession } from "../shared/contracts.js";

export type ManagementReceipt = {
  operationId: string;
  sessionId: string;
  kind: import("../shared/contracts.js").OperationKind;
  status: string;
  result?: unknown;
  errorCode?: string;
};

export const RPC_RECEIPTS_KEY = "prw-receipts";
export const RPC_STALE_AFTER_MS = 15_000;

export function canReleaseRuntime(
  runtime: RuntimeSession,
  options: {
    loaded: boolean;
    online: boolean;
    updatedAt: number | undefined;
    now: number;
    pending: boolean;
  },
): boolean {
  return Boolean(
    options.loaded &&
    options.online &&
    options.updatedAt !== undefined &&
    options.now - options.updatedAt <= RPC_STALE_AFTER_MS &&
    !options.pending &&
    runtime.releaseEligible &&
    runtime.runtimeState === "idle",
  );
}

export function runtimeName(runtime: RuntimeSession): string {
  const info = runtime.nameInfo;
  if (info.status === "named" && info.name?.trim()) return info.name.trim();
  if (info.status === "unnamed") return "未命名 Session";
  return "Session 名稱不可用";
}

export function releaseReason(reason?: string): string {
  const reasons: Record<string, string> = {
    not_running: "Runtime 尚未啟動或已停止。",
    owner_mismatch: "Runtime 不由 Web 控制。",
    runtime_not_idle: "Runtime 目前不在閒置狀態。",
    operation_in_flight: "此 Session 有操作正在處理。",
    runtime_transition: "Runtime 正在切換或重新載入。",
    queue_not_empty: "仍有待處理工作。",
    dialogs_pending: "仍有待處理的 Extension 對話。",
    profile_switch_unresolved: "Profile 切換結果尚未確認。",
    cwd_unavailable: "工作目錄資訊不可用。",
    rpc_state_unavailable: "無法確認 Pi Runtime 狀態。",
    rpc_state_mismatch: "Pi Runtime 狀態與管理記錄不一致。",
    rpc_busy: "Pi Runtime 正忙碌。",
    runtime_changed: "Runtime 在確認期間發生變更。",
  };
  return reasons[reason ?? ""] ?? "目前無法安全釋放此 Runtime。";
}

export function isUnresolvedRelease(receipt: ManagementReceipt): boolean {
  return (
    receipt.kind === "release" &&
    !(
      receipt.status === "REJECTED" ||
      (receipt.status === "ACCEPTED" &&
        (receipt.result as { status?: string } | undefined)?.status ===
          "released")
    )
  );
}

export function receiptLabel(receipt: ManagementReceipt): string {
  if (
    receipt.status === "ACCEPTED" &&
    (receipt.result as { status?: string } | undefined)?.status === "released"
  )
    return "已確認釋放。";
  if (receipt.status === "REJECTED") {
    const reason =
      (receipt.result as { reason?: string } | undefined)?.reason ??
      receipt.errorCode;
    return `伺服器拒絕操作：${reason ? `${releaseReason(reason)}（${reason}）` : "狀態未符合安全條件。"} 可重新確認後再試。`;
  }
  return "釋放結果尚未確認；不會自動重送。";
}

const terminal = (receipt: ManagementReceipt) =>
  receipt.kind === "release"
    ? !isUnresolvedRelease(receipt)
    : receipt.status !== "UNKNOWN" && receipt.status !== "DISPATCHED";

export function boundedReceiptHistory(
  receipts: ManagementReceipt[],
  limit = 30,
): ManagementReceipt[] {
  const unresolved = receipts.filter(isUnresolvedRelease);
  const retained = new Set(unresolved.map((receipt) => receipt.operationId));
  let ordinaryCount = 0;
  for (const receipt of receipts) {
    if (isUnresolvedRelease(receipt)) continue;
    if (ordinaryCount >= limit) break;
    if (!retained.has(receipt.operationId)) ordinaryCount++;
    retained.add(receipt.operationId);
  }
  return receipts.filter((receipt) => retained.has(receipt.operationId));
}

export function mergeReceipt(
  current: ManagementReceipt[],
  incoming: ManagementReceipt,
): ManagementReceipt[] {
  const previous = current.find(
    (item) => item.operationId === incoming.operationId,
  );
  const next =
    previous && terminal(previous) && !terminal(incoming)
      ? {
          ...incoming,
          status: previous.status,
          result: previous.result ?? incoming.result,
        }
      : {
          ...previous,
          ...incoming,
          result: incoming.result ?? previous?.result,
        };
  return boundedReceiptHistory([
    next,
    ...current.filter((item) => item.operationId !== incoming.operationId),
  ]);
}
