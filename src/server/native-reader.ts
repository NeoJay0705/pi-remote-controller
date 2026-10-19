import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Project, SessionNameInfo } from "../shared/contracts.js";
import { parseBoundedJson } from "./bounded-json.js";
import type { NativeEntry } from "./native-sessions.js";

const BLOCK = 64 * 1024;
const HEADER_MAX = 64 * 1024;
const CURSOR_MAX = 8 * 1024;
const PAGE_RETAINED_BUDGET = Math.floor((1024 * 1024 - 8192) / 6);
const KEY = randomBytes(32);
type FileHandle = Awaited<ReturnType<typeof open>>;
export type SafeNativeError =
  | "unsafe-path"
  | "unsupported-file"
  | "invalid-header"
  | "native_cwd_mismatch"
  | "native_parent_missing"
  | "invalid-record"
  | "work-budget"
  | "reload-required";
export interface NativeMetadata {
  id: string;
  cwd: string;
  file: string;
  header: Record<string, unknown>;
  devino: string;
  headerhash: string;
  size: number;
}
export interface NativeTail {
  id: string | null;
  parentId: string | null;
  fingerprint: string;
}
export interface NativePage {
  entries: NativeEntry[];
  nextBefore?: string;
  continuation?: string;
  incomplete: boolean;
  truncated: boolean;
  stats: { bytesRead: number; records: number; retainedBytes?: number };
}
export interface NativeReaderOptions {
  maxReadBytes?: number;
  maxMs?: number;
  previewBytes?: number;
  expectedNativeId?: string;
  sharedBudget?: NameReadBudget;
  now?: () => number;
}
export interface NameReadBudget {
  bytes: number;
  maxBytes: number;
  deadline: number;
  now: () => number;
  exhausted: boolean;
}
interface Opened {
  fd: FileHandle;
  file: string;
  st: Awaited<ReturnType<FileHandle["stat"]>>;
  identity: string;
}

async function opened(file: string, project: Project): Promise<Opened> {
  if (!isAbsolute(file)) throw new Error("unsafe-path");
  const dir = await realpath(project.sessionDir),
    ds = await lstat(project.sessionDir);
  if (dir !== project.sessionDir || ds.isSymbolicLink())
    throw new Error("unsafe-path");
  const input = await lstat(file);
  if (input.isSymbolicLink()) throw new Error("unsafe-path");
  const canonical = await realpath(file),
    rel = relative(dir, canonical);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("unsafe-path");
  let fd: FileHandle;
  try {
    fd = await open(
      canonical,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (
      ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw new Error("permission-denied");
    throw error;
  }
  let st: Awaited<ReturnType<FileHandle["stat"]>>;
  try {
    st = await fd.stat();
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.dev !== input.dev ||
      st.ino !== input.ino
    )
      throw new Error("unsupported-file");
  } catch (error) {
    await fd.close();
    throw error;
  }
  return { fd, file: canonical, st, identity: `${st.dev}:${st.ino}` };
}
async function readAt(
  fd: FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  const b = Buffer.alloc(Math.max(0, length));
  let done = 0;
  while (done < length) {
    const r = await fd.read(b, done, length - done, start + done);
    if (!r.bytesRead) break;
    done += r.bytesRead;
  }
  return b.subarray(0, done);
}
async function inspectOpened(
  x: Opened,
  project: Project,
  budget?: Budget,
): Promise<NativeMetadata> {
  const after = await x.fd.stat();
  if (
    after.dev !== x.st.dev ||
    after.ino !== x.st.ino ||
    after.size < x.st.size
  )
    throw new Error("reload-required");
  const first = budget
      ? await budgetReadAt(
          x.fd,
          0,
          Math.min(HEADER_MAX + 1, after.size),
          budget,
        )
      : await readAt(x.fd, 0, Math.min(HEADER_MAX + 1, after.size)),
    lf = first.indexOf(10);
  if (lf < 0 || lf > HEADER_MAX) throw new Error("invalid-header");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(first.subarray(0, lf)),
    );
  } catch {
    throw new Error("invalid-header");
  }
  if (
    !header ||
    header.type !== "session" ||
    header.version !== 3 ||
    typeof header.id !== "string" ||
    !header.id ||
    header.id.length > 256 ||
    typeof header.cwd !== "string"
  )
    throw new Error("invalid-header");
  if (header.cwd !== project.cwd) throw new Error("native_cwd_mismatch");
  return {
    id: header.id,
    cwd: header.cwd,
    file: x.file,
    header,
    devino: x.identity,
    headerhash: createHash("sha256")
      .update(first.subarray(0, lf + 1))
      .digest("hex"),
    size: after.size,
  };
}
export async function inspectNative(
  file: string,
  project: Project,
): Promise<NativeMetadata> {
  const x = await opened(file, project);
  try {
    return await inspectOpened(x, project);
  } finally {
    await x.fd.close();
  }
}

