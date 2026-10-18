import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  OperationKind,
  Profile,
  Project,
  Snapshot,
} from "../shared/contracts.js";
import {
  api,
  mergeActiveHistory,
  type HistoryEntry,
  type Session,
} from "./api.js";
import { Conversation } from "./Conversation.js";
import {
  emptyLiveTools,
  reconcileLiveTools,
  reduceLiveTools,
  type LiveToolsState,
} from "./conversation.js";
import { reconstructStreamEvent, resetStream } from "./streaming.js";
import { DialogPanel } from "./DialogPanel.js";
import { copyText, createOperationId } from "./browser-support.js";
import styles from "./ui.module.css";
import "./style.css";

type Event = { type: string; data?: unknown };
function staleRunningTools(
  state: LiveToolsState,
  runtimeState: Snapshot["runtimeState"],
): LiveToolsState {
  return ["idle", "blocked", "released"].includes(runtimeState)
    ? {
        ...state,
        tools: state.tools.map((tool) =>
          tool.status === "running" ? { ...tool, status: "pending" } : tool,
        ),
      }
    : state;
}

type SavedReceipt = {
  operationId: string;
  sessionId: string;
  kind: OperationKind;
  status: string;
};
function App() {
  const [authenticated, setAuthenticated] = useState(false),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [projects, setProjects] = useState<Project[]>([]),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [project, setProject] = useState(""),
    [profile, setProfile] = useState(""),
    [nativeFiles, setNativeFiles] = useState<
      Array<{ file: string; id?: string; error?: string }>
    >([]),
    [nativeFile, setNativeFile] = useState(""),
    [selected, setSelected] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [sessionLoadFailed, setSessionLoadFailed] = useState(false),
    [entries, setEntries] = useState<HistoryEntry[]>([]),
    [nextBefore, setNextBefore] = useState<string>(),
    [historyIncomplete, setHistoryIncomplete] = useState(false),
    [historyTruncated, setHistoryTruncated] = useState(false),
    [previewLoading, setPreviewLoading] = useState(false),
    [partial, setPartial] = useState(""),
    [connected, setConnected] = useState(false),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [mode, setMode] = useState<"prompt" | "steer" | "follow_up">("prompt"),
    [busy, setBusy] = useState(false),
    [receipts, setReceipts] = useState<SavedReceipt[]>(() => {
      try {
        return JSON.parse(sessionStorage.getItem("prw-receipts") || "[]").slice(
          0,
          30,
        );
      } catch {
        return [];
      }
    }),
    [receiptStatus, setReceiptStatus] = useState<Record<string, string>>({}),
    [liveTools, setLiveTools] = useState<LiveToolsState>(emptyLiveTools),
    [notices, setNotices] = useState<string[]>([]),
    [mobileOpen, setMobileOpen] = useState(false),
    [manualCopy, setManualCopy] = useState<string>();
  const generation = useRef(0),
    source = useRef<EventSource | undefined>(undefined),
    abort = useRef<AbortController | undefined>(undefined),
    eventCount = useRef(0),
    revision = useRef(0),
    syncSerial = useRef(0),
    timer = useRef<number | undefined>(undefined),
    retryTimer = useRef<number | undefined>(undefined),
    nativeAbort = useRef<AbortController | undefined>(undefined),
    nativeGeneration = useRef(0),
    connectRef = useRef<
      ((id: string, g: number, attempt?: number) => void) | undefined
    >(undefined),
    streamState = useRef(resetStream()),
    previousLeaf = useRef<string | undefined>(undefined),
    refreshRevision = useRef(0);
  const refreshLists = useCallback(async () => {
    const [p, f, s] = await Promise.all([
      api.projects(),
      api.profiles(),
      api.sessions(),
    ]);
    setProjects(p);
    setProfiles(f);
    setSessions(s);
    setProject((v) => v || p[0]?.id || "");
    setProfile((v) => v || f[0]?.id || "");
  }, []);
  const login = async () => {
    try {
      await api.login(token);
      setToken("");
      setAuthenticated(true);
      await refreshLists();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    api
      .me()
      .then(async () => {
        setAuthenticated(true);
        await refreshLists();
      })
      .catch(() => undefined);
  }, [refreshLists]);
  useEffect(() => {
    if (!authenticated || !project) return;
    const controller = new AbortController();
    nativeAbort.current?.abort();
    nativeAbort.current = controller;
    const requestGeneration = ++nativeGeneration.current;
    setNativeFile("");
    setNativeFiles([]);
    api
      .native(project, controller.signal)
      .then((files) => {
        if (requestGeneration === nativeGeneration.current) {
          const managed = new Set(
            sessions
              .filter((session) => session.projectId === project)
              .map((session) => session.nativeId),
          );
          setNativeFiles(
            files.filter((file) => !file.id || !managed.has(file.id)),
          );
        }
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          requestGeneration === nativeGeneration.current
        )
          setError((e as Error).message);
      });
  }, [authenticated, project, sessions]);
  const selectSession = useCallback(async (id: string) => {
    const g = ++generation.current;
    source.current?.close();
    window.clearTimeout(retryTimer.current);
    abort.current?.abort();
    abort.current = new AbortController();
    eventCount.current = 0;
    setSelected(id);
    setSessionLoadFailed(false);
    setError("");
    setManualCopy(undefined);
    setSnapshot(undefined);
    setEntries([]);
    streamState.current = resetStream();
    setPartial("");
    setLiveTools(emptyLiveTools());
    previousLeaf.current = undefined;
    setConnected(false);
    setNextBefore(undefined);
    setHistoryIncomplete(false);
    setHistoryTruncated(false);
    refreshRevision.current++;
    setNotices([]);
    try {
      const [s, h] = await Promise.all([
        api.snapshot(id, abort.current.signal),
        api.history(id, undefined, abort.current.signal),
      ]);
      if (g !== generation.current) return;
      setSnapshot(s);
      setEntries(h.entries);
      setNextBefore(h.continuation ?? h.nextBefore);
      setHistoryIncomplete(h.incomplete);
      setHistoryTruncated(h.truncated);
      connectRef.current = (sessionId, generationId, attempt = 0) => {
        if (generationId !== generation.current || !navigator.onLine) return;
        const es = new EventSource(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        );
        source.current = es;
        es.onopen = () => {
          if (generationId !== generation.current) return;
          setLiveTools(emptyLiveTools());
          if (!navigator.onLine) {
            es.close();
            setConnected(false);
            return;
          }
          const serial = ++syncSerial.current;
          const beforeRevision = revision.current;
          const refreshAtRequest = refreshRevision.current;
          void Promise.all([api.snapshot(sessionId), api.history(sessionId)])
            .then(([ss, hh]) => {
              if (
                generationId !== generation.current ||
                serial !== syncSerial.current ||
                refreshAtRequest !== refreshRevision.current ||
                !navigator.onLine
              )
                return;
              if (revision.current === beforeRevision) {
                setSnapshot(ss);
                setLiveTools((old) => staleRunningTools(old, ss.runtimeState));
              }
              setEntries((old) =>
                hh.incomplete && hh.entries.length === 0
                  ? old
                  : mergeActiveHistory(old, hh.entries),
              );
              setNextBefore(hh.continuation ?? hh.nextBefore);
              setHistoryIncomplete(hh.incomplete);
              setHistoryTruncated(hh.truncated);
              setConnected(true);
            })
            .catch((e) => {
              if (generationId === generation.current)
                setError((e as Error).message);
              setConnected(false);
            });
        };
        es.onerror = () => {
          if (generationId !== generation.current) return;
          setConnected(false);
          es.close();
          if (!navigator.onLine) return;
          void api.me().then(
            () => {
              if (generationId !== generation.current) return;
              const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 15000);
              retryTimer.current = window.setTimeout(
                () =>
                  connectRef.current?.(sessionId, generationId, attempt + 1),
                delay,
              );
            },
            (e) => {
              if (
                generationId === generation.current &&
                (e as { status?: number }).status === 401
              ) {
                generation.current++;
                setAuthenticated(false);
                setError("登入已逾期，請重新登入。");
              }
            },
          );
        };
        es.onmessage = (message) => {
          if (generationId !== generation.current) return;
          try {
            const event = JSON.parse(message.data) as Event;
            if (event.type === "snapshot") {
              revision.current++;
              const nextSnapshot = event.data as Snapshot;
              setSnapshot(nextSnapshot);
              setLiveTools((old) =>
                staleRunningTools(old, nextSnapshot.runtimeState),
              );
              eventCount.current++;
            } else if (event.type === "resync-required") {
              revision.current++;
              streamState.current = resetStream();
              setPartial("");
              setLiveTools(emptyLiveTools());
              previousLeaf.current = undefined;
              void sync(sessionId, generationId);
            } else if (event.type === "rpc")
              handleRpc(event.data, sessionId, generationId);
          } catch {
            setError("無法解析即時事件；請重新同步。");
          }
        };
      };
      connectRef.current(id, g);
    } catch (e) {
      if (g === generation.current) {
        setSessionLoadFailed(true);
        setError((e as Error).message);
      }
    }
  }, []);
  useEffect(() => {
    const oldLeaf = previousLeaf.current;
    setLiveTools((state) => reconcileLiveTools(state, entries, oldLeaf));
    previousLeaf.current = entries.at(-1)?.id;
  }, [entries]);
  useEffect(() => {
    const offline = () => {
      setConnected(false);
      source.current?.close();
      source.current = undefined;
      window.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
      syncSerial.current++;
    };
    const online = () => {
      if (!authenticated || !selected || !navigator.onLine) return;
      source.current?.close();
      source.current = undefined;
      window.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
      setConnected(false);
      connectRef.current?.(selected, generation.current, 0);
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [authenticated, selected]);
  function handleRpc(value: unknown, id: string, g: number) {
    if (!value || typeof value !== "object") return;
    const e = value as Record<string, unknown>;
    if (g !== generation.current) return;
    if (e.type === "agent_start") setLiveTools(emptyLiveTools());
    if (e.type === "message_start") {
      const message = e.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        streamState.current = resetStream();
        setPartial("");
      }
    }
    if (e.type === "message_update") {
      const update = e.assistantMessageEvent as
        Record<string, unknown> | undefined;
      if (update?.type === "text_delta" || update?.type === "text_end") {
        const result = reconstructStreamEvent(streamState.current, update);
        streamState.current = result.state;
        setPartial(result.text);
      }
    }
    if (e.type === "agent_settled" || e.type === "message_end") {
      streamState.current = resetStream();
      setPartial("");
    }
    if (
      e.type === "message_end" ||
      e.type === "entry_appended" ||
      e.type === "agent_settled" ||
      e.type === "compaction_end"
    ) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (g === generation.current) void sync(id, g);
      }, 180);
    }
    if (e.type === "extension_ui_request") {
      const method = String(e.method ?? "");
      const text =
        method === "notify" || method === "setStatus" || method === "setTitle"
          ? `${method}: ${String(e.message ?? e.text ?? e.title ?? "")}`
          : ![
                "confirm",
                "select",
                "input",
                "editor",
                "setWidget",
                "set_editor_text",
              ].includes(method)
            ? `不支援的 Extension UI：${method || "未知方法"}（已取消）`
            : "";
      if (text) setNotices((old) => [...old, text].slice(-20));
    }
    if (String(e.type || "").startsWith("tool_execution_")) {
      setLiveTools((old) => reduceLiveTools(old, e));
    }
    if (e.type === "agent_settled")
      setLiveTools((old) => ({
        ...old,
        tools: old.tools.map((tool) =>
          tool.status === "running" ? { ...tool, status: "pending" } : tool,
        ),
      }));
  }
  async function sync(id: string, g: number) {
    try {
      const serial = ++syncSerial.current;
      const beforeRevision = revision.current;
      const refreshAtRequest = refreshRevision.current;
      const [s, h] = await Promise.all([api.snapshot(id), api.history(id)]);
      if (
        g !== generation.current ||
        serial !== syncSerial.current ||
        refreshAtRequest !== refreshRevision.current
      )
        return;
      if (revision.current === beforeRevision) setSnapshot(s);
      if (revision.current === beforeRevision)
        setLiveTools((old) => staleRunningTools(old, s.runtimeState));
      setEntries((old) =>
        h.incomplete && h.entries.length === 0
          ? old
          : mergeActiveHistory(old, h.entries),
      );
      setNextBefore(h.continuation ?? h.nextBefore);
      setHistoryIncomplete(h.incomplete);
      setHistoryTruncated(h.truncated);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "prw-receipts",
        JSON.stringify(receipts.slice(0, 30)),
      );
    } catch {
      /* Storage may be disabled or full. */
    }
  }, [receipts]);
  useEffect(() => {
    const expired = () => {
      generation.current++;
      abort.current?.abort();
      nativeAbort.current?.abort();
      source.current?.close();
      window.clearTimeout(timer.current);
      window.clearTimeout(retryTimer.current);
      setConnected(false);
      setLiveTools(emptyLiveTools());
      previousLeaf.current = undefined;
      setAuthenticated(false);
      setManualCopy(undefined);
      setError("登入已逾期，請重新登入。");
    };
    window.addEventListener("prw-auth-expired", expired);
    return () => window.removeEventListener("prw-auth-expired", expired);
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
      source.current?.close();
      window.clearTimeout(timer.current);
      window.clearTimeout(retryTimer.current);
      nativeAbort.current?.abort();
    },
    [],
  );
  async function loadOlder() {
    const id = selected,
      g = generation.current,
      serial = syncSerial.current,
      rev = refreshRevision.current,
      before = nextBefore,
      currentAtRequest = entries;
    if (!id || !before) return;
    try {
      const h = await api.history(id, before);
      if (
        g !== generation.current ||
        serial !== syncSerial.current ||
        rev !== refreshRevision.current
      )
        return;
      const pageIsContinuous = h.entries.every(
        (entry, index) =>
          index === 0 || entry.parentId === h.entries[index - 1]?.id,
      );
      const currentFirst = currentAtRequest[0];
      const pageConnectsToCurrent =
        !currentFirst ||
        h.entries.length === 0 ||
        h.entries.at(-1)?.id === currentFirst.parentId;
      if (h.entries.length && (!pageIsContinuous || !pageConnectsToCurrent)) {
        setError("較舊歷史不連續；正在重新同步。");
        await sync(id, g);
        return;
      }
      if (h.entries.length)
        setEntries((current) => mergeActiveHistory(h.entries, current));
      setNextBefore(h.continuation ?? h.nextBefore);
      setHistoryIncomplete(h.incomplete);
      setHistoryTruncated(h.truncated);
    } catch (e) {
      if (g === generation.current && rev === refreshRevision.current) {
        const error = e as Error & { code?: string };
        setError(
          error.code === "reload-required"
            ? "歷史已變更；請重新載入。"
            : error.message,
        );
      }
    }
  }
  async function refreshHistory(previewBytes?: number) {
    const id = selected,
      g = generation.current,
      rev = ++refreshRevision.current;
    if (!id) return;
    setPreviewLoading(true);
    try {
      const h = await api.history(id, undefined, undefined, previewBytes);
      if (g !== generation.current || rev !== refreshRevision.current) return;
      setEntries(h.entries);
      setNextBefore(h.continuation ?? h.nextBefore);
      setHistoryIncomplete(h.incomplete);
      setHistoryTruncated(h.truncated);
    } catch (e) {
      if (g === generation.current && rev === refreshRevision.current) {
        const error = e as Error & { code?: string };
        setError(
          error.code === "reload-required"
            ? "歷史已變更；請重新載入。"
            : error.message,
        );
      }
    } finally {
      if (rev === refreshRevision.current) setPreviewLoading(false);
    }
  }
  async function create(importExisting = false) {
    if (busy) return;
    setBusy(true);
    try {
      const s = await api.create(
        project,
        profile,
        importExisting ? nativeFile : undefined,
      );
      await refreshLists();
      await selectSession(s.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(
    kind: OperationKind,
    text?: string,
    ui?: { dialogId: string; method: string; value: unknown },
  ) {
    const sessionId = selected,
      requestGeneration = generation.current,
      frozen = text ?? drafts[sessionId] ?? "";
    if (
      !sessionId ||
      busy ||
      !snapshot ||
      snapshot.runtimeState === "blocked" ||
      snapshot.runtimeState === "stopping" ||
      !connected ||
      !navigator.onLine
    )
      return;
    setBusy(true);
    let operationId: string | undefined;
    try {
      operationId = createOperationId();
      const item = { operationId, sessionId, kind, status: "DISPATCHED" };
      const list = [item, ...receipts].slice(0, 30);
      setReceipts(list);
      const receipt = await api.operation(sessionId, {
        operationId,
        kind,
        ...(frozen ? { text: frozen } : {}),
        ...(ui ?? {}),
      });
      setReceipts((old) =>
        old.map((r) =>
          r.operationId === operationId ? { ...r, status: receipt.status } : r,
        ),
      );
      if (
        ["ACCEPTED", "HANDLED"].includes(receipt.status) &&
        kind !== "stop" &&
        kind !== "compact" &&
        kind !== "release" &&
        kind !== "claim" &&
        kind !== "ui_response"
      ) {
        setDrafts((old) => {
          if (old[sessionId] !== frozen) return old;
          const next = { ...old };
          delete next[sessionId];
          return next;
        });
      }
      await sync(sessionId, requestGeneration);
    } catch (e) {
      if (!operationId) {
        setError((e as Error).message);
        setBusy(false);
        return;
      }
      const statusCode = (e as { status?: number }).status;
      let status = statusCode === 401 ? "登入逾期" : "UNKNOWN";
      if (statusCode && statusCode !== 401) {
        try {
          const known = await api.receipt(operationId);
          status = known.status;
        } catch (receiptError) {
          if ((receiptError as { status?: number }).status === 404)
            status = "REJECTED";
        }
      }
      setError((e as Error).message);
      setReceipts((old) =>
        old.map((r) => (r.operationId === operationId ? { ...r, status } : r)),
      );
      if (status === "登入逾期") {
        setAuthenticated(false);
        generation.current++;
        source.current?.close();
        window.clearTimeout(timer.current);
      }
    } finally {
      setBusy(false);
    }
  }
  async function respond(
    dialog: NonNullable<Snapshot["pendingDialogs"]>[number],
    value: unknown,
  ) {
    if (!selected) return;
    await submit("ui_response", undefined, {
      dialogId: dialog.id,
      method: dialog.method,
      value,
    });
  }
  async function checkReceipt(r: SavedReceipt) {
    try {
      const v = await api.receipt(r.operationId);
      setReceiptStatus((old) => ({ ...old, [r.operationId]: v.status }));
      setReceipts((old) =>
        old.map((x) =>
          x.operationId === r.operationId ? { ...x, status: v.status } : x,
        ),
      );
    } catch (e) {
      setReceiptStatus((old) => ({
        ...old,
        [r.operationId]:
          (e as { status?: number }).status === 404
            ? "找不到；未重送"
            : "查詢失敗",
      }));
    }
  }
  useEffect(() => {
    for (const r of receipts)
      if (r.status === "UNKNOWN" || r.status === "DISPATCHED")
        void checkReceipt(r);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.isComposing &&
        !document.querySelector('[aria-label="Extension 對話"]') &&
        snapshot?.pendingDialogs?.length === 0 &&
        snapshot?.runtimeState === "running"
      ) {
        e.preventDefault();
        void submit("stop");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [snapshot, selected, busy, connected]);
  if (!authenticated)
    return (
      <main className={styles.login}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <div className={styles.mark}>π</div>
          <h1>Pi Remote Workspace</h1>
          <p>使用主機 Owner token 登入</p>
          <input
            aria-label="Owner token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button>登入</button>
          {error && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  const running = snapshot?.runtimeState === "running",
    locked =
      !connected ||
      busy ||
      !snapshot ||
      ["blocked", "stopping", "releasing"].includes(snapshot.runtimeState);
  return (
    <div className={styles.app}>
      <aside className={`${styles.sidebar} ${mobileOpen ? styles.open : ""}`}>
        <div className={styles.brand}>
          π <span>Pi Remote</span>
          <button
            className={styles.mobileClose}
            onClick={() => setMobileOpen(false)}
          >
            關閉
          </button>
        </div>
        <label>
          <span id="project-label">
            Project（目前：
            {projects.find((p) => p.id === project)?.name ?? project}）
          </span>
          <select
            aria-labelledby="project-label"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setNativeFile("");
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span id="profile-label">Profile</span>
          <select
            aria-labelledby="profile-label"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !project || !profile}
          onClick={() => void create()}
        >
          ＋ 新建 Session
        </button>
        <label>
          <span id="native-session-label">加入既有 Pi session</span>
          <select
            aria-labelledby="native-session-label"
            value={nativeFile}
            onChange={(e) => setNativeFile(e.target.value)}
          >
            <option value="">
              {nativeFiles.length ? "選擇 session…" : "沒有尚未加入的 session"}
            </option>
            {nativeFiles.map((n) => (
              <option key={n.file} value={n.file} disabled={!n.id || !!n.error}>
                {n.id || "Session ID 不可用"}
                {n.error ? ` — ${n.error}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !nativeFile}
          onClick={() => void create(true)}
        >
          加入選取的 session
        </button>
        <div className={styles.sessionLabel}>受管 Sessions</div>
        <nav>
          {sessions
            .filter((s) => s.projectId === project)
            .map((s) => (
              <button
                key={s.id}
                className={selected === s.id ? styles.selected : ""}
                onClick={() => {
                  void selectSession(s.id);
                  setMobileOpen(false);
                }}
              >
                <span>{s.nativeId.slice(0, 8)}</span>
                <small>
                  {s.id.slice(0, 8)} · {s.profileId}
                </small>
              </button>
            ))}
        </nav>
        <button
          className={styles.logout}
          onClick={() => {
            void api.logout().finally(() => {
              generation.current++;
              abort.current?.abort();
              nativeAbort.current?.abort();
              source.current?.close();
              window.clearTimeout(timer.current);
              window.clearTimeout(retryTimer.current);
              setConnected(false);
              setLiveTools(emptyLiveTools());
              previousLeaf.current = undefined;
              setSnapshot(undefined);
              setEntries([]);
              streamState.current = resetStream();
              setPartial("");
              setAuthenticated(false);
              setManualCopy(undefined);
              setSessions([]);
            });
          }}
        >
          登出
        </button>
      </aside>
      <main className={styles.main}>
        <header className={styles.header}>
          <button className={styles.menu} onClick={() => setMobileOpen(true)}>
            ☰
          </button>
          <div>
            <strong>
              {snapshot ? `原生 ${snapshot.nativeId}` : "選擇或建立 Session"}
            </strong>
            <small>App ID：{snapshot?.id || selected || "—"}</small>
          </div>
          <span
            className={`${styles.connection} ${connected ? styles.online : ""}`}
          >
            {connected ? "● 已連線" : "○ 離線"}
          </span>
        </header>
        {manualCopy !== undefined && (
          <section aria-label="手動複製">
            <label>
              手動複製內容
              <textarea
                readOnly
                value={manualCopy}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button onClick={() => setManualCopy(undefined)}>關閉</button>
          </section>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
            <button onClick={() => setError("")}>關閉</button>
          </div>
        )}
        {snapshot && (
          <section className={styles.status}>
            <span>
              Runtime <b>{snapshot.runtimeState}</b>
            </span>
            <span>
              Provider <b>{snapshot.actualProvider || "—"}</b>
            </span>
            <span>
              Model <b>{snapshot.actualModel || "—"}</b>
            </span>
            <span>
              Thinking <b>{snapshot.actualThinking || "—"}</b>
            </span>
            <span>
              原生 Pi ID <b>{snapshot.nativeId}</b>
            </span>
            <span>
              cwd <b>{snapshot.cwd || "—"}</b>{" "}
              {snapshot.cwd && (
                <button
                  onClick={() => {
                    const g = generation.current;
                    const frozenText = snapshot.cwd!;
                    void copyText(frozenText).then((copied) => {
                      if (!copied && g === generation.current)
                        setManualCopy(frozenText);
                    });
                  }}
                >
                  複製 cwd
                </button>
              )}
            </span>
            <span>
              Session dir <b>{snapshot.sessionDir || "—"}</b>{" "}
              {snapshot.sessionDir && (
                <button
                  onClick={() => {
                    const g = generation.current;
                    const frozenText = snapshot.sessionDir!;
                    void copyText(frozenText).then((copied) => {
                      if (!copied && g === generation.current)
                        setManualCopy(frozenText);
                    });
                  }}
                >
                  複製 session dir
                </button>
              )}
            </span>
            {snapshot.nativeCommand && (
              <button
                onClick={() => {
                  const g = generation.current;
                  const frozenText = snapshot.nativeCommand!;
                  void copyText(frozenText).then((copied) => {
                    if (!copied && g === generation.current)
                      setManualCopy(frozenText);
                  });
                }}
              >
                複製原生 Pi 命令
              </button>
            )}
            <p role="note">
              只限同一主機與同一原生檔案。請勿讓 Web 與原生 Pi
              同時寫入。重用既有 TUI 前也要重新載入 session。
            </p>
            <span>
              Outcome <b>{snapshot.lastOutcome || "—"}</b>
            </span>
            {snapshot.lastError && <b>錯誤 {snapshot.lastError}</b>}
            {notices.map((notice, index) => (
              <span role="status" key={`${index}-${notice}`}>
                {notice}
              </span>
            ))}
          </section>
        )}
        <section className={styles.chat}>
          {!selected ? (
            <div className={styles.empty}>
              請選擇既有 session，或建立新的工作階段。
            </div>
          ) : !snapshot ? (
            sessionLoadFailed ? (
              <div className={styles.empty}>
                <p>無法載入 session 狀態與歷史</p>
                <button onClick={() => void selectSession(selected)}>
                  重試載入
                </button>
              </div>
            ) : (
              <div className={styles.empty}>同步 session 狀態與歷史…</div>
            )
          ) : (
            <>
              {historyIncomplete && entries.length === 0 && (
                <p role="status">
                  歷史讀取未完成；這不是空 session，也不代表已讀取完成。
                </p>
              )}
              {(historyTruncated ||
                entries.some((entry) => entry.truncated)) && (
                <p role="status">內容已截斷；可按需讀取較完整預覽。</p>
              )}
              {entries
                .filter((entry) => entry.truncated)
                .map((entry) => (
                  <p role="status" key={`truncated-${entry.id}`}>
                    歷史項目 {entry.id}：內容已截斷；可按需讀取較完整預覽。
                  </p>
                ))}
              {historyIncomplete && (
                <button
                  className={styles.older}
                  disabled={!nextBefore}
                  onClick={() => void loadOlder()}
                >
                  繼續讀取歷史
                </button>
              )}
              {!historyIncomplete && (
                <button
                  className={styles.older}
                  disabled={!nextBefore}
                  onClick={() => void loadOlder()}
                >
                  載入較舊歷史
                </button>
              )}
              <button
                className={styles.older}
                disabled={previewLoading}
                onClick={() => void refreshHistory(65536)}
              >
                重新載入最新頁（較完整預覽）
              </button>
              <Conversation
                entries={entries}
                live={liveTools.tools}
                omitted={liveTools.omitted}
                partial={partial}
              />
              {snapshot.queue.length > 0 && (
                <details className={styles.cleared} open>
                  <summary>等待中的佇列（{snapshot.queue.length}）</summary>
                  {snapshot.queue.map((q, i) => (
                    <div key={`${q.kind}-${i}`}>
                      <b>{q.kind === "steer" ? "Steering" : "Follow-up"}</b>
                      <pre>{q.text}</pre>
                    </div>
                  ))}
                </details>
              )}
              {snapshot.cleared.length > 0 && (
                <details className={styles.cleared}>
                  <summary>已清除佇列（不會自動重送）</summary>
                  {snapshot.cleared.map((q, i) => (
                    <div key={i}>
                      <b>{q.kind}</b>
                      <pre>{q.text}</pre>
                      <button
                        onClick={() => {
                          const requestGeneration = generation.current;
                          void copyText(q.text).then((copied) => {
                            if (
                              !copied &&
                              requestGeneration === generation.current
                            )
                              setManualCopy(q.text);
                          });
                        }}
                      >
                        複製
                      </button>
                      <button
                        onClick={() => {
                          if (
                            confirm("將內容加入目前草稿？原草稿會保留在前面。")
                          )
                            setDrafts((old) => {
                              const current = old[selected] ?? "";
                              return {
                                ...old,
                                [selected]: `${current}${current ? "\n" : ""}${q.text}`,
                              };
                            });
                        }}
                      >
                        加入草稿
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </section>
        {snapshot?.pendingDialogs?.length ? (
          <DialogPanel
            dialogs={snapshot.pendingDialogs}
            disabled={locked}
            onRespond={(dialog, value) => void respond(dialog, value)}
          />
        ) : null}
        {snapshot?.runtimeState === "released" && (
          <p role="status">Pi 尚未啟動；首次送出 prompt 時才會開始操作。</p>
        )}
        {snapshot?.runtimeState === "blocked" && (
          <p role="alert">
            Runtime 已阻擋。請由主機檢查 Pi 程序、原生 session 與 writer
            lock；不會自動重送操作。
          </p>
        )}
        {snapshot && (
          <section className={styles.controls}>
            <div className={styles.actions}>
              <button
                disabled={
                  locked ||
                  running ||
                  snapshot.runtimeState !== "idle" ||
                  snapshot.queue.length > 0
                }
                onClick={() => void submit("compact")}
              >
                Compact
              </button>
              {running && (
                <button
                  className={styles.stop}
                  disabled={locked}
                  onClick={() => void submit("stop")}
                >
                  清佇列並停止；不回滾檔案/commit
                </button>
              )}
            </div>
            <div className={styles.draft}>
              <select
                aria-label="操作模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="prompt" disabled={running}>
                  Prompt
                </option>
                <option value="steer" disabled={!running}>
                  Steering
                </option>
                <option value="follow_up" disabled={!running}>
                  Follow-up
                </option>
              </select>
              <textarea
                aria-label="訊息草稿"
                value={drafts[selected] ?? ""}
                disabled={
                  !connected ||
                  snapshot.runtimeState === "blocked" ||
                  snapshot.runtimeState === "stopping"
                }
                onChange={(e) => {
                  setDrafts((old) => ({ ...old, [selected]: e.target.value }));
                }}
                onKeyDown={(e) => {
                  if (
                    (e.ctrlKey || e.metaKey) &&
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit(mode);
                  }
                }}
                placeholder="輸入訊息；Ctrl/Cmd + Enter 送出"
              />
              <button
                disabled={
                  locked ||
                  !(drafts[selected] ?? "").trim() ||
                  (running && mode === "prompt") ||
                  (!running && mode !== "prompt")
                }
                onClick={() => void submit(mode)}
              >
                送出
              </button>
            </div>
          </section>
        )}
        <section className={styles.receipts}>
          <details>
            <summary>最近操作收據（{receipts.length}）</summary>
            {receipts.map((r) => (
              <div key={r.operationId}>
                <span>
                  {r.sessionId.slice(0, 8)} · {r.kind} · {r.status}
                  {r.status === "ACCEPTED"
                    ? "（已接受，不代表執行完成）"
                    : r.status === "HANDLED"
                      ? "（已處理）"
                      : r.status === "DISPATCHED"
                        ? "（結果待確認）"
                        : ""}{" "}
                  · {r.operationId.slice(0, 8)}
                </span>
                <button onClick={() => void checkReceipt(r)}>查詢收據</button>
                {receiptStatus[r.operationId] && (
                  <small>{receiptStatus[r.operationId]}</small>
                )}
              </div>
            ))}
          </details>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
