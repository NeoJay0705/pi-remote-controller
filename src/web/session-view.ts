export const SESSION_VIEW_KEY = "prw-session-view-v1";
const MAX_SERIALIZED_LENGTH = 2048;
const MAX_ID_LENGTH = 256;

export type SessionView = {
  version: 1;
  projectId: string;
  sessionId?: string;
};

type SessionViewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function browserStorage(): SessionViewStorage {
  return window.sessionStorage;
}

export function parseSessionView(raw: string | null): SessionView | undefined {
  if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !validId(data.projectId)) return undefined;
    if (data.sessionId !== undefined && !validId(data.sessionId))
      return undefined;
    return {
      version: 1,
      projectId: data.projectId,
      ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function readSessionView(
  storage?: Pick<SessionViewStorage, "getItem">,
): SessionView | undefined {
  try {
    return parseSessionView(
      (storage ?? browserStorage()).getItem(SESSION_VIEW_KEY),
    );
  } catch {
    return undefined;
  }
}

export function writeSessionView(
  view: SessionView,
  storage?: Pick<SessionViewStorage, "setItem">,
): void {
  try {
    if (
      !validId(view.projectId) ||
      (view.sessionId !== undefined && !validId(view.sessionId))
    )
      return;
    const projected: SessionView = {
      version: 1,
      projectId: view.projectId,
      ...(view.sessionId ? { sessionId: view.sessionId } : {}),
    };
    (storage ?? browserStorage()).setItem(
      SESSION_VIEW_KEY,
      JSON.stringify(projected),
    );
  } catch {
    /* Storage may be disabled or full. */
  }
}

export function clearSessionView(
  storage?: Pick<SessionViewStorage, "removeItem">,
): void {
  try {
    (storage ?? browserStorage()).removeItem(SESSION_VIEW_KEY);
  } catch {
    /* Storage may be disabled. */
  }
}

export function resolveSessionView(
  saved: SessionView | undefined,
  projects: Array<{ id: string }>,
  sessions: Array<{ id: string; projectId: string }>,
  defaultProjectId: string,
): { projectId: string; sessionId?: string } {
  const projectIds = new Set(projects.map((project) => project.id));
  if (saved?.sessionId) {
    const session = sessions.find(
      (candidate) => candidate.id === saved.sessionId,
    );
    if (session && projectIds.has(session.projectId))
      return { projectId: session.projectId, sessionId: session.id };
  }
  return {
    projectId:
      saved && projectIds.has(saved.projectId)
        ? saved.projectId
        : defaultProjectId,
  };
}
