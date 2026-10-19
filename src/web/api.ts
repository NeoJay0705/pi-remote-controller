import type {
  OperationInput,
  Profile,
  Project,
  Receipt,
  Snapshot,
  SessionNameInfo,
} from "../shared/contracts.js";
export type Session = {
  id: string;
  nativeId: string;
  projectId: string;
  profileId: string;
  profileRevision: number;
  nameInfo?: SessionNameInfo;
};
export type HistoryEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: unknown;
  summary?: string;
  truncated?: boolean;
};
export type HistoryPage = {
  entries: HistoryEntry[];
  nextBefore?: string;
  continuation?: string;
  incomplete: boolean;
  truncated: boolean;
  stats?: Record<string, unknown>;
};
export type NativeCandidate = {
  id?: string;
  file: string;
  error?: string;
  nameInfo?: SessionNameInfo;
};
export function mergeActiveHistory(
  old: HistoryEntry[],
  page: HistoryEntry[],
): HistoryEntry[] {
  if (!page.length) return [];
  const byId = new Map(old.map((entry) => [entry.id, entry]));
  const ancestors: HistoryEntry[] = [];
  let parent = page[0]?.parentId ?? null;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const entry = byId.get(parent);
    if (!entry) break;
    ancestors.push(entry);
    parent = entry.parentId;
  }
  ancestors.reverse();
  const result = new Map<string, HistoryEntry>();
  for (const entry of ancestors) result.set(entry.id, entry);
  for (const entry of page) result.set(entry.id, entry);
  return [...result.values()];
}
async function request<T>(
  path: string,
  init?: RequestInit,
  notifyAuthExpired = true,
): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401 && notifyAuthExpired)
    window.dispatchEvent(new Event("prw-auth-expired"));
  if (!response.ok) {
    let code = "";
    try {
      const body = (await response.clone().json()) as {
        error?: { code?: unknown };
      };
      if (typeof body.error?.code === "string") code = body.error.code;
    } catch {
      /* Ignore non-JSON error responses. */
    }
    const profileErrors: Record<string, string> = {
      profile_conflict: "已保存的 Profile 已變更。請重新同步後再確認。",
      session_busy: "Session 忙碌中。請等待工作完成後再套用。",
      writer_locked: "Session writer 目前由其他程序持有，無法套用 Profile。",
      session_profile_blocked:
        "Profile 切換結果尚未確認。請由管理者核對操作結果；重試不會解除阻擋。",
      profile_switch_unconfirmed:
        "Profile 切換結果尚未確認。請由管理者核對操作結果；重試不會解除阻擋。",
      rpc_profile_mismatch: "Pi 實際設定與目標 Profile 不符，切換未確認。",
      sync_unconfirmed: "Pi 狀態尚未確認。請由管理者核對後再操作。",
    };
    const message =
      response.status === 401
        ? "登入已逾期"
        : (profileErrors[code] ??
          (code === "invalid-record"
            ? "歷史讀取失敗（invalid-record）；讀取器無法處理部分紀錄。"
            : code === "compact_rejected"
              ? "Pi 未完成這次壓縮；已確認 session 閒置，可繼續操作。"
              : `請求失敗 (${response.status})`));
    throw Object.assign(new Error(message), { status: response.status, code });
  }
  return response.json() as Promise<T>;
}
export const api = {
  login: (token: string) =>
    request<{ authenticated: true }>("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  me: (notifyAuthExpired = true) =>
    request<{ authenticated: true }>(
      "/api/v1/auth/me",
      undefined,
      notifyAuthExpired,
    ),
  logout: () =>
    request<void>("/api/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  projects: () => request<Project[]>("/api/v1/projects"),
  profiles: () => request<Profile[]>("/api/v1/profiles"),
  sessions: () => request<Session[]>("/api/v1/sessions"),
  native: (project: string, signal?: AbortSignal) =>
    request<NativeCandidate[]>(
      `/api/v1/projects/${encodeURIComponent(project)}/native-sessions`,
      signal ? { signal } : {},
    ),
  create: (
    projectId: string,
    profileId: string,
    nativeFile?: string,
    name?: string,
  ) =>
    request<Session>("/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        profileId,
        ...(nativeFile ? { nativeFile } : {}),
        ...(!nativeFile && name !== undefined ? { name } : {}),
      }),
    }),
  snapshot: (id: string, signal?: AbortSignal) =>
    request<Snapshot>(
      `/api/v1/sessions/${encodeURIComponent(id)}/snapshot`,
      signal ? { signal } : {},
    ),
  history: (
    id: string,
    before?: string,
    signal?: AbortSignal,
    previewBytes?: number,
  ) => {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    if (previewBytes !== undefined)
      params.set(
        "previewBytes",
        String(Math.max(2048, Math.min(65536, previewBytes))),
      );
    return request<HistoryPage>(
      `/api/v1/sessions/${encodeURIComponent(id)}/history?${params.toString()}`,
      signal ? { signal } : {},
    );
  },
  operation: (id: string, body: OperationInput) =>
    request<Receipt>(`/api/v1/sessions/${encodeURIComponent(id)}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  receipt: (id: string) =>
    request<Receipt>(`/api/v1/operations/${encodeURIComponent(id)}`),
};
