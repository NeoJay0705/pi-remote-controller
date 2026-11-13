import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { WriterLease } from "../../src/server/lease.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("rpc-release-safety");

async function make() {
  const dir = await mkdtemp(join(root, "runtime-"));
  const projectDir = join(dir, "project");
  const sessionDir = join(projectDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const journal = join(dir, "rpc.journal");
  const oldJournal = process.env.FAKE_PI_JOURNAL;
  process.env.FAKE_PI_JOURNAL = journal;
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects: [{ id: "p", name: "p", cwd: projectDir, sessionDir }],
    profiles: [
      {
        id: "f",
        name: "f",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      },
    ],
  };
  const ledger = await Ledger.open(config.dataDir);
  const runtime = new WorkspaceRuntime(config, ledger);
  const native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  const liveMap = (runtime as unknown as { live: Map<string, Live> }).live;
  const activate = async (target = record) => {
    await runtime.operation(target, {
      operationId: `init-${target.id}`,
      kind: "prompt",
      text: "idle",
    });
    const live = liveMap.get(target.id)!;
    // The fake process may emit settlement just after the acknowledgement; pin
    // the known-idle fixture before exercising release admission.
    live.snapshot.runtimeState = "idle";
    return live;
  };
  return {
    dir,
    journal,
    oldJournal,
    config,
    ledger,
    runtime,
    record,
    liveMap,
    activate,
  };
}

interface Live {
  rpc: {
    command: (
      type: string,
      params?: unknown,
      timeout?: number,
    ) => Promise<{ data?: unknown }>;
    close: () => Promise<void>;
    child: { pid?: number; exitCode: number | null };
  };
  lease: WriterLease;
  snapshot: { runtimeState: string; lastError?: string };
  queue: unknown[];
  pending: Map<string, unknown>;
  reloading: boolean;
}

