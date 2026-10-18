import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  OperationInput,
  Snapshot,
  QueueItem,
  PendingDialog,
} from "../shared/contracts.js";
import type { Ledger, SessionRecord } from "./store.js";
import type { WorkspaceConfig } from "../shared/contracts.js";
import { WriterLease } from "./lease.js";
import { PiRpc, RpcError } from "./rpc.js";
import { inspectNative, readNativeTail } from "./native-reader.js";

function snapshotMetadata(
  project: WorkspaceConfig["projects"][number] | undefined,
  nativeId: string,
) {
  if (!project) return {};
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return {
    cwd: project.cwd,
    sessionDir: project.sessionDir,
    nativeCommand: `cd ${quote(project.cwd)} && pi --session-dir ${quote(project.sessionDir)} --session ${quote(nativeId)}`,
  };
}
interface Live {
  rpc: PiRpc;
  lease: WriterLease;
  snapshot: Snapshot;
  queue: QueueItem[];
  pending: Map<string, PendingDialog>;
  dialogTimers: Map<string, NodeJS.Timeout>;
  lastStopReason: string | undefined;
  epoch: number;
  reloading: boolean;
  eventHandler?: (e: Record<string, unknown>) => void;
}
export class WorkspaceRuntime extends EventEmitter {
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();
  private closing = false;
  private settled = new Map<string, number>();
  constructor(
    readonly config: WorkspaceConfig,
    readonly ledger: Ledger,
  ) {
    super();
  }
  private emitSnapshot(id: string): void {
    const l = this.live.get(id);
    if (l)
      this.emit(`session:${id}`, {
        type: "snapshot",
        data: {
          ...l.snapshot,
          queue: l.queue,
          pendingDialogs: [...l.pending.values()],
        },
      });
  }
  async ensure(record: SessionRecord, explicitClaim = false): Promise<Live> {
    if (this.closing) throw new Error("closing");
    const old = this.live.get(record.id);
    if (old) return old;
    const inFlight = this.starting.get(record.id);
    if (inFlight) return inFlight;
    if (record.desiredOwner !== "web" && !explicitClaim)
      throw new Error("owner_mismatch");
    const start = this.start(record, explicitClaim);
    this.starting.set(record.id, start);
    try {
      return await start;
    } finally {
      if (this.starting.get(record.id) === start)
        this.starting.delete(record.id);
    }
  }
  private async start(
    record: SessionRecord,
    explicitClaim: boolean,
  ): Promise<Live> {
    const project = this.config.projects.find((p) => p.id === record.projectId),
      profile = this.config.profiles.find((p) => p.id === record.profileId);
    if (!project || !profile) throw new Error("invalid_session_config");
    const lease = await WriterLease.acquire(record.nativeFile + ".prw.lock");
    let rpc: PiRpc | undefined,
      live: Live | undefined,
      preserve = false;
    try {
      const native = await inspectNative(record.nativeFile, project);
      if (native.id !== record.nativeId) throw new Error("native_id_mismatch");
      const initial: Snapshot = {
        id: record.id,
        nativeId: record.nativeId,
        projectId: record.projectId,
        profileId: record.profileId,
        desiredOwner: record.desiredOwner,
        runtimeState: "starting",
        queue: [],
        cleared: this.ledger.latestCleared(record.id),
        ...snapshotMetadata(project, record.nativeId),
      };
      rpc = new PiRpc(
        this.config.piCli,
        record.nativeFile,
        project,
        profile,
        lease,
      );
      live = {
        rpc,
        lease,
        snapshot: initial,
        queue: [],
        pending: new Map(),
        dialogTimers: new Map(),
        lastStopReason: undefined,
        epoch: 1,
        reloading: false,
      };
      this.live.set(record.id, live);
      this.bindEvents(record.id, live);
      rpc.on("failure", (code: string) => {
        if (
          live!.snapshot.runtimeState !== "releasing" &&
          live!.snapshot.runtimeState !== "blocked"
        ) {
          live!.snapshot.runtimeState = "blocked";
          live!.snapshot.lastError = code;
          this.emitSnapshot(record.id);
        }
      });
      const s = await rpc.command("get_state");
      const state = (
        s.data && typeof s.data === "object" ? s.data : undefined
      ) as Record<string, unknown> | undefined;
      if (
        !state ||
        state.sessionFile !== record.nativeFile ||
        state.sessionId !== record.nativeId
      )
        throw new Error("rpc_session_mismatch");
      const model =
        state.model && typeof state.model === "object"
          ? (state.model as Record<string, unknown>)
          : {};
      if (profile.model && model.id !== profile.model)
        throw new Error("rpc_model_mismatch");
      if (profile.provider && model.provider !== profile.provider)
        throw new Error("rpc_provider_mismatch");
      if (profile.thinking && state.thinkingLevel !== profile.thinking)
        throw new Error("rpc_thinking_mismatch");
      if (
        typeof state.isStreaming !== "boolean" ||
        typeof state.isCompacting !== "boolean" ||
        typeof state.pendingMessageCount !== "number" ||
        !Number.isInteger(state.pendingMessageCount)
      )
        throw new Error("rpc_protocol_error");
      await rpc.command("set_steering_mode", { mode: "one-at-a-time" });
      await rpc.command("set_follow_up_mode", { mode: "one-at-a-time" });
      if (live.snapshot.runtimeState === "blocked")
        throw new Error("startup_failed");
      live.snapshot = {
        ...initial,
        runtimeState:
          state.isStreaming ||
          state.isCompacting ||
          state.pendingMessageCount > 0
            ? "running"
            : "idle",
        ...(typeof model.provider === "string"
          ? { actualProvider: model.provider }
          : {}),
        ...(typeof model.id === "string" ? { actualModel: model.id } : {}),
        ...(typeof state.thinkingLevel === "string"
          ? { actualThinking: state.thinkingLevel }
          : {}),
      };
      this.emitSnapshot(record.id);
      if (explicitClaim) {
        try {
          this.ledger.setOwner(record.id, "web");
        } catch (e) {
          preserve = true;
          live.snapshot.runtimeState = "blocked";
          live.snapshot.lastError = "storage_error";
          this.emitSnapshot(record.id);
          throw e;
        }
        record.desiredOwner = "web";
        live.snapshot.desiredOwner = "web";
        this.emitSnapshot(record.id);
      }
      return live;
    } catch (e) {
      if (preserve) throw e;
      if (live) {
        live.snapshot.runtimeState = "blocked";
        live.snapshot.lastError = "startup_failed";
        this.emitSnapshot(record.id);
      }
      if (rpc) {
        try {
          await rpc.close();
        } catch {
          if (live) {
            live.snapshot.runtimeState = "blocked";
            live.snapshot.lastError = "cleanup_incomplete";
          }
          throw new Error("cleanup_incomplete");
        }
      }
      this.live.delete(record.id);
      await lease.close();
      throw e;
    }
  }
  private isBlocked(live: Live): boolean {
    return live.snapshot.runtimeState === "blocked";
  }
  private bindEvents(id: string, live: Live): void {
    const epoch = live.epoch;
    const handler = (e: Record<string, unknown>) => {
      if (this.live.get(id) === live && live.epoch === epoch && !live.reloading)
        this.event(id, e);
    };
    live.eventHandler = handler;
    live.rpc.on("event", handler);
  }
  private event(id: string, e: Record<string, unknown>): void {
    const l = this.live.get(id);
    if (!l || l.reloading) return;
    const kind = e.type;
    if (
      (kind === "agent_start" || kind === "message_start") &&
      !["stopping", "releasing", "blocked"].includes(l.snapshot.runtimeState)
    )
      l.snapshot.runtimeState = "running";
    if (
      kind === "compaction_start" ||
      kind === "auto_retry_start" ||
      kind === "summarization_retry_attempt_start"
    ) {
      if (
        !["stopping", "releasing", "blocked"].includes(l.snapshot.runtimeState)
      )
        l.snapshot.runtimeState = "running";
    }
    if (
      kind === "compaction_end" ||
      kind === "auto_retry_end" ||
      kind === "summarization_retry_finished"
    ) {
      if (
        !["stopping", "releasing", "blocked"].includes(l.snapshot.runtimeState)
      )
        l.snapshot.runtimeState = "running";
    }
    if (kind === "message_end") {
      const m = e.message as Record<string, unknown> | undefined;
      if (m?.role === "assistant" && typeof m.stopReason === "string") {
        l.lastStopReason = m.stopReason;
        if (["error", "aborted", "length"].includes(m.stopReason))
          l.snapshot.lastOutcome = m.stopReason;
      }
    }
    if (kind === "agent_start") l.lastStopReason = undefined;
    if (kind === "agent_settled") {
      this.settled.set(id, (this.settled.get(id) ?? 0) + 1);
      if (
        !["stopping", "releasing", "blocked"].includes(l.snapshot.runtimeState)
      ) {
        l.snapshot.runtimeState = "idle";
        const aborted = e.aborted === true;
        if (aborted) l.snapshot.lastOutcome = "aborted";
        else {
          const reason = l.lastStopReason;
          l.snapshot.lastOutcome =
            reason && ["error", "length", "aborted"].includes(reason)
              ? reason
              : "settled";
        }
      }
    }
    if (kind === "queue_update") {
      const steering = e.steering as unknown[],
        followUp = e.followUp as unknown[];
      l.queue = [
        ...steering.map((text) => ({
          kind: "steer" as const,
          text: String(text),
        })),
        ...followUp.map((text) => ({
          kind: "follow_up" as const,
          text: String(text),
        })),
      ];
    }
    if (kind === "extension_ui_request") this.extensionRequest(l, e);
    this.emit(`session:${id}`, { type: "rpc", data: e });
    this.emitSnapshot(id);
  }
  private extensionRequest(l: Live, e: Record<string, unknown>): void {
    if (typeof e.id !== "string" || typeof e.method !== "string") return;
    const dialogId = e.id;
    const method = e.method;
    if (
      [
        "notify",
        "setStatus",
        "setWidget",
        "setTitle",
        "set_editor_text",
      ].includes(method)
    )
      return;
    if (!["confirm", "select", "input", "editor"].includes(method)) {
      l.rpc.respondUI(dialogId, { cancelled: true }).catch(() => undefined);
      this.emit("warning", "extension_ui_unsupported");
      return;
    }
    const duration =
      typeof e.timeout === "number" &&
      Number.isFinite(e.timeout) &&
      e.timeout > 0
        ? Math.min(e.timeout, 300000)
        : 300000;
    const dialog: PendingDialog = {
      id: e.id,
      method: method as PendingDialog["method"],
      title: typeof e.title === "string" ? e.title : "",
      ...(typeof e.message === "string" ? { message: e.message } : {}),
      ...(typeof e.placeholder === "string"
        ? { placeholder: e.placeholder }
        : {}),
      expiresAt: Date.now() + duration,
      ...(Array.isArray(e.options) &&
      e.options.every((x) => typeof x === "string")
        ? { options: e.options as string[] }
        : {}),
      ...(typeof e.prefill === "string" ? { prefill: e.prefill } : {}),
    };
    if (l.pending.size >= 100) {
      const oldest = l.pending.keys().next().value as string | undefined;
      if (oldest) {
        l.pending.delete(oldest);
        const timer = l.dialogTimers.get(oldest);
        if (timer) clearTimeout(timer);
        l.dialogTimers.delete(oldest);
        l.rpc.respondUI(oldest, { cancelled: true }).catch(() => undefined);
      }
    }
    const prior = l.dialogTimers.get(dialogId);
    if (prior) clearTimeout(prior);
    l.pending.set(dialogId, dialog);
    const timer = setTimeout(() => {
      l.dialogTimers.delete(dialogId);
      if (l.pending.get(dialogId) === dialog) {
        l.pending.delete(dialogId);
        l.rpc.respondUI(dialogId, { cancelled: true }).catch(() => undefined);
        this.emitSnapshot(l.snapshot.id);
      }
    }, duration);
    timer.unref();
    l.dialogTimers.set(dialogId, timer);
  }
  async block(id: string, reason: string): Promise<void> {
    const live = this.live.get(id);
    if (live) {
      live.snapshot.runtimeState = "blocked";
      live.snapshot.lastError = reason;
      this.emitSnapshot(id);
    }
  }
  private async ensureFresh(
    record: SessionRecord,
    live: Live,
    allowReload: boolean,
  ): Promise<void> {
    const project = this.config.projects.find((p) => p.id === record.projectId);
    if (!project) throw new Error("invalid_session_config");
    const verifyIdentity = async () => {
      const meta = await inspectNative(record.nativeFile, project);
      if (meta.file !== record.nativeFile || meta.id !== record.nativeId)
        throw new Error("sync_unconfirmed");
      return readNativeTail(record.nativeFile, project, {
        expectedNativeId: record.nativeId,
      });
    };
    const check = async (tail: Awaited<ReturnType<typeof readNativeTail>>) => {
      if (tail.id === null) {
        const r = await live.rpc.command("get_state"),
          s = r.data as Record<string, unknown>;
        if (
          !s ||
          s.messageCount !== 0 ||
          s.isStreaming !== false ||
          s.isCompacting !== false ||
          s.pendingMessageCount !== 0 ||
          live.queue.length ||
          live.pending.size
        )
          throw new Error("sync_unconfirmed");
        return true;
      }
      try {
        const r = await live.rpc.command("get_entries", { since: tail.id });
        const d = r.data as Record<string, unknown> | undefined;
        if (!d || !Array.isArray(d.entries) || typeof d.leafId !== "string")
          throw new Error("sync_unconfirmed");
        return d.entries.length === 0 && d.leafId === tail.id;
      } catch (e) {
        if (
          e instanceof RpcError &&
          e.code === "rpc_command_rejected" &&
          !e.uncertain
        )
          return false;
        throw e;
      }
    };
    const currentResult = await live.rpc.command("get_state");
    const current = currentResult.data as Record<string, unknown>;
    const profile = this.config.profiles.find((p) => p.id === record.profileId);
    const currentModel =
      current?.model && typeof current.model === "object"
        ? (current.model as Record<string, unknown>)
        : undefined;
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !profile ||
      current.sessionFile !== record.nativeFile ||
      current.sessionId !== record.nativeId ||
      (profile.provider !== undefined &&
        currentModel?.provider !== profile.provider) ||
      (profile.model !== undefined && currentModel?.id !== profile.model) ||
      (profile.thinking !== undefined &&
        current.thinkingLevel !== profile.thinking)
    )
      throw new Error("sync_unconfirmed");
    if (
      typeof current.isStreaming !== "boolean" ||
      typeof current.isCompacting !== "boolean" ||
      typeof current.pendingMessageCount !== "number" ||
      !Number.isInteger(current.pendingMessageCount) ||
      current.pendingMessageCount < 0
    )
      throw new Error("sync_unconfirmed");
    const tail = await verifyIdentity();
    if (await check(tail)) {
      if (live.snapshot.runtimeState === "blocked")
        throw new Error("sync_unconfirmed");
      const confirmedTail = await verifyIdentity();
      if (confirmedTail.fingerprint !== tail.fingerprint)
        throw Object.assign(new Error("sync_conflict"), { statusCode: 409 });
      return;
    }
    const busyState =
      live.snapshot.runtimeState !== "idle" ||
      live.queue.length > 0 ||
      live.pending.size > 0;
    if (!allowReload || busyState)
      throw Object.assign(new Error("sync_conflict"), { statusCode: 409 });
    const stateResult = await live.rpc.command("get_state"),
      state = stateResult.data as Record<string, unknown>,
      stateModel =
        state?.model && typeof state.model === "object"
          ? (state.model as Record<string, unknown>)
          : undefined;
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.sessionFile !== record.nativeFile ||
      state.sessionId !== record.nativeId ||
      (profile.provider !== undefined &&
        stateModel?.provider !== profile.provider) ||
      (profile.model !== undefined && stateModel?.id !== profile.model) ||
      (profile.thinking !== undefined &&
        state.thinkingLevel !== profile.thinking) ||
      typeof state.isStreaming !== "boolean" ||
      typeof state.isCompacting !== "boolean" ||
      typeof state.pendingMessageCount !== "number" ||
      !Number.isInteger(state.pendingMessageCount) ||
      state.pendingMessageCount < 0
    )
      throw new Error("sync_unconfirmed");
    if (
      state.isStreaming !== false ||
      state.isCompacting !== false ||
      state.pendingMessageCount !== 0
    )
      throw Object.assign(new Error("sync_conflict"), { statusCode: 409 });
    const oldHandler = live.eventHandler;
    if (oldHandler) live.rpc.off("event", oldHandler);
    delete live.eventHandler;
    live.reloading = true;
    live.epoch++;
    this.emit(`session:${record.id}`, { type: "resync-required" });
    try {
      const switched = await live.rpc.command("switch_session", {
        session: record.nativeFile,
      });
      const result = switched.data as Record<string, unknown> | undefined;
      if (!result || result.cancelled !== false)
        throw new Error(
          result?.cancelled === true ? "sync_cancelled" : "sync_unconfirmed",
        );
      const metaAfter = await inspectNative(record.nativeFile, project);
      if (
        metaAfter.id !== record.nativeId ||
        metaAfter.file !== record.nativeFile
      )
        throw new Error("sync_unconfirmed");
      const afterStateResult = await live.rpc.command("get_state"),
        after = afterStateResult.data as Record<string, unknown>;
      const model = after?.model as Record<string, unknown> | undefined;
      const profile = this.config.profiles.find(
        (p) => p.id === record.profileId,
      );
      if (
        !profile ||
        after.sessionFile !== record.nativeFile ||
        after.sessionId !== record.nativeId ||
        after.isStreaming !== false ||
        after.isCompacting !== false ||
        after.pendingMessageCount !== 0 ||
        live.queue.length !== 0 ||
        live.pending.size !== 0 ||
        live.snapshot.runtimeState === "blocked" ||
        (profile.provider !== undefined &&
          model?.provider !== profile.provider) ||
        (profile.model !== undefined && model?.id !== profile.model) ||
        (profile.thinking !== undefined &&
          after.thinkingLevel !== profile.thinking)
      )
        throw new Error("sync_unconfirmed");
      await live.rpc.command("set_steering_mode", { mode: "one-at-a-time" });
      await live.rpc.command("set_follow_up_mode", { mode: "one-at-a-time" });
      if (this.isBlocked(live)) throw new Error("sync_unconfirmed");
      const newTail = await verifyIdentity();
      if (
        newTail.fingerprint !== tail.fingerprint ||
        !(await check(newTail)) ||
        this.isBlocked(live) ||
        live.queue.length !== 0 ||
        live.pending.size !== 0
      )
        throw new Error("sync_unconfirmed");
      live.snapshot.runtimeState = "idle";
      delete live.snapshot.actualProvider;
      delete live.snapshot.actualModel;
      delete live.snapshot.actualThinking;
      if (typeof model?.provider === "string")
        live.snapshot.actualProvider = model.provider;
      if (typeof model?.id === "string") live.snapshot.actualModel = model.id;
      if (typeof after?.thinkingLevel === "string")
        live.snapshot.actualThinking = after.thinkingLevel;
      delete live.snapshot.lastError;
    } catch (e) {
      const safeConflict = (e as { statusCode?: number })?.statusCode === 409;
      if (!safeConflict) live.snapshot.runtimeState = "blocked";
      delete live.snapshot.lastError;
      live.snapshot.lastError =
        e instanceof Error &&
        ["sync_cancelled", "sync_unconfirmed", "sync_conflict"].includes(
          e.message,
        )
          ? e.message
          : "sync_unconfirmed";
      throw e instanceof Error &&
        ["sync_cancelled", "sync_unconfirmed", "sync_conflict"].includes(
          e.message,
        )
        ? e
        : e instanceof RpcError && e.uncertain === true
          ? e
          : new Error("sync_unconfirmed");
    } finally {
      live.reloading = false;
      if (
        this.live.get(record.id) === live &&
        live.snapshot.runtimeState !== "blocked"
      ) {
        this.bindEvents(record.id, live);
        this.emit(`session:${record.id}`, { type: "resync-required" });
      }
      this.emitSnapshot(record.id);
    }
  }
  private async ensureFreshOrBlock(
    record: SessionRecord,
    live: Live,
    allowReload: boolean,
  ): Promise<void> {
    try {
      await this.ensureFresh(record, live, allowReload);
    } catch (e) {
      const statusCode = (e as { statusCode?: number })?.statusCode;
      if (statusCode !== 409) {
        live.snapshot.runtimeState = "blocked";
        live.snapshot.lastError =
          e instanceof Error ? e.message : "sync_unconfirmed";
        this.emitSnapshot(record.id);
      }
      throw e;
    }
  }
  async operation(
    record: SessionRecord,
    input: OperationInput,
    operationId?: string,
  ): Promise<unknown> {
    if (this.closing) throw new Error("closing");
    let live = this.live.get(record.id);
    if (input.kind === "claim") {
      if (live)
        throw Object.assign(new Error("already_claimed"), { statusCode: 409 });
      live = await this.ensure(record, true);
      return { status: "claimed" };
    }
    if (input.kind === "release") {
      if (!live)
        throw Object.assign(new Error("not_running"), { statusCode: 409 });
      if (live.snapshot.runtimeState !== "idle" || live.queue.length)
        throw Object.assign(new Error("session_busy"), { statusCode: 409 });
      live.snapshot.runtimeState = "releasing";
      for (const timer of live.dialogTimers.values()) clearTimeout(timer);
      live.dialogTimers.clear();
      live.pending.clear();
      this.emitSnapshot(record.id);
      try {
        await live.rpc.close();
      } catch (e) {
        await this.block(record.id, "cleanup_incomplete");
        throw e;
      }
      try {
        this.ledger.setOwner(record.id, "tui");
      } catch (e) {
        await this.block(record.id, "storage_error");
        throw e;
      }
      record.desiredOwner = "tui";
      live.snapshot.desiredOwner = "tui";
      try {
        await live.lease.close();
      } catch (e) {
        await this.block(record.id, "cleanup_incomplete");
        throw e;
      }
      live.snapshot.runtimeState = "released";
      this.emitSnapshot(record.id);
      this.live.delete(record.id);
      this.emit(`session:${record.id}`, {
        type: "snapshot",
        data: { ...live.snapshot },
      });
      return { status: "released" };
    }
    live =
      live ??
      (await this.ensure(
        record,
        input.kind === "prompt" && record.desiredOwner === "tui",
      ));
    const rpc = live.rpc,
      state = live.snapshot.runtimeState;
    if (
      ["stopping", "releasing", "blocked"].includes(state) &&
      input.kind !== "stop"
    )
      throw Object.assign(new Error("session_blocked"), { statusCode: 409 });
    const busy = state === "running" || state === "stopping";
    if (input.kind === "prompt" && busy)
      throw Object.assign(new Error("session_busy"), { statusCode: 409 });
    if (["steer", "follow_up"].includes(input.kind) && (!busy || !input.text))
      throw Object.assign(
        new Error(!input.text ? "text_required" : "session_idle"),
        { statusCode: 409 },
      );
    if (input.kind === "stop") {
      if (state === "blocked")
        throw Object.assign(new Error("session_blocked"), { statusCode: 409 });
      live.snapshot.runtimeState = "stopping";
      this.emitSnapshot(record.id);
      try {
        const cleared = await rpc.command("clear_queue");
        const data = cleared.data as Record<string, unknown>;
        if (
          !Array.isArray(data?.steering) ||
          !data.steering.every((x) => typeof x === "string") ||
          !Array.isArray(data?.followUp) ||
          !data.followUp.every((x) => typeof x === "string")
        )
          throw new Error("rpc_protocol_error");
        live.snapshot.cleared = [
          ...data.steering.map((text) => ({ kind: "steer" as const, text })),
          ...data.followUp.map((text) => ({
            kind: "follow_up" as const,
            text,
          })),
        ];
        live.queue = [];
        if (operationId)
          this.ledger.saveResult(operationId, {
            status: "stopping",
            cleared: live.snapshot.cleared,
          });
        await rpc.command("abort", {}, 15000);
        const result = await rpc.command("get_state");
        const verify = result.data as Record<string, unknown>;
        if (
          verify.isStreaming !== false ||
          verify.isCompacting !== false ||
          verify.pendingMessageCount !== 0
        )
          throw new Error("stop_unconfirmed");
        live.snapshot.runtimeState = "idle";
        this.emitSnapshot(record.id);
        return { status: "stopped", cleared: live.snapshot.cleared };
      } catch (e) {
        await this.block(
          record.id,
          e instanceof Error ? e.message : "stop_failed",
        );
        throw e;
      }
    }
    if (input.kind === "ui_response") {
      const d = live.pending.get(input.dialogId ?? "");
      if (!d || d.expiresAt <= Date.now() || d.method !== input.method)
        throw Object.assign(new Error("dialog_invalid"), { statusCode: 409 });
      const response: Record<string, unknown> = {};
      if (
        input.value !== null &&
        typeof input.value === "object" &&
        !Array.isArray(input.value) &&
        Object.keys(input.value).length === 1 &&
        (input.value as { cancelled?: unknown }).cancelled === true
      )
        response.cancelled = true;
      else if (d.method === "confirm" && typeof input.value === "boolean")
        response.confirmed = input.value;
      else if (d.method !== "confirm" && typeof input.value === "string")
        response.value = input.value;
      else throw new Error("dialog_invalid");
      if (
        d.method === "confirm" &&
        typeof response.confirmed !== "boolean" &&
        response.cancelled !== true
      )
        throw new Error("dialog_invalid");
      if (
        d.method === "select" &&
        typeof response.value !== "string" &&
        response.cancelled !== true
      )
        throw new Error("dialog_invalid");
      if (
        d.method === "select" &&
        response.value &&
        !d.options?.includes(response.value as string)
      )
        throw new Error("dialog_invalid");
      if (
        ["input", "editor"].includes(d.method) &&
        typeof response.value !== "string" &&
        response.cancelled !== true
      )
        throw new Error("dialog_invalid");
      await rpc.respondUI(d.id, response);
      live.pending.delete(d.id);
      const dialogTimer = live.dialogTimers.get(d.id);
      if (dialogTimer) clearTimeout(dialogTimer);
      live.dialogTimers.delete(d.id);
      this.emitSnapshot(record.id);
      return { status: "accepted" };
    }
    if (input.kind === "compact") {
      await this.ensureFreshOrBlock(record, live, true);
      if (state !== "idle" || live.queue.length)
        throw Object.assign(new Error("session_busy"), { statusCode: 409 });
      live.snapshot.runtimeState = "running";
      this.emitSnapshot(record.id);
      try {
        let result: Record<string, unknown>;
        try {
          result = await rpc.command("compact", {}, 120000);
        } catch (e) {
          if (
            !(e instanceof RpcError) ||
            e.code !== "rpc_command_rejected" ||
            e.uncertain !== false
          )
            throw e;
          const stateResult = await rpc.command("get_state");
          const verified = this.confirmCompactIdle(
            record,
            live,
            stateResult.data,
          );
          if (!verified || (live.snapshot.runtimeState as string) === "blocked")
            throw new RpcError("rpc_compact_unconfirmed", true);
          live.snapshot.runtimeState = "idle";
          live.snapshot.lastError = "compact_rejected";
          this.emitSnapshot(record.id);
          throw new RpcError("compact_rejected", false);
        }
        const stateResult = await rpc.command("get_state");
        if (
          !this.confirmCompactIdle(record, live, stateResult.data) ||
          (live.snapshot.runtimeState as string) === "blocked"
        )
          throw new RpcError("rpc_compact_unconfirmed", true);
        live.snapshot.runtimeState = "idle";
        this.emitSnapshot(record.id);
        return result;
      } catch (e) {
        if (
          e instanceof RpcError &&
          e.code === "compact_rejected" &&
          !e.uncertain
        )
          throw e;
        await this.block(record.id, "compact_unconfirmed");
        throw new RpcError("rpc_compact_unconfirmed", true);
      }
    }
    if (["prompt", "steer", "follow_up"].includes(input.kind)) {
      await this.ensureFreshOrBlock(record, live, input.kind === "prompt");
      if (!input.text)
        throw Object.assign(new Error("text_required"), { statusCode: 400 });
      if (/^\s*\/(?:steer|follow_up)\b/.test(input.text))
        throw Object.assign(new Error("extension_command_unsupported"), {
          statusCode: 400,
        });
      const cmd = input.kind === "prompt" ? "prompt" : input.kind,
        settledBefore = this.settled.get(record.id) ?? 0;
      if (input.kind === "prompt") live.lastStopReason = undefined;
      const response = await rpc.command(cmd, { message: input.text });
      const disposition = (response.data as Record<string, unknown> | undefined)
        ?.disposition;
      if (
        disposition === "started" &&
        (this.settled.get(record.id) ?? 0) === settledBefore &&
        live.snapshot.runtimeState !== "blocked"
      )
        live.snapshot.runtimeState = "running";
      this.emitSnapshot(record.id);
      return {
        status: disposition === "handled" ? "handled" : "accepted",
        response,
      };
    }
    throw Object.assign(new Error("unsupported_operation"), {
      statusCode: 400,
    });
  }
  private confirmCompactIdle(
    record: SessionRecord,
    live: Live,
    data: unknown,
  ): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const state = data as Record<string, unknown>;
    return (
      state.isStreaming === false &&
      state.isCompacting === false &&
      state.pendingMessageCount === 0 &&
      state.sessionId === record.nativeId &&
      state.sessionFile === record.nativeFile &&
      live.queue.length === 0 &&
      live.pending.size === 0
    );
  }
  snapshot(record: SessionRecord): Snapshot {
    const l = this.live.get(record.id);
    const metadata = snapshotMetadata(
      this.config.projects.find((p) => p.id === record.projectId),
      record.nativeId,
    );
    return l
      ? {
          ...l.snapshot,
          desiredOwner: record.desiredOwner,
          queue: l.queue,
          pendingDialogs: [...l.pending.values()],
          ...metadata,
        }
      : {
          id: record.id,
          nativeId: record.nativeId,
          projectId: record.projectId,
          profileId: record.profileId,
          desiredOwner: record.desiredOwner,
          runtimeState: "released",
          queue: [],
          cleared: this.ledger.latestCleared(record.id),
          ...metadata,
        };
  }
  subscribe(id: string, fn: (data: unknown) => void): () => void {
    const event = `session:${id}`;
    this.on(event, fn);
    return () => this.off(event, fn);
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()]);
    const errors: unknown[] = [];
    for (const [id, l] of this.live) {
      try {
        l.snapshot.runtimeState = "releasing";
        for (const timer of l.dialogTimers.values()) clearTimeout(timer);
        l.dialogTimers.clear();
        l.pending.clear();
        this.emitSnapshot(id);
        await l.rpc.close();
        await l.lease.close();
        l.snapshot.runtimeState = "released";
        this.emit(`session:${id}`, {
          type: "snapshot",
          data: { ...l.snapshot },
        });
        this.live.delete(id);
      } catch (e) {
        await this.block(id, "cleanup_incomplete");
        errors.push(e);
      }
    }
    if (errors.length) throw new Error("cleanup_incomplete");
  }
}
export function newOperationId(): string {
  return randomUUID();
}
