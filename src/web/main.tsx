import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  OperationKind,
  Profile,
  Project,
  Snapshot,
  SessionNameInfo,
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
import { canSubmitMessage, type MessageKind } from "./session-ui.js";
import { sessionNameLabel } from "./session-names.js";
import { normalizeSessionName } from "../shared/session-names.js";
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
    [globalError, setGlobalError] = useState(""),
    [sessionErrors, setSessionErrors] = useState<Record<string, string[]>>({}),
    [projects, setProjects] = useState<Project[]>([]),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [project, setProject] = useState(""),
    [profile, setProfile] = useState(""),
    [newSessionName, setNewSessionName] = useState(""),
    [nameInfos, setNameInfos] = useState<Record<string, SessionNameInfo>>({}),
    [nativeFiles, setNativeFiles] = useState<
      Array<{
        file: string;
        id?: string;
        error?: string;
        nameInfo?: SessionNameInfo;
      }>
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
    [manualCopy, setManualCopy] = useState<string>(),
    [isPinned, setIsPinned] = useState(true),
    [isMobile, setIsMobile] = useState(
      () =>
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 700px)").matches,
    );
  const menuRef = useRef<HTMLButtonElement>(null),
    closeRef = useRef<HTMLButtonElement>(null),
    chatRef = useRef<HTMLElement>(null),
    chatContentRef = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    lastSessionForScroll = useRef(""),
    previousMobileOpen = useRef(false),
    pendingAnchor = useRef<
      | {
          sessionId: string;
          generation: number;
          scrollTop: number;
          scrollHeight: number;
        }
      | undefined
    >(undefined);
  const reportSessionError = (id: string, message: string) => {
    if (!id) return;
    setSessionErrors((old) => ({
      ...old,
      [id]: [...(old[id] ?? []), message].slice(-10),
    }));
  };
  const canSend = (kind: MessageKind, draft: string) =>
    canSubmitMessage({
      kind,
      draft,
      runtimeState: snapshot?.runtimeState,
      connected,
      online: navigator.onLine,
      busy,
      hasSnapshot: !!snapshot,
    });
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
    refreshRevision = useRef(0),
    listRequestSerial = useRef(0);
  const refreshLists = useCallback(async () => {
    const requestGeneration = generation.current;
    const requestSerial = ++listRequestSerial.current;
    const [p, f, s] = await Promise.all([
      api.projects(),
      api.profiles(),
      api.sessions(),
    ]);
    if (
      requestGeneration !== generation.current ||
      requestSerial !== listRequestSerial.current
    )
      return;
    setProjects(p);
    setProfiles(f);
    setSessions(s);
    setNameInfos((old) => {
      const next = { ...old };
      for (const session of s)
        if (session.nameInfo) next[session.id] = session.nameInfo;
      return next;
    });
    setProject((v) => v || p[0]?.id || "");
    setProfile((v) => v || f[0]?.id || "");
  }, []);
  const login = async () => {
    try {
      await api.login(token);
      setGlobalError("");
      setSessionErrors({});
      setNameInfos({});
      setToken("");
      setAuthenticated(true);
      await refreshLists();
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const change = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!isMobile && mobileOpen) setMobileOpen(false);
  }, [isMobile, mobileOpen]);
  useEffect(() => {
    api.me(false).then(
      async () => {
        setAuthenticated(true);
        try {
          await refreshLists();
        } catch (e) {
          setGlobalError((e as Error).message);
        }
      },
      () => undefined,
    );
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
          setGlobalError((e as Error).message);
      });
  }, [authenticated, project, sessions]);
  const selectSession = useCallback(async (id: string) => {
    const g = ++generation.current;
    pinned.current = true;
    setIsPinned(true);
    pendingAnchor.current = undefined;
    source.current?.close();
    window.clearTimeout(retryTimer.current);
    abort.current?.abort();
    abort.current = new AbortController();
    eventCount.current = 0;
    setSelected(id);
    setSessionLoadFailed(false);
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
      if (s.nameInfo) setNameInfos((old) => ({ ...old, [id]: s.nameInfo! }));
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
              if (ss.nameInfo)
                setNameInfos((old) => ({ ...old, [sessionId]: ss.nameInfo! }));
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
                reportSessionError(sessionId, (e as Error).message);
              if (generationId === generation.current) setConnected(false);
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
                setGlobalError("登入已逾期，請重新登入。");
                setSessionErrors({});
                setNameInfos({});
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
            reportSessionError(sessionId, "無法解析即時事件；請重新同步。");
          }
        };
      };
      connectRef.current(id, g);
    } catch (e) {
      if (g === generation.current) {
        setSessionLoadFailed(true);
        reportSessionError(id, (e as Error).message);
      }
    }
  }, []);
  useLayoutEffect(() => {
    const container = chatRef.current;
    if (!container) return;
    const anchor = pendingAnchor.current;
    if (anchor) {
      pendingAnchor.current = undefined;
      if (
        anchor.sessionId === selected &&
        anchor.generation === generation.current
      )
        container.scrollTop =
          anchor.scrollTop + container.scrollHeight - anchor.scrollHeight;
      return;
    }
    const newSession = lastSessionForScroll.current !== selected;
    if (newSession) {
      lastSessionForScroll.current = selected;
      pinned.current = true;
      setIsPinned(true);
      container.scrollTop = container.scrollHeight;
    } else if (pinned.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [selected, snapshot, entries, partial, liveTools]);
  useLayoutEffect(() => {
    if (previousMobileOpen.current && !mobileOpen && isMobile)
      menuRef.current?.focus();
    if (mobileOpen && isMobile) closeRef.current?.focus();
    previousMobileOpen.current = mobileOpen;
  }, [mobileOpen, isMobile]);
  useEffect(() => {
    const container = chatRef.current;
    const content = chatContentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [selected, snapshot?.id]);
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
    if (g !== generation.current) return;
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
      if (s.nameInfo) setNameInfos((old) => ({ ...old, [id]: s.nameInfo! }));
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
      if (g === generation.current)
        reportSessionError(id, (e as Error).message);
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
      setGlobalError("登入已逾期，請重新登入。");
      setSessionErrors({});
      setNameInfos({});
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
      const container = chatRef.current;
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
        reportSessionError(id, "較舊歷史不連續；正在重新同步。");
        await sync(id, g);
        return;
      }
      if (h.entries.length) {
        pendingAnchor.current = {
          sessionId: id,
          generation: g,
          scrollTop: container?.scrollTop ?? 0,
          scrollHeight: container?.scrollHeight ?? 0,
        };
        pinned.current = false;
        setIsPinned(false);
        setEntries((current) => mergeActiveHistory(h.entries, current));
      }
      setNextBefore(h.continuation ?? h.nextBefore);
      setHistoryIncomplete(h.incomplete);
      setHistoryTruncated(h.truncated);
    } catch (e) {
      if (g === generation.current && rev === refreshRevision.current) {
        const error = e as Error & { code?: string };
        reportSessionError(
          id,
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
        reportSessionError(
          id,
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
    if (!importExisting) {
      const validated = normalizeSessionName(newSessionName);
      if (!validated.ok) {
        setGlobalError(
          "Session 名稱無效。請使用最多 128 個 Unicode code points，且不要包含控制字元或換行。",
        );
        return;
      }
    }
    setBusy(true);
    try {
      const s = await api.create(
        project,
        profile,
        importExisting ? nativeFile : undefined,
        importExisting ? undefined : newSessionName,
      );
      if (!importExisting) setNewSessionName("");
      await refreshLists();
      await selectSession(s.id);
    } catch (e) {
      setGlobalError(
        `建立失敗：${(e as Error).message}。請重新整理 Session 清單確認結果；不會自動重送。`,
      );
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
      ((kind === "prompt" || kind === "steer" || kind === "follow_up") &&
        !canSend(kind, frozen)) ||
      busy ||
      !snapshot ||
      snapshot.runtimeState === "blocked" ||
      snapshot.runtimeState === "stopping" ||
      !connected ||
      !navigator.onLine
    )
      return;
    if (kind === "prompt" || kind === "steer" || kind === "follow_up") {
      pinned.current = true;
      setIsPinned(true);
      if (chatRef.current)
        chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
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
        reportSessionError(sessionId, (e as Error).message);
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
      reportSessionError(sessionId, (e as Error).message);
      setReceipts((old) =>
        old.map((r) => (r.operationId === operationId ? { ...r, status } : r)),
      );
      if (status === "登入逾期") {
        setAuthenticated(false);
        setGlobalError("登入已逾期，請重新登入。");
        setSessionErrors({});
        setNameInfos({});
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
      if (e.key === "Escape" && e.isComposing) return;
      if (e.key === "Escape" && mobileOpen && isMobile) {
        e.preventDefault();
        e.stopPropagation();
        setMobileOpen(false);
        return;
      }
      if (
        e.key === "Escape" &&
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
  }, [snapshot, selected, busy, connected, mobileOpen, isMobile]);
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
          {globalError && <p role="alert">{globalError}</p>}
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
      <aside
        id="session-sidebar"
        className={`${styles.sidebar} ${mobileOpen ? styles.open : ""}`}
      >
        <div className={styles.brand}>
          π <span>Pi Remote</span>
          <button
            ref={closeRef}
            className={styles.mobileClose}
            onClick={() => {
              setMobileOpen(false);
            }}
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
        <label>
          <span>Session 名稱（選填）</span>
          <input
            aria-label="Session 名稱（選填）"
            type="text"
            value={newSessionName}
            onChange={(event) => setNewSessionName(event.target.value)}
          />
        </label>
        <button
          disabled={busy || !project || !profile}
          onClick={() => void create()}
        >
          ＋ 新建 Session
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void refreshLists().catch((e) =>
              setGlobalError((e as Error).message),
            )
          }
        >
          重新整理 Session 清單
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
                {n.nameInfo ? `${sessionNameLabel(n.nameInfo)} · ` : ""}
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
                <span className={styles.sessionText}>
                  {sessionNameLabel(nameInfos[s.id])}
                </span>
                <small className={styles.sessionText}>
                  Pi session ID：{s.nativeId} · App ID：{s.id.slice(0, 8)} ·{" "}
                  {s.profileId}
                </small>
              </button>
            ))}
        </nav>
        <button
          className={styles.logout}
          onClick={() => {
            void api.logout().finally(() => {
              generation.current++;
              listRequestSerial.current++;
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
              setSessionErrors({});
              setGlobalError("");
              setManualCopy(undefined);
              setSessions([]);
              setNameInfos({});
            });
          }}
        >
          登出
        </button>
      </aside>
      {mobileOpen && (
        <button
          aria-label="關閉側欄遮罩"
          className={styles.overlay}
          onClick={() => {
            setMobileOpen(false);
          }}
        />
      )}
      <main
        className={styles.main}
        inert={mobileOpen && isMobile ? true : undefined}
      >
        <header className={styles.header}>
          <button
            ref={menuRef}
            aria-expanded={mobileOpen}
            aria-controls="session-sidebar"
            className={styles.menu}
            onClick={() => setMobileOpen(true)}
          >
            ☰
          </button>
          <div>
            <strong className={styles.sessionText}>
              {snapshot
                ? sessionNameLabel(nameInfos[selected])
                : "選擇或建立 Session"}
            </strong>
            <span className={styles.sessionText} aria-label="Pi session ID">
              Pi session ID：{snapshot?.nativeId || "—"}
            </span>
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
        {globalError && (
          <div className={styles.error} role="alert" aria-label="全域錯誤">
            {globalError}
            <button onClick={() => setGlobalError("")}>關閉全域錯誤</button>
          </div>
        )}
        {(sessionErrors[selected] ?? []).map((message, index) => (
          <div
            className={styles.error}
            role="alert"
            aria-label="Session 錯誤"
            key={`${index}-${message}`}
          >
            {message}
            <button
              onClick={() =>
                setSessionErrors((old) => ({
                  ...old,
                  [selected]: (old[selected] ?? []).filter(
                    (_, i) => i !== index,
                  ),
                }))
              }
            >
              關閉 Session 錯誤
            </button>
          </div>
        ))}
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
          </section>
        )}
        {snapshot && (
          <details key={selected} className={styles.sessionInfo}>
            <summary>Session 資訊</summary>
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
          </details>
        )}
        {snapshot && (snapshot.lastError || notices.length > 0) && (
          <section className={styles.sessionNotices} aria-label="Session 提示">
            {snapshot.lastError && (
              <p role="alert">Runtime 錯誤：{snapshot.lastError}</p>
            )}
            {notices.map((notice, index) => (
              <p role="status" key={`${index}-${notice}`}>
                {notice}
              </p>
            ))}
          </section>
        )}
        <section aria-label="對話訊息" className={styles.chatViewport}>
          <section
            ref={chatRef}
            className={styles.chat}
            onScroll={(event) => {
              const element = event.currentTarget;
              pinned.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <=
                48;
              setIsPinned(pinned.current);
            }}
          >
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
                <div ref={chatContentRef} className={styles.chatContent}>
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
                                confirm(
                                  "將內容加入目前草稿？原草稿會保留在前面。",
                                )
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
                </div>
              </>
            )}
          </section>
          {selected && snapshot && !isPinned && (
            <button
              className={`${styles.older} ${styles.backToLatest}`}
              onClick={() => {
                pinned.current = true;
                setIsPinned(true);
                if (chatRef.current)
                  chatRef.current.scrollTop = chatRef.current.scrollHeight;
              }}
            >
              回到最新
            </button>
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
                    !e.nativeEvent.isComposing &&
                    canSend("prompt", drafts[selected] ?? "")
                  ) {
                    e.preventDefault();
                    void submit("prompt");
                  }
                }}
                placeholder="輸入訊息；Ctrl/Cmd + Enter 僅送出 Prompt"
              />
              <button
                disabled={!canSend("prompt", drafts[selected] ?? "")}
                onClick={() => void submit("prompt")}
              >
                Prompt
              </button>
              <button
                disabled={!canSend("steer", drafts[selected] ?? "")}
                onClick={() => void submit("steer")}
              >
                Steering
              </button>
              <button
                disabled={!canSend("follow_up", drafts[selected] ?? "")}
                onClick={() => void submit("follow_up")}
              >
                Follow-up
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