async function cleanup(s: Awaited<ReturnType<typeof make>>) {
  try {
    await s.runtime.shutdown();
  } catch (error) {
    if (s.liveMap.size !== 0) throw error;
  } finally {
    s.ledger.close();
    if (s.oldJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
    else process.env.FAKE_PI_JOURNAL = s.oldJournal;
    await rm(s.dir, { recursive: true, force: true });
  }
}

function validState(record: { nativeId: string; nativeFile: string }) {
  return {
    sessionId: record.nativeId,
    sessionFile: record.nativeFile,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  };
}

describe("RPC release no-close safety", () => {
  it.each([
    [
      "malformed data",
      "rpc_state_unavailable",
      (state: Record<string, unknown>) => ({
        ...state,
        pendingMessageCount: "0",
      }),
    ],
    [
      "wrong native identity",
      "rpc_state_mismatch",
      (state: Record<string, unknown>) => ({
        ...state,
        sessionId: "wrong-native",
      }),
    ],
    [
      "streaming",
      "rpc_busy",
      (state: Record<string, unknown>) => ({ ...state, isStreaming: true }),
    ],
    [
      "compacting",
      "rpc_busy",
      (state: Record<string, unknown>) => ({ ...state, isCompacting: true }),
    ],
    [
      "pending messages",
      "rpc_busy",
      (state: Record<string, unknown>) => ({
        ...state,
        pendingMessageCount: 1,
      }),
    ],
  ])(
    "rejects unsafe RPC get_state (%s) without close",
    async (_name, reason, alter) => {
      const s = await make();
      try {
        const live = await s.activate();
        const close = vi.spyOn(live.rpc, "close");
        const command = live.rpc.command.bind(live.rpc);
        vi.spyOn(live.rpc, "command").mockImplementation(
          (type, params, timeout) =>
            type === "get_state"
              ? Promise.resolve({ data: alter(validState(s.record)) })
              : command(type, params, timeout),
        );
        await expect(
          s.runtime.operation(s.record, {
            operationId: `release-${_name}`,
            kind: "release",
          }),
        ).rejects.toMatchObject({ message: reason });
        expect(close).not.toHaveBeenCalled();
        expect(s.liveMap.get(s.record.id)).toBe(live);
        expect(live.snapshot.runtimeState).toBe("idle");
        await expect(
          WriterLease.acquire(`${s.record.nativeFile}.prw.lock`),
        ).rejects.toMatchObject({ statusCode: 423 });
        expect(live.rpc.child.exitCode).toBeNull();
        close.mockRestore();
      } finally {
        await cleanup(s);
      }
    },
  );

  it("rejects a rejected RPC state command without closing or releasing", async () => {
    const s = await make();
    try {
      const live = await s.activate();
      const close = vi.spyOn(live.rpc, "close");
      const command = live.rpc.command.bind(live.rpc);
      vi.spyOn(live.rpc, "command").mockImplementation(
        (type, params, timeout) =>
          type === "get_state"
            ? Promise.reject(new Error("probe rejected"))
            : command(type, params, timeout),
      );
      await expect(
        s.runtime.operation(s.record, {
          operationId: "rejected-probe",
          kind: "release",
        }),
      ).rejects.toMatchObject({ message: "rpc_state_unavailable" });
      expect(close).not.toHaveBeenCalled();
      expect(s.liveMap.get(s.record.id)).toBe(live);
      await expect(
        WriterLease.acquire(`${s.record.nativeFile}.prw.lock`),
      ).rejects.toMatchObject({ statusCode: 423 });
      close.mockRestore();
    } finally {
      await cleanup(s);
    }
  });

  it.each([
    [
      "running",
      (live: Live) => {
        live.snapshot.runtimeState = "running";
      },
    ],
    [
      "queue",
      (live: Live) => {
        live.queue.push({});
      },
    ],
    [
      "dialog",
      (live: Live) => {
        live.pending.set("pending", {});
      },
    ],
    [
      "transition",
      (live: Live) => {
        live.reloading = true;
      },
    ],
  ])(
    "rechecks a local %s change after the gated get_state",
    async (_label, change) => {
      const s = await make();
      let unblock!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        unblock = resolveGate;
      });
      const entered = new Promise<void>((resolveEntered) => {
        reached = resolveEntered;
      });
      try {
        const live = await s.activate();
        const close = vi.spyOn(live.rpc, "close");
        const command = live.rpc.command.bind(live.rpc);
        vi.spyOn(live.rpc, "command").mockImplementation(
          async (type, params, timeout) => {
            const result = await command(type, params, timeout);
            if (type === "get_state") {
              reached();
              await gate;
              return {
                ...result,
                data: {
                  ...(result.data as Record<string, unknown>),
                  ...validState(s.record),
                },
              };
            }
            return result;
          },
        );
        const releasing = s.runtime.operation(s.record, {
          operationId: `racing-${_label}`,
          kind: "release",
        });
        await entered;
        change(live);
        unblock();
        await expect(releasing).rejects.toMatchObject({
          message: "runtime_changed",
        });
        expect(close).not.toHaveBeenCalled();
        expect(s.liveMap.get(s.record.id)).toBe(live);
        await expect(
          WriterLease.acquire(`${s.record.nativeFile}.prw.lock`),
        ).rejects.toMatchObject({ statusCode: 423 });
        live.snapshot.runtimeState = "idle";
        live.queue.length = 0;
        live.pending.clear();
        live.reloading = false;
        close.mockRestore();
      } finally {
        unblock();
        await cleanup(s);
      }
    },
  );

  it("does not release an idle runtime owned by TUI", async () => {
    const s = await make();
    try {
      const live = await s.activate();
      s.ledger.setOwner(s.record.id, "tui");
      s.record.desiredOwner = "tui";
      const close = vi.spyOn(live.rpc, "close");
      await expect(
        s.runtime.operation(s.record, {
          operationId: "wrong-owner",
          kind: "release",
        }),
      ).rejects.toMatchObject({ message: "owner_mismatch" });
      expect(close).not.toHaveBeenCalled();
      expect(s.liveMap.get(s.record.id)).toBe(live);
      await expect(
        WriterLease.acquire(`${s.record.nativeFile}.prw.lock`),
      ).rejects.toMatchObject({ statusCode: 423 });
    } finally {
      await cleanup(s);
    }
  });

  it("blocks and retains the lease after actual RPC close failure", async () => {
    const s = await make();
    try {
      const live = await s.activate();
      const actualClose = live.rpc.close.bind(live.rpc);
      const command = live.rpc.command.bind(live.rpc);
      vi.spyOn(live.rpc, "command").mockImplementation(
        async (type, params, timeout) => {
          const result = await command(type, params, timeout);
          if (type === "get_state") {
            live.snapshot.runtimeState = "idle";
            return {
              ...result,
              data: {
                ...(result.data as Record<string, unknown>),
                ...validState(s.record),
              },
            };
          }
          return result;
        },
      );
      const close = vi
        .spyOn(live.rpc, "close")
        .mockRejectedValueOnce(new Error("injected close failure"));
      live.snapshot.runtimeState = "idle";
      await expect(
        s.runtime.operation(s.record, {
          operationId: "close-failure",
          kind: "release",
        }),
      ).rejects.toThrow("injected close failure");
      expect(close).toHaveBeenCalledOnce();
      expect(s.runtime.snapshot(s.record)).toMatchObject({
        runtimeState: "blocked",
        lastError: "cleanup_incomplete",
      });
      expect(s.liveMap.get(s.record.id)).toBe(live);
      await expect(
        WriterLease.acquire(`${s.record.nativeFile}.prw.lock`),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(live.rpc.child.exitCode).toBeNull();
      close.mockRestore();
      await actualClose();
      await live.lease.close();
      s.liveMap.delete(s.record.id);
    } finally {
      vi.restoreAllMocks();
      const remaining = s.liveMap.get(s.record.id);
      if (remaining) {
        await remaining.rpc.close().catch(() => undefined);
        await remaining.lease.close().catch(() => undefined);
        s.liveMap.delete(s.record.id);
      }
      await cleanup(s);
    }
  });

  it("releases only the target lease and preserves its native bytes and ledger record", async () => {
    const s = await make();
    try {
      const target = await s.activate();
      const otherNative = await createNative(s.config.projects[0]!);
      const other = s.ledger.createSession({
        nativeFile: otherNative.file,
        nativeId: otherNative.id,
        projectId: "p",
        profileId: "f",
      });
      const otherLive = await s.activate(other);
      const targetBytes = await readFile(s.record.nativeFile);
      const targetClose = vi.spyOn(target.rpc, "close");
      const otherClose = vi.spyOn(otherLive.rpc, "close");
      expect(
        await s.runtime.operation(s.record, {
          operationId: "safe-release",
          kind: "release",
        }),
      ).toEqual({ status: "released" });
      expect(targetClose).toHaveBeenCalledOnce();
      expect(otherClose).not.toHaveBeenCalled();
      expect(s.liveMap.has(s.record.id)).toBe(false);
      expect(s.liveMap.get(other.id)).toBe(otherLive);
      expect(otherLive.rpc.child.exitCode).toBeNull();
      expect(await readFile(s.record.nativeFile)).toEqual(targetBytes);
      expect(s.ledger.session(s.record.id)).toMatchObject({
        id: s.record.id,
        nativeFile: s.record.nativeFile,
        nativeId: s.record.nativeId,
        desiredOwner: "tui",
      });
      await WriterLease.acquire(`${s.record.nativeFile}.prw.lock`).then(
        (lease) => lease.close(),
      );
      await expect(
        WriterLease.acquire(`${other.nativeFile}.prw.lock`),
      ).rejects.toMatchObject({ statusCode: 423 });
      const journal = await readFile(s.journal, "utf8");
      expect(
        journal.split("\n").filter((line) => line === "get_state").length,
      ).toBeGreaterThanOrEqual(4);
      expect(journal).toContain("get_state");
    } finally {
      await cleanup(s);
    }
  });
});
