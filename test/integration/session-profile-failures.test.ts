import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { WriterLease } from "../../src/server/lease.js";
import { PiRpc, RpcError } from "../../src/server/rpc.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("session-profile-failures");
const token = "profile-failure-test-token-12345678901234567890";

async function fixture(label: string) {
  const dir = await mkdtemp(join(root, `${label}-`));
  const cwd = join(dir, "project"),
    sessionDir = join(cwd, ".pi", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects: [{ id: "p", name: "P", cwd, sessionDir }],
    profiles: [
      {
        id: "a",
        name: "A",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      },
      {
        id: "b",
        name: "B",
        provider: "provider-b",
        model: "model-b",
        thinking: "high",
      },
    ],
  };
  const priorArgvJournal = process.env.FAKE_PI_ARGV_JOURNAL;
  process.env.FAKE_PI_ARGV_JOURNAL = join(dir, "argv.jsonl");
  const ledger = await Ledger.open(config.dataDir),
    runtime = new WorkspaceRuntime(config, ledger);
  const native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "a",
  });
  const app = createApp(config, ledger, runtime, token);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: {
      origin: config.publicOrigin,
      "content-type": "application/json",
    },
    payload: { token },
  });
  const headers = {
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    origin: config.publicOrigin,
    "content-type": "application/json",
  };
  const send = (
    operationId: string,
    kind = "change_profile",
    profileId = "b",
    expectedProfileId = "a",
    expectedProfileRevision = 0,
    text?: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/sessions/${record.id}/operations`,
      headers,
      payload: {
        operationId,
        kind,
        profileId: kind === "change_profile" ? profileId : undefined,
        expectedProfileId:
          kind === "change_profile" ? expectedProfileId : undefined,
        expectedProfileRevision:
          kind === "change_profile" ? expectedProfileRevision : undefined,
        ...(text ? { text } : {}),
      },
    });
  return {
    dir,
    config,
    ledger,
    runtime,
    record,
    app,
    send,
    restoreEnv: () => {
      if (priorArgvJournal === undefined)
        delete process.env.FAKE_PI_ARGV_JOURNAL;
      else process.env.FAKE_PI_ARGV_JOURNAL = priorArgvJournal;
    },
    dispose: async () => {
      await app.close();
      await runtime.shutdown().catch(() => undefined);
      ledger.close();
      if (priorArgvJournal === undefined)
        delete process.env.FAKE_PI_ARGV_JOURNAL;
      else process.env.FAKE_PI_ARGV_JOURNAL = priorArgvJournal;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("session profile failure admission", () => {
  it("rejects invalid targets, stale CAS, and busy sessions without replacing the runtime", async () => {
    const dir = await mkdtemp(join(root, "matrix-"));
    const cwd = join(dir, "project"),
      sessionDir = join(cwd, ".pi", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1:1",
      dataDir: join(dir, "data"),
      piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
      projects: [{ id: "p", name: "P", cwd, sessionDir }],
      profiles: [
        {
          id: "a",
          name: "A",
          provider: "fake",
          model: "fake-model",
          thinking: "low",
        },
        {
          id: "b",
          name: "B",
          provider: "fake",
          model: "fake-model",
          thinking: "low",
        },
      ],
    };
    const ledger = await Ledger.open(config.dataDir),
      runtime = new WorkspaceRuntime(config, ledger);
    const native = await createNative(config.projects[0]!);
    const record = ledger.createSession({
      nativeFile: native.file,
      nativeId: native.id,
      projectId: "p",
      profileId: "a",
    });
    const app = createApp(config, ledger, runtime, token);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        origin: config.publicOrigin,
        "content-type": "application/json",
      },
      payload: { token },
    });
    const headers = {
      cookie: String(login.headers["set-cookie"]).split(";")[0]!.split(";")[0],
      origin: config.publicOrigin,
      "content-type": "application/json",
    };
    const send = (
      operationId: string,
      profileId: string,
      expectedProfileId = "a",
      expectedProfileRevision = 0,
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId,
          kind: "change_profile",
          profileId,
          expectedProfileId,
          expectedProfileRevision,
        },
      });
    try {
      const invalid = await send(
        "123e4567-e89b-42d3-a456-426614174020",
        "missing",
      );
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("invalid_profile");
      const stale = await send(
        "123e4567-e89b-42d3-a456-426614174021",
        "b",
        "a",
        9,
      );
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("profile_conflict");
      const busy = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId: "123e4567-e89b-42d3-a456-426614174022",
          kind: "prompt",
          text: "hold:release-gate",
        },
      });
      expect(busy.statusCode).toBe(202);
      const refused = await send("123e4567-e89b-42d3-a456-426614174023", "b");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe("session_busy");
      expect(ledger.session(record.id)).toMatchObject({
        profileId: "a",
        profileRevision: 0,
      });
      expect(runtime.snapshot(ledger.session(record.id)!)).toMatchObject({
        runtimeState: "running",
      });
      const duplicate = await send(
        "123e4567-e89b-42d3-a456-426614174020",
        "missing",
      );
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json().status).toBe("REJECTED");
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an old runtime blocked when its close fails and does not start a candidate", async () => {
    const f = await fixture("close-failure");
    const close = vi
      .spyOn(PiRpc.prototype, "close")
      .mockRejectedValue(new Error("close failed"));
    try {
      await f.runtime.ensure(f.record);
      const journal = join(f.dir, "argv.jsonl");
      await f.send("123e4567-e89b-42d3-a456-426614174030");
      expect(close).toHaveBeenCalled();
      expect(
        f.ledger.operation("123e4567-e89b-42d3-a456-426614174030")?.status,
      ).toBe("UNKNOWN");
      expect(f.ledger.session(f.record.id)).toMatchObject({
        profileId: "a",
        profileRevision: 0,
      });
      expect(f.runtime.snapshot(f.ledger.session(f.record.id)!)).toMatchObject({
        runtimeState: "blocked",
      });
      expect(
        (await readFile(journal, "utf8")).trim().split(/\r?\n/),
      ).toHaveLength(1);
    } finally {
      close.mockRestore();
      await f.dispose();
    }
  });

  it.each([
    ["model", "wrong-model"],
    ["provider", "wrong-provider"],
    ["thinking", "wrong-thinking"],
    ["identity", "wrong-identity"],
  ])("rejects candidate get_state mismatch for %s", async (field, value) => {
    const f = await fixture(`candidate-${field}`);
    await f.runtime.ensure(f.record);
    let hit = false;
    let stateCalls = 0;
    const original = PiRpc.prototype.command;
    const spy = vi
      .spyOn(PiRpc.prototype, "command")
      .mockImplementation(async function (name, params, timeout) {
        const result = await original.call(this, name, params, timeout);
        if (name === "get_state" && ++stateCalls === 4) {
          hit = true;
          const state = result.data as Record<string, unknown>;
          if (field === "model")
            (state.model as Record<string, unknown>).id = value;
          if (field === "provider")
            (state.model as Record<string, unknown>).provider = value;
          if (field === "thinking") state.thinkingLevel = value;
          if (field === "identity") state.sessionId = value;
        }
        return result;
      });
    try {
      await f.send(
        `123e4567-e89b-42d3-a456-42661417403${["model", "provider", "thinking", "identity"].indexOf(field) + 1}`,
      );
      expect(hit).toBe(true);
      expect(
        f.ledger.operation(
          `123e4567-e89b-42d3-a456-42661417403${["model", "provider", "thinking", "identity"].indexOf(field) + 1}`,
        )?.status,
      ).toBe("UNKNOWN");
      expect(f.ledger.session(f.record.id)?.profileId).toBe("a");
      expect(f.runtime.snapshot(f.ledger.session(f.record.id)!)).toMatchObject({
        runtimeState: "blocked",
      });
      await expect(
        f.runtime.operation(f.ledger.session(f.record.id)!, {
          kind: "prompt",
          text: "must reject",
        } as never),
      ).rejects.toThrow("session_profile_blocked");
    } finally {
      spy.mockRestore();
      await f.dispose();
    }
  });

  it("records a candidate RPC timeout as UNKNOWN without waiting for the RPC deadline", async () => {
    const f = await fixture("candidate-timeout");
    await f.runtime.ensure(f.record);
    let states = 0;
    const original = PiRpc.prototype.command;
    const spy = vi
      .spyOn(PiRpc.prototype, "command")
      .mockImplementation(function (name, params, timeout) {
        if (name === "get_state" && ++states === 3)
          return Promise.reject(new RpcError("rpc_timeout", true));
        return original.call(this, name, params, timeout);
      });
    try {
      await f.send("123e4567-e89b-42d3-a456-426614174040");
      expect(states).toBe(3);
      expect(
        f.ledger.operation("123e4567-e89b-42d3-a456-426614174040")?.status,
      ).toBe("UNKNOWN");
    } finally {
      spy.mockRestore();
      await f.dispose();
    }
  });

  it("keeps storage commit failure UNKNOWN and blocks writes after reopening", async () => {
    const f = await fixture("storage-failure");
    const commit = vi
      .spyOn(f.ledger, "commitProfileChange")
      .mockImplementation(() => {
        throw new Error("storage_error");
      });
    try {
      await f.runtime.ensure(f.record);
      await f.send("123e4567-e89b-42d3-a456-426614174041");
      expect(commit).toHaveBeenCalledOnce();
      expect(
        f.ledger.operation("123e4567-e89b-42d3-a456-426614174041")?.status,
      ).toBe("UNKNOWN");
      expect(f.ledger.session(f.record.id)?.profileId).toBe("a");
    } finally {
      commit.mockRestore();
    }
    await f.app.close();
    await f.runtime.shutdown();
    f.ledger.close();
    const reopened = await Ledger.open(f.config.dataDir),
      runtime = new WorkspaceRuntime(f.config, reopened);
    try {
      const current = reopened.session(f.record.id)!;
      expect(runtime.snapshot(current).runtimeState).toBe("blocked");
      await expect(
        runtime.operation(current, {
          kind: "prompt",
          text: "must reject",
        } as never),
      ).rejects.toThrow("session_profile_blocked");
    } finally {
      await runtime.shutdown();
      reopened.close();
      f.restoreEnv();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("retains candidate control after cleanup failure without publishing its profile", async () => {
    const f = await fixture("candidate-cleanup-failure");
    await f.runtime.ensure(f.record);
    const published: Record<string, unknown>[] = [];
    const unsubscribe = f.runtime.subscribe(f.record.id, (event) => {
      const data = (event as { data?: Record<string, unknown> }).data;
      if ((event as { type?: string }).type === "snapshot" && data)
        published.push(data);
    });
    const oldRpc = (
      f.runtime as unknown as { live: Map<string, { rpc: PiRpc }> }
    ).live.get(f.record.id)!.rpc;
    const originalCommand = PiRpc.prototype.command;
    const originalClose = PiRpc.prototype.close;
    const candidateRpcs = new Set<PiRpc>();
    let candidateStates = 0;
    let candidateCloseAttempts = 0;
    let finalProofHit = false;
    const command = vi
      .spyOn(PiRpc.prototype, "command")
      .mockImplementation(async function (name, params, timeout) {
        if (this !== oldRpc) candidateRpcs.add(this);
        const result = await originalCommand.call(this, name, params, timeout);
        if (
          this !== oldRpc &&
          name === "get_state" &&
          ++candidateStates === 2
        ) {
          finalProofHit = true;
          (result.data as Record<string, unknown>).sessionId = "wrong-session";
        }
        return result;
      });
    const close = vi
      .spyOn(PiRpc.prototype, "close")
      .mockImplementation(async function () {
        if (candidateRpcs.has(this) && candidateCloseAttempts++ === 0)
          throw new Error("candidate close failed");
        return originalClose.call(this);
      });
    try {
      await f.send("123e4567-e89b-42d3-a456-426614174043");
      expect(finalProofHit).toBe(true);
      expect(candidateCloseAttempts).toBe(1);
      expect(
        (
          f.runtime as unknown as { live: Map<string, { rpc: PiRpc }> }
        ).live.get(f.record.id)?.rpc,
      ).toBeDefined();
      expect(
        candidateRpcs.has(
          (
            f.runtime as unknown as { live: Map<string, { rpc: PiRpc }> }
          ).live.get(f.record.id)!.rpc,
        ),
      ).toBe(true);
      expect(
        f.ledger.operation("123e4567-e89b-42d3-a456-426614174043")?.status,
      ).toBe("UNKNOWN");
      expect(f.ledger.session(f.record.id)).toMatchObject({
        profileId: "a",
        profileRevision: 0,
      });
      expect(f.runtime.snapshot(f.ledger.session(f.record.id)!)).toMatchObject({
        profileId: "a",
        runtimeState: "blocked",
      });
      expect(
        published.every(
          (snapshot) =>
            snapshot.profileId !== "b" && snapshot.actualModel !== "model-b",
        ),
      ).toBe(true);
      await expect(
        WriterLease.acquire(f.record.nativeFile + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      command.mockRestore();
      await f.runtime.shutdown();
      expect(candidateCloseAttempts).toBe(2);
      close.mockRestore();
      const lease = await WriterLease.acquire(
        f.record.nativeFile + ".prw.lock",
      );
      await lease.close();
    } finally {
      unsubscribe();
      command.mockRestore();
      close.mockRestore();
      await f.dispose();
    }
  });

  it("ignores old runtime events after a successful switch", async () => {
    const f = await fixture("old-event");
    const rpcInstances: PiRpc[] = [];
    const original = PiRpc.prototype.command;
    const spy = vi
      .spyOn(PiRpc.prototype, "command")
      .mockImplementation(function (name, params, timeout) {
        if (!rpcInstances.length && name === "get_state")
          rpcInstances.push(this);
        return original.call(this, name, params, timeout);
      });
    try {
      await f.runtime.ensure(f.record);
      const response = await f.send("123e4567-e89b-42d3-a456-426614174042");
      expect(response.statusCode).toBe(202);
      expect(
        f.ledger.operation("123e4567-e89b-42d3-a456-426614174042")?.status,
      ).toBe("ACCEPTED");
      expect(f.runtime.snapshot(f.ledger.session(f.record.id)!)).toMatchObject({
        profileId: "b",
        runtimeState: "idle",
      });
      spy.mockRestore();
      const before = f.runtime.snapshot(f.ledger.session(f.record.id)!);
      rpcInstances[0]!.emit("event", { type: "agent_start" });
      rpcInstances[0]!.emit("failure", "late_old_failure");
      expect(f.runtime.snapshot(f.ledger.session(f.record.id)!)).toEqual(
        before,
      );
    } finally {
      spy.mockRestore();
      await f.dispose();
    }
  });
});
