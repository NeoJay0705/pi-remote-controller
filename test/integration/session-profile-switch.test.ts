import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { WriterLease } from "../../src/server/lease.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("session-profile-switch");
const token = "profile-switch-test-token-12345678901234567890";

describe("session profile switch", () => {
  it("cold saves the configured profile without spawning Pi or changing history; reopen preserves it", async () => {
    const dir = await mkdtemp(join(root, "cold-"));
    const cwd = join(dir, "project"),
      sessionDir = join(cwd, ".pi", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const journal = join(dir, "journal");
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
          extensions: ["synthetic-extension"],
          tools: ["read"],
          appendSystemPrompts: ["synthetic prompt"],
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
    const before = await readFile(native.file);
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
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const headers = {
      cookie,
      origin: config.publicOrigin,
      "content-type": "application/json",
    };
    const priorJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_JOURNAL = journal;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId: "123e4567-e89b-42d3-a456-426614174001",
          kind: "change_profile",
          profileId: "b",
          expectedProfileId: "a",
          expectedProfileRevision: 0,
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        status: "ACCEPTED",
        result: {
          status: "profile_saved",
          profileId: "b",
          profileRevision: 1,
          verified: false,
        },
      });
      expect(ledger.session(record.id)).toMatchObject({
        profileId: "b",
        profileRevision: 1,
      });
      expect(await readFile(native.file)).toEqual(before);
      expect(await readFile(journal, "utf8").catch(() => "")).toBe("");
      ledger.close();
      const reopened = await Ledger.open(config.dataDir);
      expect(reopened.session(record.id)).toMatchObject({
        profileId: "b",
        profileRevision: 1,
      });
      reopened.close();
    } finally {
      if (priorJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = priorJournal;
      await app.close();
      await runtime.shutdown();
      try {
        ledger.close();
      } catch {
        /* already closed before reopen assertion */
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restarts an active session with the complete target argv, same lease, and preserved history", async () => {
    const dir = await mkdtemp(join(root, "active-"));
    const cwd = join(dir, "project"),
      sessionDir = join(cwd, ".pi", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const argvJournal = join(dir, "argv.jsonl");
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
          extensions: ["ext-one", "ext-two"],
          tools: ["read", "write"],
          appendSystemPrompts: ["system sentinel"],
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
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const headers = {
      cookie,
      origin: config.publicOrigin,
      "content-type": "application/json",
    };
    const priorJournal = process.env.FAKE_PI_ARGV_JOURNAL;
    process.env.FAKE_PI_ARGV_JOURNAL = argvJournal;
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    let gapProbeHits = 0;
    try {
      const prompt = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId: "123e4567-e89b-42d3-a456-426614174010",
          kind: "prompt",
          text: "fast",
        },
      });
      expect(prompt.statusCode).toBe(202);
      const historyBefore = (await readFile(native.file, "utf8"))
        .trim()
        .split("\n");
      const noOp = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId: "123e4567-e89b-42d3-a456-426614174013",
          kind: "change_profile",
          profileId: "a",
          expectedProfileId: "a",
          expectedProfileRevision: 0,
        },
      });
      expect(noOp.statusCode).toBe(202);
      expect(noOp.json().result).toMatchObject({
        status: "profile_unchanged",
        verified: true,
      });
      await expect(
        (await import("../../src/server/lease.js")).WriterLease.acquire(
          native.file + ".prw.lock",
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
      const oldLive = await runtime.ensure(ledger.session(record.id)!);
      const oldLease = oldLive.lease;
      const oldFd = oldLease.fd;
      const originalClose = oldLive.rpc.close.bind(oldLive.rpc);
      closeSpy = vi.spyOn(oldLive.rpc, "close").mockImplementation(async () => {
        await originalClose();
        gapProbeHits += 1;
        await expect(
          WriterLease.acquire(native.file + ".prw.lock"),
        ).rejects.toMatchObject({ statusCode: 423 });
      });
      const switchPayload = {
        operationId: "123e4567-e89b-42d3-a456-426614174011",
        kind: "change_profile",
        profileId: "b",
        expectedProfileId: "a",
        expectedProfileRevision: 0,
      };
      const switchResult = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: switchPayload,
      });
      expect(switchResult.statusCode).toBe(202);
      expect(switchResult.json()).toMatchObject({
        status: "ACCEPTED",
        result: {
          status: "profile_applied",
          profileId: "b",
          profileRevision: 1,
          verified: true,
        },
      });
      expect(gapProbeHits).toBe(1);
      const newLive = await runtime.ensure(ledger.session(record.id)!);
      expect(newLive.lease).toBe(oldLease);
      expect(newLive.lease.fd).toBe(oldFd);
      const successfulReceipt = switchResult.json();
      expect(successfulReceipt.status).toBe("ACCEPTED");
      const receiptUrl = `/api/v1/operations/${switchPayload.operationId}`;
      const retrievedReceipt = await app.inject({
        method: "GET",
        url: receiptUrl,
        headers,
      });
      expect(retrievedReceipt.statusCode).toBe(200);
      expect(retrievedReceipt.json()).toEqual(successfulReceipt);
      const launchesBeforeDuplicate = (await readFile(argvJournal, "utf8"))
        .trim()
        .split("\n");
      const historyBeforeDuplicate = await readFile(native.file);
      // Simulate discarding the first response; this does not simulate network loss.
      const duplicate = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: switchPayload,
      });
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toEqual(successfulReceipt);
      expect(
        await app
          .inject({ method: "GET", url: receiptUrl, headers })
          .then((r) => r.json()),
      ).toEqual(successfulReceipt);
      expect(await readFile(native.file)).toEqual(historyBeforeDuplicate);
      expect((await readFile(argvJournal, "utf8")).trim().split("\n")).toEqual(
        launchesBeforeDuplicate,
      );
      const latest = ledger.session(record.id)!;
      expect(runtime.snapshot(latest)).toMatchObject({
        profileId: "b",
        profileRevision: 1,
        runtimeState: "idle",
        actualProvider: "provider-b",
        actualModel: "model-b",
        actualThinking: "high",
      });
      const launches = (await readFile(argvJournal, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; pid: number; argv?: string[] },
        );
      const spawned = launches.filter((line) => line.event === "spawn");
      const exited = launches.filter((line) => line.event === "exit");
      expect(spawned).toHaveLength(2);
      expect(exited.some((line) => line.pid === spawned[0]!.pid)).toBe(true);
      const conflictingPayload = {
        ...switchPayload,
        profileId: "a",
      };
      const conflict = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: conflictingPayload,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("operation_conflict");
      const launchesAfterDuplicate = (await readFile(argvJournal, "utf8"))
        .trim()
        .split("\n")
        .filter(
          (line) => (JSON.parse(line) as { event: string }).event === "spawn",
        );
      expect(launchesAfterDuplicate).toHaveLength(2);
      const oldExit = launches.findIndex(
        (line) => line.event === "exit" && line.pid === spawned[0]!.pid,
      );
      const newSpawn = launches.findIndex(
        (line) => line.event === "spawn" && line.pid === spawned[1]!.pid,
      );
      expect(oldExit).toBeGreaterThan(-1);
      expect(newSpawn).toBeGreaterThan(oldExit);
      const argv = spawned[1]!.argv!;
      const value = (name: string) => argv[argv.indexOf(name) + 1];
      expect(value("--provider")).toBe("provider-b");
      expect(value("--model")).toBe("model-b");
      expect(value("--thinking")).toBe("high");
      expect(value("--tools")).toBe("read,write");
      expect(argv.filter((arg) => arg === "-e")).toHaveLength(2);
      expect(argv.slice(argv.indexOf("-e"))).toEqual([
        "-e",
        "ext-one",
        "-e",
        "ext-two",
        "--tools",
        "read,write",
        "--append-system-prompt",
        "system sentinel",
      ]);
      await expect(
        (await import("../../src/server/lease.js")).WriterLease.acquire(
          native.file + ".prw.lock",
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
      const continued = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers,
        payload: {
          operationId: "123e4567-e89b-42d3-a456-426614174012",
          kind: "prompt",
          text: "fast",
        },
      });
      expect(continued.statusCode).toBe(202);
      const historyAfter = (await readFile(native.file, "utf8"))
        .trim()
        .split("\n");
      expect(historyAfter.slice(0, historyBefore.length)).toEqual(
        historyBefore,
      );
    } finally {
      closeSpy?.mockRestore();
      if (priorJournal === undefined) delete process.env.FAKE_PI_ARGV_JOURNAL;
      else process.env.FAKE_PI_ARGV_JOURNAL = priorJournal;
      await app.close();
      await runtime.shutdown();
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
