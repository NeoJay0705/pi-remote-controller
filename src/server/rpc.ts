import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { Profile, Project } from "../shared/contracts.js";
import type { WriterLease } from "./lease.js";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_QUEUE = 1024 * 1024;
const EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
  "extension_error",
  "extension_ui_request",
  "extension_ui_notification",
  "state",
]);

export class RpcError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(code);
  }
}
type Pending = {
  command: string;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  frame?: Frame;
};
type Frame = {
  bytes: Buffer;
  id?: number;
  reject: (error: Error) => void;
  resolve?: () => void;
  timer: NodeJS.Timeout;
  state: "queued" | "written" | "finished";
  drain?: () => void;
};
export class PiRpc extends EventEmitter {
  readonly child: ChildProcess;
  readonly closePromise: Promise<number | null>;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tombstones = new Set<number>();
  private queue: Frame[] = [];
  private queuedBytes = 0;
  private writing = false;
  private activeFrame: Frame | undefined;
  private failed?: RpcError;
  private stderrBytes = 0;
  private closing?: Promise<void>;
  private closeRequested = false;
  private closeResolve!: (code: number | null) => void;
  private readonly pgid?: number;
  constructor(
    piCli: string,
    sessionFile: string,
    project: Project,
    profile: Profile,
    lease: WriterLease,
  ) {
    super();
    this.child = spawn(
      process.execPath,
      [
        piCli,
        "--mode",
        "rpc",
        "--session",
        sessionFile,
        ...profileArgs(profile),
      ],
      {
        cwd: project.cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", lease.fd],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "PRW_OWNER_TOKEN"),
        ),
      },
    );
    if (this.child.pid && this.child.pid > 1) this.pgid = this.child.pid;
    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stdout?.on("error", () =>
      this.fail(new RpcError("rpc_stdout_error", true)),
    );
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes = Math.min(65536, this.stderrBytes + chunk.length);
    });
    this.child.stdin?.on("error", () =>
      this.fail(new RpcError("rpc_stdin_error", this.queue.length > 0)),
    );
    this.child.on("error", () =>
      this.fail(new RpcError("rpc_process_error", true)),
    );
    this.child.once("close", (code) => {
      this.fail(new RpcError("rpc_closed", true));
      this.closeResolve(code);
    });
  }
  private onData(chunk: Buffer): void {
    if (this.failed) {
      this.buffer = Buffer.alloc(0);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(0x0a)) >= 0) {
      const raw = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (raw.length > MAX_FRAME)
        return this.fail(new RpcError("rpc_frame_too_large", true));
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      let value: unknown;
      try {
        value = JSON.parse(this.decoder.decode(line));
      } catch {
        return this.fail(new RpcError("rpc_protocol_error", true));
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        return this.fail(new RpcError("rpc_protocol_error", true));
      this.onMessage(value as Record<string, unknown>);
      if (this.failed) return;
    }
    if (this.buffer.length > MAX_FRAME)
      this.fail(new RpcError("rpc_frame_too_large", true));
  }
  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === "response") {
      if (
        typeof msg.id !== "string" ||
        !/^\d+$/.test(msg.id) ||
        typeof msg.command !== "string" ||
        typeof msg.success !== "boolean"
      )
        return this.fail(new RpcError("rpc_protocol_error", true));
      const id = Number(msg.id),
        p = this.pending.get(id);
      if (!p) {
        if (this.tombstones.has(id)) return;
        return this.fail(new RpcError("rpc_protocol_error", true));
      }
      if (p.command !== msg.command)
        return this.fail(new RpcError("rpc_protocol_error", true));
      if (
        msg.command === "prompt" &&
        msg.success &&
        msg.data &&
        typeof msg.data === "object"
      ) {
        const disposition = (msg.data as Record<string, unknown>).disposition;
        if (
          disposition !== undefined &&
          !["started", "queued", "handled"].includes(String(disposition))
        )
          return this.fail(new RpcError("rpc_protocol_error", true));
      }
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (msg.success) p.resolve(msg);
      else p.reject(new RpcError("rpc_command_rejected", false));
      return;
    }
    if (typeof msg.type !== "string" || !EVENTS.has(msg.type))
      return this.fail(new RpcError("rpc_protocol_error", true));
    if (
      msg.type === "queue_update" &&
      (!Array.isArray(msg.steering) ||
        !msg.steering.every((x) => typeof x === "string") ||
        !Array.isArray(msg.followUp) ||
        !msg.followUp.every((x) => typeof x === "string") ||
        (msg.pendingMessageCount !== undefined &&
          (!Number.isInteger(msg.pendingMessageCount) ||
            (msg.pendingMessageCount as number) < 0)))
    )
      return this.fail(new RpcError("rpc_protocol_error", true));
    if (
      msg.type === "agent_settled" &&
      msg.aborted !== undefined &&
      typeof msg.aborted !== "boolean"
    )
      return this.fail(new RpcError("rpc_protocol_error", true));
    this.emit("event", msg);
  }
  private fail(error: RpcError): void {
    if (this.failed) return;
    this.failed = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const f of this.queue.splice(0)) {
      clearTimeout(f.timer);
      f.state = "finished";
      f.reject(error);
    }
    this.queuedBytes = 0;
    if (this.activeFrame) {
      clearTimeout(this.activeFrame.timer);
      if (this.activeFrame.drain)
        this.child.stdin?.off("drain", this.activeFrame.drain);
      this.activeFrame.state = "finished";
      this.activeFrame.reject(error);
      this.activeFrame = undefined;
    }
    this.writing = false;
    this.emit("failure", error.code);
  }
  private enqueue(
    bytes: Buffer,
    id: number | undefined,
    timeout: number,
  ): Promise<void> {
    const stdin = this.child.stdin;
    if (this.failed) return Promise.reject(this.failed);
    if (!stdin?.writable)
      return Promise.reject(new RpcError("rpc_closed", false));
    if (bytes.length > MAX_FRAME)
      return Promise.reject(new RpcError("rpc_command_too_large", false));
    if (this.queuedBytes + bytes.length > MAX_QUEUE)
      return Promise.reject(new RpcError("rpc_write_queue_full", false));
    return new Promise((resolve, reject) => {
      const frame: Frame = {
        bytes,
        ...(id !== undefined ? { id } : {}),
        resolve,
        reject,
        state: "queued",
        timer: setTimeout(() => this.expireFrame(frame), timeout),
      };
      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (pending) pending.frame = frame;
      }
      this.queue.push(frame);
      this.queuedBytes += bytes.length;
      this.pump();
    });
  }
  private pump(): void {
    if (this.writing || this.failed || this.closeRequested) return;
    const frame = this.queue.shift();
    if (!frame) return;
    this.queuedBytes -= frame.bytes.length;
    frame.state = "written";
    this.writing = true;
    this.activeFrame = frame;
    let ok: boolean;
    try {
      ok = this.child.stdin!.write(frame.bytes);
    } catch {
      this.writing = false;
      frame.reject(new RpcError("rpc_stdin_error", false));
      this.fail(new RpcError("rpc_stdin_error", true));
      return;
    }
    const done = () => {
      if (!this.writing) return;
      this.writing = false;
      this.activeFrame = undefined;
      frame.state = "finished";
      clearTimeout(frame.timer);
      frame.resolve?.();
      this.pump();
    };
    if (ok) done();
    else {
      frame.drain = done;
      this.child.stdin!.once("drain", done);
    }
  }
  command(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<Record<string, unknown>> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    const line = Buffer.from(
      JSON.stringify({ ...params, id: String(id), type: command }) + "\n",
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        const uncertain = p?.frame ? p.frame.state !== "queued" : true;
        if (p?.frame) this.expireFrame(p.frame);
        if (uncertain) this.tombstones.add(id);
        reject(new RpcError("rpc_timeout", uncertain));
        if (uncertain) this.emit("failure", "rpc_timeout");
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      void this.enqueue(line, id, timeoutMs)
        .then(() => undefined)
        .catch((e: Error) => {
          const p = this.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            reject(e);
          }
        });
    });
  }
  private expireFrame(frame: Frame): void {
    clearTimeout(frame.timer);
    const i = this.queue.indexOf(frame);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.queuedBytes -= frame.bytes.length;
      frame.state = "finished";
      frame.reject(new RpcError("rpc_timeout", false));
    } else if (frame.state !== "finished") {
      frame.state = "finished";
      if (frame.id !== undefined) this.tombstones.add(frame.id);
      frame.reject(new RpcError("rpc_timeout", true));
      this.emit("failure", "rpc_timeout");
    }
  }
  async respondUI(
    dialogID: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const line = Buffer.from(
      JSON.stringify({
        ...response,
        id: dialogID,
        type: "extension_ui_response",
      }) + "\n",
    );
    await this.enqueue(line, undefined, 10000);
  }
  async close(timeout = 5000): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeImpl(timeout);
    return this.closing;
  }
  private async closeImpl(timeout: number): Promise<void> {
    this.closeRequested = true;
    const closingError = new RpcError("rpc_closed", false);
    for (const frame of this.queue.splice(0)) {
      clearTimeout(frame.timer);
      frame.reject(closingError);
    }
    this.queuedBytes = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closingError);
    }
    this.pending.clear();
    const stdin = this.child.stdin;
    const writeDeadline = Date.now() + timeout;
    while (this.writing && Date.now() < writeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (stdin && !stdin.destroyed && stdin.writable) stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.closePromise.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    let groupAlive = await this.hasLiveGroup();
    if ((!exited || groupAlive) && this.pgid) {
      this.signalGroup("SIGTERM");
      await this.waitGroup(timeout);
      groupAlive = await this.hasLiveGroup();
      if (groupAlive) {
        this.signalGroup("SIGKILL");
        await this.waitGroup(timeout);
      }
    }
    let finalTimer: NodeJS.Timeout | undefined;
    const childDone = await Promise.race([
      this.closePromise.then(() => true),
      new Promise<boolean>((r) => {
        finalTimer = setTimeout(() => r(false), timeout);
      }),
    ]);
    if (finalTimer) clearTimeout(finalTimer);
    groupAlive = await this.hasLiveGroup();
    if (!childDone || groupAlive)
      throw new RpcError("cleanup_incomplete", true);
  }
  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pgid && this.pgid > 1) {
      try {
        process.kill(-this.pgid, signal);
      } catch {
        /* already gone */
      }
    }
  }
  private async waitGroup(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && (await this.hasLiveGroup()))
      await new Promise((r) => setTimeout(r, 25));
  }
  private async hasLiveGroup(): Promise<boolean> {
    if (!this.pgid) return false;
    try {
      for (const pid of await readdir("/proc"))
        if (/^\d+$/.test(pid)) {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const end = stat.lastIndexOf(")");
            const fields = stat.slice(end + 2).split(" ");
            if (
              Number(fields[2]) === this.pgid &&
              fields[0] !== "Z" &&
              fields[0] !== "X"
            )
              return true;
          } catch {
            /* process exited */
          }
        }
      return false;
    } catch {
      return true;
    }
  }
}
function profileArgs(p: Profile): string[] {
  const a: string[] = [];
  if (p.provider) a.push("--provider", p.provider);
  if (p.model) a.push("--model", p.model);
  if (p.thinking) a.push("--thinking", p.thinking);
  for (const e of p.extensions ?? []) a.push("-e", e);
  if (p.tools?.length) a.push("--tools", p.tools.join(","));
  for (const s of p.appendSystemPrompts ?? [])
    a.push("--append-system-prompt", s);
  return a;
}