export async function readNativeName(
  file: string,
  project: Project,
  options: NativeReaderOptions = {},
): Promise<SessionNameInfo> {
  const now = options.now ?? options.sharedBudget?.now ?? Date.now;
  const shared = options.sharedBudget ?? {
    bytes: 0,
    maxBytes: 2 * 1024 * 1024,
    deadline: now() + 250,
    now,
    exhausted: false,
  };
  const initialBytes = shared.bytes;
  const maxBytes = Math.min(shared.maxBytes, initialBytes + 2 * 1024 * 1024);
  const budget: Budget = {
    bytes: initialBytes,
    maxBytes,
    deadline: Math.min(shared.deadline, now() + 250),
    exhausted: false,
    now,
  };
  let x: Opened | undefined;
  try {
    if (
      shared.exhausted ||
      now() > budget.deadline ||
      budget.bytes >= budget.maxBytes
    ) {
      shared.exhausted = true;
      return { status: "incomplete" };
    }
    x = await opened(file, project);
    const before = x.st;
    const meta = await inspectOpened(x, project, budget);
    if (
      options.expectedNativeId !== undefined &&
      meta.id !== options.expectedNativeId
    )
      throw new Error("native_id_mismatch");
    let nameInfo: SessionNameInfo = { status: "unnamed" };
    for await (const [start, end] of reverseLines(
      x.fd,
      { end: meta.size, lineEnd: meta.size, skippingPartialTail: false },
      budget,
      true,
    )) {
      if (start === 0) continue;
      const parsed = await parseLine(
        x.fd,
        start,
        end,
        undefined,
        budget,
        16 * 1024,
      );
      if (parsed.value.type !== "session_info") continue;
      if (parsed.truncated) throw new Error("invalid-record");
      const rawName = parsed.value.name;
      if (rawName !== undefined && typeof rawName !== "string")
        throw new Error("invalid-record");
      if (
        typeof rawName === "string" &&
        Buffer.byteLength(rawName, "utf8") > 4096
      )
        throw new Error("invalid-record");
      const name = typeof rawName === "string" ? rawName.trim() : "";
      nameInfo = name ? { status: "named", name } : { status: "unnamed" };
      break;
    }
    if (budget.exhausted || now() > budget.deadline)
      throw new Error("work-budget");
    const after = await x.fd.stat();
    const path = await lstat(meta.file);
    const finalHeader = await budgetReadAt(
      x.fd,
      0,
      Math.min(HEADER_MAX + 1, after.size),
      budget,
    );
    const lf = finalHeader.indexOf(10);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      path.isSymbolicLink() ||
      path.dev !== before.dev ||
      path.ino !== before.ino ||
      path.nlink !== 1 ||
      lf < 0 ||
      createHash("sha256")
        .update(finalHeader.subarray(0, lf + 1))
        .digest("hex") !== meta.headerhash
    )
      throw new Error("reload-required");
    if (budget.bytes > budget.maxBytes || now() > budget.deadline)
      throw new Error("work-budget");
    shared.bytes = budget.bytes;
    return nameInfo;
  } catch (error) {
    shared.bytes = budget.bytes;
    shared.exhausted = shared.exhausted || budget.bytes >= shared.maxBytes;
    const code = (error as Error).message;
    if (code === "work-budget") {
      shared.exhausted =
        shared.bytes >= shared.maxBytes || now() > shared.deadline;
      return { status: "incomplete" };
    }
    if (code === "reload-required") return { status: "incomplete" };
    if (code === "native_id_mismatch")
      return { status: "error", code: "native_id_mismatch" };
    return {
      status: "error",
      code: [
        "unsafe-path",
        "unsupported-file",
        "permission-denied",
        "invalid-header",
        "native_cwd_mismatch",
        "invalid-record",
      ].includes(code)
        ? code
        : "invalid-record",
    };
  } finally {
    await x?.fd.close();
  }
}
interface Budget {
  bytes: number;
  maxBytes: number;
  deadline: number;
  exhausted: boolean;
  now?: () => number;
}
async function budgetReadAt(
  fd: FileHandle,
  start: number,
  length: number,
  budget: Budget,
): Promise<Buffer> {
  if (
    (budget.now?.() ?? Date.now()) > budget.deadline ||
    length > budget.maxBytes - budget.bytes
  ) {
    budget.exhausted = true;
    throw new Error("work-budget");
  }
  const result = await readAt(fd, start, length);
  budget.bytes += result.length;
  return result;
}
interface ScanState {
  end: number;
  lineEnd: number;
  skippingPartialTail: boolean;
}
async function* reverseLines(
  fd: FileHandle,
  scan: ScanState,
  budget: Budget,
  initializeTail = false,
): AsyncGenerator<[number, number]> {
  if (initializeTail && scan.end > 0) {
    if (
      budget.bytes >= budget.maxBytes ||
      (budget.now?.() ?? Date.now()) > budget.deadline
    ) {
      budget.exhausted = true;
      return;
    }
    const last = await readAt(fd, scan.end - 1, 1);
    budget.bytes += last.length;
    if (
      budget.bytes > budget.maxBytes ||
      (budget.now?.() ?? Date.now()) > budget.deadline
    ) {
      budget.exhausted = true;
      return;
    }
    if (last[0] !== 10) scan.skippingPartialTail = true;
    else scan.lineEnd = scan.end - 1;
  }
  while (scan.skippingPartialTail && scan.end > 0) {
    if (
      budget.bytes >= budget.maxBytes ||
      (budget.now?.() ?? Date.now()) > budget.deadline
    ) {
      budget.exhausted = true;
      return;
    }
    const remaining = budget.maxBytes - budget.bytes;
    const start = Math.max(0, scan.end - Math.min(BLOCK, remaining)),
      chunk = await readAt(fd, start, scan.end - start);
    budget.bytes += chunk.length;
    const lf = chunk.lastIndexOf(10);
    if (lf >= 0) {
      scan.lineEnd = start + lf;
      scan.end = scan.lineEnd;
      scan.skippingPartialTail = false;
    } else scan.end = start;
  }
  while (scan.end > 0) {
    if (
      budget.bytes >= budget.maxBytes ||
      (budget.now?.() ?? Date.now()) > budget.deadline
    ) {
      budget.exhausted = true;
      return;
    }
    const remaining = budget.maxBytes - budget.bytes;
    const start = Math.max(0, scan.end - Math.min(BLOCK, remaining)),
      chunk = await readAt(fd, start, scan.end - start);
    budget.bytes += chunk.length;
    let pos = chunk.length;
    while (pos > 0) {
      const lf = chunk.lastIndexOf(10, pos - 1);
      if (lf < 0) break;
      const absolute = start + lf,
        previousLineEnd = scan.lineEnd;
      scan.lineEnd = absolute;
      scan.end = absolute;
      if (previousLineEnd > absolute + 1) yield [absolute + 1, previousLineEnd];
      pos = lf;
    }
    scan.end = start;
  }
  if (scan.lineEnd > 0) yield [0, scan.lineEnd];
}
async function hashLine(
  fd: FileHandle,
  start: number,
  end: number,
  budget?: Budget,
): Promise<string> {
  const hash = createHash("sha256");
  for (let at = start; at < end;) {
    const length = Math.min(
      BLOCK,
      end - at,
      budget ? budget.maxBytes - budget.bytes : BLOCK,
    );
    if (
      length <= 0 ||
      (budget && (budget.now?.() ?? Date.now()) > budget.deadline)
    ) {
      budget!.exhausted = true;
      throw new Error("work-budget");
    }
    const chunk = await readAt(fd, at, length);
    if (!chunk.length) break;
    hash.update(chunk);
    at += chunk.length;
    if (budget) budget.bytes += chunk.byteLength;
  }
  return hash.digest("hex");
}
async function* countedRange(
  fd: FileHandle,
  start: number,
  end: number,
  budget?: Budget,
): AsyncGenerator<Uint8Array> {
  for (let at = start; at < end;) {
    const length = Math.min(
      BLOCK,
      end - at,
      budget ? budget.maxBytes - budget.bytes : BLOCK,
    );
    if (
      length <= 0 ||
      (budget && (budget.now?.() ?? Date.now()) > budget.deadline)
    ) {
      budget!.exhausted = true;
      throw new Error("work-budget");
    }
    const chunk = await readAt(fd, at, length);
    if (!chunk.length) break;
    if (budget) budget.bytes += chunk.byteLength;
    at += chunk.byteLength;
    yield chunk;
  }
}
async function parseLine(
  fd: FileHandle,
  start: number,
  end: number,
  previewBytes?: number,
  budget?: Budget,
  maxRetainedBytes?: number,
) {
  try {
    return await parseBoundedJson<NativeEntry>(
      countedRange(fd, start, end, budget),
      maxRetainedBytes,
      previewBytes === undefined ? {} : { previewBytes },
    );
  } catch (error) {
    if ((error as Error).message === "invalid_record")
      throw new Error("invalid-record");
    throw error;
  }
}
function fitEntryResponse(entry: NativeEntry): boolean {
  const candidates: Array<{
    parent: Record<string, unknown> | unknown[];
    key: string | number;
    value: string;
  }> = [];
  const visit = (
    value: unknown,
    parent?: Record<string, unknown> | unknown[],
    key?: string | number,
  ) => {
    if (
      typeof value === "string" &&
      parent !== undefined &&
      key !== undefined
    ) {
      if (!["id", "parentId", "type"].includes(String(key)))
        candidates.push({ parent, key, value });
      return;
    }
    if (Array.isArray(value))
      value.forEach((child, i) => visit(child, value, i));
    else if (value && typeof value === "object")
      for (const [childKey, child] of Object.entries(value))
        visit(child, value as Record<string, unknown>, childKey);
  };
  visit(entry);
  while (
    Buffer.byteLength(JSON.stringify(entry), "utf8") + 16 * 1024 >
    1024 * 1024
  ) {
    candidates.sort((a, b) => b.value.length - a.value.length);
    const candidate = candidates.find((item) => item.value.length > 0);
    if (!candidate) return false;
    const shortened = [...candidate.value]
      .slice(0, Math.floor([...candidate.value].length / 2))
      .join("");
    if (Array.isArray(candidate.parent))
      candidate.parent[Number(candidate.key)] = shortened;
    else candidate.parent[String(candidate.key)] = shortened;
    candidate.value = shortened;
    entry.truncated = true;
  }
  return true;
}
interface Cursor {
  v: 1;
  scope: string;
  identity: string;
  headerhash: string;
  size: number;
  leaf: string | null;
  leafhash: string;
  leafposition: number;
  target: string | null;
  position: number;
  scanstate: ScanState;
  scanning: boolean;
}
function cursorEncode(data: Cursor): string {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url"),
    sig = createHmac("sha256", KEY).update(body).digest("base64url");
  const result = `${body}.${sig}`;
  if (result.length > CURSOR_MAX) throw new Error("reload-required");
  return result;
}
function cursorDecode(value: string): Cursor {
  if (typeof value !== "string" || value.length > CURSOR_MAX)
    throw new Error("reload-required");
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error("reload-required");
  let body: Buffer, got: Buffer;
  try {
    body = Buffer.from(parts[0], "base64url");
    got = Buffer.from(parts[1], "base64url");
  } catch {
    throw new Error("reload-required");
  }
  const expected = createHmac("sha256", KEY).update(parts[0]).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected))
    throw new Error("reload-required");
  try {
    const v = JSON.parse(body.toString("utf8"));
    if (
      !v ||
      Object.keys(v).sort().join(",") !==
        "headerhash,identity,leaf,leafhash,leafposition,position,scanning,scanstate,scope,size,target,v" ||
      v.v !== 1 ||
      typeof v.scope !== "string" ||
      typeof v.identity !== "string" ||
      typeof v.headerhash !== "string" ||
      !(v.leaf === null || typeof v.leaf === "string") ||
      typeof v.leafhash !== "string" ||
      !(v.target === null || typeof v.target === "string") ||
      typeof v.scanning !== "boolean" ||
      !Number.isSafeInteger(v.size) ||
      v.size < 0 ||
      !Number.isSafeInteger(v.position) ||
      v.position < 0 ||
      v.position > v.size ||
      !Number.isSafeInteger(v.leafposition) ||
      v.leafposition < 0 ||
      v.leafposition > v.size ||
      !v.scanstate ||
      Object.keys(v.scanstate).sort().join(",") !==
        "end,lineEnd,skippingPartialTail" ||
      !Number.isSafeInteger(v.scanstate.end) ||
      v.scanstate.end < 0 ||
      v.scanstate.end > v.size ||
      !Number.isSafeInteger(v.scanstate.lineEnd) ||
      v.scanstate.lineEnd < 0 ||
      v.scanstate.lineEnd > v.size ||
      typeof v.scanstate.skippingPartialTail !== "boolean"
    )
      throw new Error();
    return v as Cursor;
  } catch {
    throw new Error("reload-required");
  }
}
async function validateSnapshot(
  x: Opened,
  meta: NativeMetadata,
  tail: NativeTail & { start: number; end: number },
): Promise<void> {
  const pathStat = await lstat(meta.file);
  const fdStat = await x.fd.stat();
  if (
    pathStat.isSymbolicLink() ||
    pathStat.dev !== x.st.dev ||
    pathStat.ino !== x.st.ino ||
    x.identity !== meta.devino ||
    pathStat.nlink !== 1 ||
    fdStat.dev !== x.st.dev ||
    fdStat.ino !== x.st.ino ||
    fdStat.nlink !== 1 ||
    fdStat.size < meta.size
  )
    throw new Error("reload-required");
  const first = await readAt(x.fd, 0, Math.min(HEADER_MAX + 1, fdStat.size));
  const lf = first.indexOf(10);
  if (
    lf < 0 ||
    createHash("sha256")
      .update(first.subarray(0, lf + 1))
      .digest("hex") !== meta.headerhash
  )
    throw new Error("reload-required");
  if (
    (tail.id === null &&
      (await hashLine(x.fd, 0, tail.end)) !== tail.fingerprint) ||
    (tail.start > 0 &&
      (await hashLine(x.fd, tail.start, tail.end)) !== tail.fingerprint)
  )
    throw new Error("reload-required");
}
async function getTail(
  fd: FileHandle,
  size: number,
  meta: NativeMetadata,
  budget: Budget,
): Promise<NativeTail & { start: number; end: number }> {
  for await (const [start, end] of reverseLines(
    fd,
    { end: size, lineEnd: size, skippingPartialTail: false },
    budget,
    true,
  )) {
    if (start === 0) continue;
    const parsed = await parseLine(fd, start, end, undefined, budget);
    if (typeof parsed.value.id === "string")
      return {
        id: parsed.value.id,
        parentId:
          typeof parsed.value.parentId === "string"
            ? parsed.value.parentId
            : null,
        fingerprint: await hashLine(fd, start, end, budget),
        start,
        end,
      };
  }
  if (budget.exhausted) throw new Error("work-budget");
  return {
    id: null,
    parentId: null,
    fingerprint: await hashLine(fd, 0, size, budget),
    start: 0,
    end: size,
  };
}
export async function readNativeTail(
  file: string,
  project: Project,
  options: NativeReaderOptions = {},
): Promise<NativeTail> {
  const x = await opened(file, project);
  try {
    const meta = await inspectOpened(x, project);
    if (
      options.expectedNativeId !== undefined &&
      meta.id !== options.expectedNativeId
    )
      throw new Error("reload-required");
    const budget: Budget = {
      bytes: 0,
      maxBytes: options.maxReadBytes ?? 256 * 1024 * 1024,
      deadline: Date.now() + (options.maxMs ?? 30_000),
      exhausted: false,
    };
    const tail = await getTail(x.fd, meta.size, meta, budget);
    await validateSnapshot(x, meta, tail);
    return {
      id: tail.id,
      parentId: tail.parentId,
      fingerprint: tail.fingerprint,
    };
  } finally {
    await x.fd.close();
  }
}
export async function readNativePage(
  file: string,
  project: Project,
  before?: string,
  limit = 100,
  options: NativeReaderOptions = {},
): Promise<NativePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_history_query");
  if (
    options.previewBytes !== undefined &&
    (!Number.isInteger(options.previewBytes) ||
      options.previewBytes < 2 * 1024 ||
      options.previewBytes > 64 * 1024)
  )
    throw new Error("invalid_history_query");
  const x = await opened(file, project);
  try {
    const meta = await inspectOpened(x, project);
    if (
      options.expectedNativeId !== undefined &&
      meta.id !== options.expectedNativeId
    )
      throw new Error("reload-required");
    const scope = createHash("sha256").update(meta.file).digest("hex");
    const preflight: Budget = {
        bytes: 0,
        maxBytes: 256 * 1024 * 1024,
        deadline: Date.now() + 30_000,
        exhausted: false,
      },
      budget: Budget = {
        bytes: 0,
        maxBytes: options.maxReadBytes ?? 256 * 1024 * 1024,
        deadline: Date.now() + (options.maxMs ?? 30_000),
        exhausted: false,
      };
    const cursor = before ? cursorDecode(before) : undefined;
    if (
      cursor &&
      (cursor.scope !== scope ||
        cursor.identity !== meta.devino ||
        cursor.headerhash !== meta.headerhash ||
        meta.size < cursor.size)
    )
      throw new Error("reload-required");
    const tail = await getTail(x.fd, meta.size, meta, preflight);
    if (cursor && cursor.leaf) {
      let expected: string | null = tail.id,
        proven = false;
      for await (const [s, e] of reverseLines(
        x.fd,
        { end: meta.size, lineEnd: meta.size, skippingPartialTail: false },
        preflight,
        true,
      )) {
        if (s === 0) continue;
        const p = await parseLine(x.fd, s, e, undefined, preflight);
        if (p.value.id === expected && expected !== null) {
          if (expected === cursor.leaf) {
            if ((await hashLine(x.fd, s, e, preflight)) !== cursor.leafhash)
              throw new Error("reload-required");
            proven = true;
            break;
          }
          expected =
            typeof p.value.parentId === "string" ? p.value.parentId : null;
          if (expected === null) break;
        }
        if (preflight.exhausted) break;
      }
      if (preflight.exhausted) throw new Error("work-budget");
      if (!proven) throw new Error("reload-required");
    }
    const scanstate = cursor?.scanstate ?? {
      end: meta.size,
      lineEnd: meta.size,
      skippingPartialTail: false,
    };
    let expected: string | null = cursor ? cursor.target : tail.id;
    const entries: NativeEntry[] = [];
    let truncated = false,
      retainedBytes = 0,
      serializedBytes = 0,
      earliest = scanstate.end;
    if (tail.id === null && !cursor) {
      await validateSnapshot(x, meta, tail);
      return {
        entries: [],
        incomplete: false,
        truncated: false,
        stats: {
          bytesRead: budget.bytes + preflight.bytes,
          records: 0,
          retainedBytes: 0,
        },
      };
    }
    for await (const [start, end] of reverseLines(
      x.fd,
      scanstate,
      budget,
      !cursor,
    )) {
      if (start === 0) {
        if (expected !== null) throw new Error("native_parent_missing");
        break;
      }
      earliest = start;
      const spanEnd = end;
      if (end - start > budget.maxBytes) throw new Error("work-budget");
      if (
        end - start > budget.maxBytes - budget.bytes ||
        Date.now() > budget.deadline
      ) {
        Object.assign(scanstate, {
          end: spanEnd,
          lineEnd: spanEnd,
          skippingPartialTail: false,
        });
        budget.exhausted = true;
        break;
      }
      let projected;
      try {
        projected = await parseLine(
          x.fd,
          start,
          end,
          options.previewBytes,
          budget,
          PAGE_RETAINED_BUDGET,
        );
      } catch (e) {
        if ((e as Error).message === "invalid_record")
          throw new Error("invalid-record");
        if ((e as Error).message === "work-budget") {
          Object.assign(scanstate, {
            end: spanEnd,
            lineEnd: spanEnd,
            skippingPartialTail: false,
          });
          budget.exhausted = true;
          break;
        }
        throw e;
      }
      const row = projected.value;
      if (
        !row ||
        typeof row.id !== "string" ||
        !(row.parentId === null || typeof row.parentId === "string")
      )
        throw new Error("invalid-record");
      if (expected !== null && row.id === expected) {
        if (projected.truncated) row.truncated = true;
        if (serializedBytes === 0 && !fitEntryResponse(row))
          throw new Error("reload-required");
        const projectedBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
        if (
          (entries.length > 0 &&
            retainedBytes + projected.retainedBytes > PAGE_RETAINED_BUDGET) ||
          projectedBytes + serializedBytes + 16 * 1024 > 1024 * 1024
        ) {
          Object.assign(scanstate, {
            end: spanEnd,
            lineEnd: spanEnd,
            skippingPartialTail: false,
          });
          budget.exhausted = true;
          break;
        }
        entries.push(row);
        truncated ||= row.truncated === true;
        retainedBytes += projected.retainedBytes;
        serializedBytes += projectedBytes;
        expected = row.parentId as string | null;
        if (
          entries.length >= limit ||
          retainedBytes >= PAGE_RETAINED_BUDGET ||
          expected === null
        )
          break;
      }
      if (budget.exhausted) break;
    }
    if (budget.exhausted) {
      await validateSnapshot(x, meta, tail);
      const page: NativePage = {
        entries: entries.reverse(),
        continuation: cursorEncode({
          v: 1,
          scope,
          identity: meta.devino,
          headerhash: meta.headerhash,
          size: meta.size,
          leaf: cursor?.leaf ?? tail.id,
          leafhash: cursor?.leafhash ?? tail.fingerprint,
          leafposition: cursor?.leafposition ?? tail.start,
          target: expected,
          position: scanstate.end,
          scanstate: { ...scanstate },
          scanning: true,
        }),
        incomplete: true,
        truncated,
        stats: {
          bytesRead: budget.bytes + preflight.bytes,
          records: entries.length,
          retainedBytes,
        },
      };
      if (Buffer.byteLength(JSON.stringify(page), "utf8") > 1024 * 1024)
        throw new Error("reload-required");
      return page;
    }
    if (expected !== null && earliest === 0)
      throw new Error("native_parent_missing");
    await validateSnapshot(x, meta, tail);
    const nextBefore =
      expected !== null && entries.length
        ? cursorEncode({
            v: 1,
            scope,
            identity: meta.devino,
            headerhash: meta.headerhash,
            size: meta.size,
            leaf: cursor?.leaf ?? tail.id,
            leafhash: cursor?.leafhash ?? tail.fingerprint,
            leafposition: cursor?.leafposition ?? tail.start,
            target: expected,
            position: scanstate.end,
            scanstate: { ...scanstate },
            scanning: false,
          })
        : undefined;
    const page: NativePage = {
      entries: entries.reverse(),
      ...(nextBefore ? { nextBefore } : {}),
      incomplete: false,
      truncated,
      stats: {
        bytesRead: budget.bytes + preflight.bytes,
        records: entries.length,
        retainedBytes,
      },
    };
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > 1024 * 1024)
      throw new Error("reload-required");
    return page;
  } finally {
    await x.fd.close();
  }
}
