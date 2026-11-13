import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeSession } from "../shared/contracts.js";
import { api } from "./api.js";
import { createOperationId } from "./browser-support.js";
import {
  canReleaseRuntime,
  isUnresolvedRelease,
  mergeReceipt,
  receiptLabel,
  releaseReason,
  runtimeName,
  type ManagementReceipt,
} from "./rpc-management.js";
import "./rpc-management.css";

type Props = {
  receipts: ManagementReceipt[];
  saveReceipt: (receipt: ManagementReceipt) => boolean;
  onReturn: () => void;
};

export function RpcManagement({ receipts, saveReceipt, onReturn }: Props) {
  const [runtimes, setRuntimes] = useState<RuntimeSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [clock, setClock] = useState(Date.now());
  const [notice, setNotice] = useState("");
  const [releasingIds, setReleasingIds] = useState<string[]>([]);
  const mounted = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef(false);
  const releasing = useRef(new Set<string>());
  const currentReceipts = useRef(receipts);
  currentReceipts.current = receipts;

  const refresh = useCallback(async () => {
    if (!mounted.current || inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await api.runtimes(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setRuntimes(result);
      setUpdatedAt(Date.now());
      setLoaded(true);
      setError("");
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setError((cause as Error).message || "無法更新 Runtime 清單。");
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        inFlight.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5_000);
    const freshness = window.setInterval(() => setClock(Date.now()), 1_000);
    const onlineChanged = () => setOnline(navigator.onLine);
    window.addEventListener("online", onlineChanged);
    window.addEventListener("offline", onlineChanged);
    return () => {
      mounted.current = false;
      request.current?.abort();
      window.clearInterval(poll);
      window.clearInterval(freshness);
      window.removeEventListener("online", onlineChanged);
      window.removeEventListener("offline", onlineChanged);
    };
  }, [refresh]);

  const unresolved = (id: string) =>
    currentReceipts.current.some(
      (receipt) => receipt.sessionId === id && isUnresolvedRelease(receipt),
    );
  const fresh =
    loaded && updatedAt !== undefined && clock - updatedAt <= 15_000;
  const checkReceipt = async (receipt: ManagementReceipt) => {
    try {
      const known = await api.receipt(receipt.operationId);
      const next = { ...receipt, status: known.status, result: known.result };
      saveReceipt(next);
      if (!mounted.current) return;
      if (
        next.status === "ACCEPTED" &&
        (next.result as { status?: string } | undefined)?.status === "released"
      ) {
        currentReceipts.current = mergeReceipt(currentReceipts.current, next);
        setRuntimes((old) =>
          old.filter((runtime) => runtime.id !== receipt.sessionId),
        );
        setNotice(`${receipt.sessionId}：已確認釋放。`);
        await refresh();
      }
    } catch {
      // A missing receipt cannot establish that a mutation was not delivered.
    }
  };
  useEffect(() => {
    for (const receipt of receipts)
      if (receipt.kind === "release" && isUnresolvedRelease(receipt))
        void checkReceipt(receipt);
    // Query each persisted operation once when this view mounts.
  }, []);

  const release = async (target: RuntimeSession) => {
    if (releasing.current.has(target.id)) return;
    const frozen = {
      id: target.id,
      name: runtimeName(target),
      cwd: target.cwd,
    };
    if (
      !canReleaseRuntime(target, {
        loaded: loaded && !error,
        online,
        updatedAt,
        now: Date.now(),
        pending: unresolved(target.id),
      })
    )
      return;
    if (
      !window.confirm(
        `確定釋放 RPC？\nSession：${frozen.name}\nController ID：${frozen.id}\n工作目錄：${frozen.cwd ?? "未知"}`,
      )
    )
      return;
    if (!mounted.current) return;
    if (inFlight.current) {
      setNotice("Runtime 清單正在更新；請稍候重新確認並釋放。");
      return;
    }
    releasing.current.add(target.id);
    setReleasingIds((old) => [...new Set([...old, target.id])]);
    inFlight.current = true;
    try {
      const freshList = await api.runtimes();
      if (!mounted.current) return;
      setRuntimes(freshList);
      setUpdatedAt(Date.now());
      setLoaded(true);
      setError("");
      const current = freshList.find((runtime) => runtime.id === frozen.id);
      if (
        !current ||
        runtimeName(current) !== frozen.name ||
        current.cwd !== frozen.cwd ||
        !canReleaseRuntime(current, {
          loaded: true,
          online: navigator.onLine,
          updatedAt: Date.now(),
          now: Date.now(),
          pending: unresolved(frozen.id),
        })
      ) {
        setNotice("Runtime 狀態或身分已變更；未送出釋放操作，請重新確認。");
        return;
      }
      if (!navigator.onLine || !mounted.current) return;
      const operationId = createOperationId();
      const intended: ManagementReceipt = {
        operationId,
        sessionId: frozen.id,
        kind: "release",
        status: "DISPATCHED",
      };
      if (!saveReceipt(intended)) {
        setNotice(
          "無法安全保存操作收據；未送出釋放操作。請檢查瀏覽器儲存空間設定。",
        );
        return;
      }
      let receipt: Awaited<ReturnType<typeof api.operation>>;
      try {
        receipt = await api.operation(frozen.id, {
          operationId,
          kind: "release",
        });
      } catch (cause) {
        const failure = cause as Error & { status?: number; code?: string };
        if (failure.status === 401) throw cause;
        // Admission 409 means no mutation was queued; the receipt remains source of truth.
        const next: ManagementReceipt = {
          ...intended,
          status: "UNKNOWN",
          ...(failure.code ? { errorCode: failure.code } : {}),
        };
        saveReceipt(next);
        try {
          const known = await api.receipt(operationId);
          next.status = known.status;
          next.result = known.result;
          saveReceipt(next);
        } catch {
          // 404 / transport errors remain unconfirmed, never permit a retry.
        }
        if (
          next.status === "ACCEPTED" &&
          (next.result as { status?: string } | undefined)?.status ===
            "released"
        ) {
          currentReceipts.current = mergeReceipt(currentReceipts.current, next);
          setRuntimes((old) =>
            old.filter((runtime) => runtime.id !== frozen.id),
          );
          setNotice(`${frozen.name}：已確認釋放。`);
          await refresh();
        } else if (next.status === "REJECTED") {
          setNotice(
            `${frozen.name}：${receiptLabel(next)}${(cause as Error & { code?: string }).code ? ` 原因代碼：${(cause as Error & { code?: string }).code}` : ""}`,
          );
        } else {
          setNotice(
            `${frozen.name}：結果尚未確認；不會自動重送，請查詢操作收據。`,
          );
        }
        return;
      }
      const next: ManagementReceipt = {
        ...intended,
        status: receipt.status,
        result: receipt.result,
      };
      saveReceipt(next);
      if (
        receipt.status === "ACCEPTED" &&
        (receipt.result as { status?: string } | undefined)?.status ===
          "released"
      ) {
        currentReceipts.current = mergeReceipt(currentReceipts.current, next);
        setRuntimes((old) => old.filter((runtime) => runtime.id !== frozen.id));
        setNotice(`${frozen.name}：已確認釋放。`);
        await refresh();
      } else {
        setNotice(
          `${frozen.name}：${receiptLabel(next)}${(receipt as typeof receipt & { code?: string }).code ? ` 原因代碼：${(receipt as typeof receipt & { code?: string }).code}` : ""}`,
        );
      }
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status !== 401) setError(failure.message);
      setNotice(
        failure.status === 401
          ? "登入已逾期。"
          : `釋放狀態未確認：${failure.message}`,
      );
    } finally {
      inFlight.current = false;
      releasing.current.delete(target.id);
      setReleasingIds((old) => old.filter((id) => id !== target.id));
    }
  };

  return (
    <section className="rpc-management" aria-labelledby="rpc-management-title">
      <div className="rpc-management-heading">
        <div>
          <h1 id="rpc-management-title">RPC 管理</h1>
          <p>管理所有受管 Runtime；此清單不會啟動 Session。</p>
        </div>
        <button type="button" onClick={onReturn}>
          返回對話
        </button>
      </div>
      <div className="rpc-management-toolbar">
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          重新整理
        </button>
        <span role="status">
          {!online
            ? "離線"
            : !loaded
              ? "正在載入…"
              : !fresh
                ? "資料已過期"
                : `更新於 ${new Date(updatedAt!).toLocaleTimeString()}`}
        </span>
        {loading && loaded && <span>正在更新…</span>}
      </div>
      {!online && (
        <p className="rpc-management-error" role="alert">
          目前離線；釋放操作已停用。
        </p>
      )}
      {error && (
        <p className="rpc-management-error" role="alert">
          更新失敗：{error}。保留上次成功清單；釋放操作已停用。
        </p>
      )}
      {!fresh && loaded && (
        <p role="status">清單超過 15 秒未成功更新；釋放操作已停用。</p>
      )}
      {notice && (
        <p className="rpc-management-notice" role="status">
          {notice}
        </p>
      )}
      {!loaded && loading && <p role="status">正在載入 Runtime 清單…</p>}
      {!loaded && error && <p>尚無成功載入的 Runtime 清單。</p>}
      {loaded && runtimes.length === 0 && !error && (
        <p>目前沒有未釋放的受管 Runtime。</p>
      )}
      {loaded && runtimes.length > 0 && (
        <ul className="rpc-runtime-list">
          {runtimes.map((runtime) => {
            const blocked = unresolved(runtime.id);
            const enabled = canReleaseRuntime(runtime, {
              loaded: loaded && !error,
              online,
              updatedAt,
              now: clock,
              pending:
                blocked ||
                releasing.current.has(runtime.id) ||
                releasingIds.includes(runtime.id),
            });
            return (
              <li key={runtime.id} className="rpc-runtime-card">
                <h2>{runtimeName(runtime)}</h2>
                <dl>
                  <dt>Controller Session ID</dt>
                  <dd>{runtime.id}</dd>
                  <dt>工作目錄</dt>
                  <dd>{runtime.cwd || "未知（未提供）"}</dd>
                  <dt>Runtime 狀態</dt>
                  <dd>{runtime.runtimeState}</dd>
                </dl>
                {blocked && (
                  <p role="status">
                    釋放操作結果尚未確認；請查詢收據，不可再次釋放。
                  </p>
                )}
                {!runtime.releaseEligible && (
                  <p>{releaseReason(runtime.releaseBlockedReason)}</p>
                )}
                {runtime.releaseEligible && runtime.runtimeState !== "idle" && (
                  <p>只有閒置 Runtime 可以釋放。</p>
                )}
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => void release(runtime)}
                >
                  Release RPC
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {receipts.filter((receipt) => receipt.kind === "release").length > 0 && (
        <section aria-label="釋放操作收據" className="rpc-receipts">
          <h2>釋放操作結果</h2>
          <ul>
            {receipts
              .filter((receipt) => receipt.kind === "release")
              .map((receipt) => (
                <li key={receipt.operationId}>
                  <span>
                    {receipt.sessionId}：{receiptLabel(receipt)}（
                    {receipt.status}）
                  </span>
                  {isUnresolvedRelease(receipt) && (
                    <button
                      type="button"
                      onClick={() => void checkReceipt(receipt)}
                    >
                      查詢收據
                    </button>
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}
    </section>
  );
}
