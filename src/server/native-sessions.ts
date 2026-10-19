import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { open, realpath, lstat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Project, SessionNameInfo } from "../shared/contracts.js";
import { normalizeSessionName } from "../shared/session-names.js";
import { inspectNative, readNativeName } from "./native-reader.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LIST = 10000;
export interface NativeEntry {
  type: string;
  [key: string]: unknown;
}
export interface NativeData {
  id: string;
  cwd: string;
  file: string;
  entries: NativeEntry[];
  syncing: boolean;
}
export async function createNative(
  project: Project,
  requestedName?: string,
): Promise<{ file: string; id: string; nameInfo: SessionNameInfo }> {
  const validated =
    requestedName === undefined
      ? { ok: true as const }
      : normalizeSessionName(requestedName);
  if (!validated.ok) throw new Error("invalid_session_name");
  const name = validated.name;
  const id = randomUUID();
  try {
    if ((await lstat(project.sessionDir)).isSymbolicLink())
      throw new Error("invalid_session_dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(project.sessionDir, { recursive: true, mode: 0o700 });
  const dir = await realpath(project.sessionDir);
  if (
    dir !== project.sessionDir ||
    (await lstat(project.sessionDir)).isSymbolicLink()
  )
    throw new Error("invalid_session_dir");
  const file = join(dir, `${Date.now()}-${id}.jsonl`);
  const timestamp = new Date().toISOString();
  const header =
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd: project.cwd,
    }) +
    "\n" +
    (name
      ? JSON.stringify({
          type: "session_info",
          id: randomUUID(),
          parentId: null,
          timestamp,
          name,
        }) + "\n"
      : "");
  const h = await open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await h.writeFile(header, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  return {
    file,
    id,
    nameInfo: name ? { status: "named", name } : { status: "unnamed" },
  };
}
export async function validateNative(
  fileInput: string,
  project: Project,
): Promise<NativeData> {
  if (!isAbsolute(fileInput)) throw new Error("invalid_native_path");
  const dir = await realpath(project.sessionDir);
  if (
    dir !== project.sessionDir ||
    (await lstat(project.sessionDir)).isSymbolicLink()
  )
    throw new Error("invalid_session_dir");
  const originalStat = await lstat(fileInput);
  if (originalStat.isSymbolicLink()) throw new Error("invalid_native_file");
  const file = await realpath(fileInput);
  const rel = relative(dir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("native_path_forbidden");
  const st = await lstat(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.size > MAX_BYTES
  )
    throw new Error("invalid_native_file");
  const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await h.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== st.dev ||
      opened.ino !== st.ino ||
      opened.size !== st.size ||
      opened.size > MAX_BYTES
    )
      throw new Error("native_file_changed");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await h.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES || total !== opened.size)
      throw new Error("invalid_native_file");
    const bytes = buffer.subarray(0, total);
    const lastLf = bytes.lastIndexOf(0x0a);
    const syncing = lastLf !== bytes.length - 1;
    const complete = bytes.subarray(0, lastLf + 1);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0))
      throw new Error("invalid_native_history");
    const all: NativeEntry[] = lines.map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("invalid_native_history");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid_native_history");
      return value as NativeEntry;
    });
    const header = all[0];
    if (
      !header ||
      header.type !== "session" ||
      header.version !== 3 ||
      typeof header.id !== "string" ||
      !header.id ||
      typeof header.cwd !== "string"
    )
      throw new Error("invalid_native_header");
    if (header.cwd !== project.cwd) throw new Error("native_cwd_mismatch");
    const byId = new Map<string, NativeEntry>();
    for (const entry of all.slice(1)) {
      if (
        typeof entry.id !== "string" ||
        !entry.id ||
        !(entry.parentId === null || typeof entry.parentId === "string")
      )
        throw new Error("invalid_native_history");
      if (byId.has(entry.id)) throw new Error("invalid_native_history");
      byId.set(entry.id, entry);
    }
    const leaf = all.at(-1);
    const chain: NativeEntry[] = [];
    if (leaf && leaf !== header) {
      let current: NativeEntry | undefined = leaf;
      const seen = new Set<string>();
      while (current) {
        const id = current.id as string;
        if (seen.has(id)) throw new Error("invalid_native_history");
        seen.add(id);
        chain.push(current);
        const parent = current.parentId;
        if (parent === null) break;
        current = byId.get(parent as string);
        if (!current) throw new Error("native_parent_missing");
      }
      chain.reverse();
      // A non-null parent chain must terminate at a root entry.
      if (chain[0]?.parentId !== null) throw new Error("native_parent_missing");
    }
    return {
      id: header.id,
      cwd: header.cwd,
      file,
      entries: [header, ...chain],
      syncing,
    };
  } finally {
    await h.close();
  }
}
export interface NativeCandidate {
  file: string;
  id?: string;
  error?: string;
  nameInfo?: SessionNameInfo;
}
export interface NativeListOptions {
  maxBytes?: number;
  maxMs?: number;
  now?: () => number;
}
export async function listNative(
  project: Project,
  options: NativeListOptions = {},
): Promise<NativeCandidate[]> {
  let names: string[];
  try {
    names = await readdir(project.sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_LIST) throw new Error("session_directory_too_large");
  const files: NativeCandidate[] = [];
  const budget = {
    bytes: 0,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    deadline: (options.now?.() ?? Date.now()) + (options.maxMs ?? 1000),
    now: options.now ?? Date.now,
    exhausted: false,
  };
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = resolve(project.sessionDir, name);
    try {
      const v = await inspectNative(file, project);
      const nameInfo =
        budget.exhausted ||
        budget.bytes >= budget.maxBytes ||
        budget.now() > budget.deadline
          ? { status: "incomplete" as const }
          : await readNativeName(file, project, {
              sharedBudget: budget,
              expectedNativeId: v.id,
            });
      files.push({ file: v.file, id: v.id, nameInfo });
    } catch (error) {
      const code = (error as Error)?.message;
      files.push({
        file,
        error: [
          "unsafe-path",
          "unsupported-file",
          "invalid-header",
          "native_cwd_mismatch",
          "permission-denied",
        ].includes(code)
          ? code
          : "invalid-record",
      });
    }
  }
  return files;
}
export function historyPage(
  data: NativeData,
  before?: string,
  limit = 100,
): { entries: NativeEntry[]; nextBefore?: string } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_history_query");
  if (
    before !== undefined &&
    (!before || !data.entries.some((e) => e.id === before))
  )
    throw new Error("invalid_history_query");
  const end = before
    ? data.entries.findIndex((e) => e.id === before)
    : data.entries.length;
  const start = Math.max(1, end - limit);
  const entries = data.entries.slice(start, end);
  return {
    entries,
    ...(start > 1 && entries[0]?.id
      ? { nextBefore: String(entries[0].id) }
      : {}),
  };
}
