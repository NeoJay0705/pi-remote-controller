import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { WriterLease } from "../../src/server/lease.js";
import { createNative } from "../../src/server/native-sessions.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("lifecycle-acceptance");
async function eventually(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("eventually_timeout");
}
async function setup(fakeEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(root, `${randomUUID()}-`));
  const cwd = join(dir, "project"),
    sessionDir = join(cwd, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects: [{ id: "p", name: "p", cwd, sessionDir }],
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
  const ledger = await Ledger.open(config.dataDir),
    runtime = new WorkspaceRuntime(config, ledger),
    native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  return {
    dir,
    config,
    ledger,
    runtime,
    record,
    native,
    env: { ...process.env, ...fakeEnv },
  };
}
function joined(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );
}
async function processGone(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
  } catch {
    return true;
  }
}
describe("critical lifecycle acceptance", () => {
  it("retains the inherited writer lease after a real controller SIGKILL and recovers DISPATCHED without replay", async () => {
    const s = await setup({ FAKE_PI_SURVIVE_EOF: "1" });
    const ready = join(s.dir, "ready.json"),
      journal = join(s.dir, "journal");
    const env = { ...s.env, FAKE_PI_JOURNAL: journal };
    const controller = spawn(
      process.execPath,
      [resolve("test/fixtures/crash-controller.mjs")],
      {
        env: {
          ...env,
          FAKE_CONTROLLER_CONFIG: JSON.stringify(s.config),
          FAKE_CONTROLLER_SESSION: s.record.id,
          FAKE_CONTROLLER_OPERATION: randomUUID(),
          FAKE_CONTROLLER_READY: ready,
        },
        stdio: "ignore",
      },
    );
    const controllerClosed = joined(controller);
    let childPid = 0;
    try {
      await eventually(async () => {
        try {
          const x = JSON.parse(await readFile(ready, "utf8"));
          childPid = x.childPid;
          return childPid > 1;
        } catch {
          return false;
        }
      });
      controller.kill("SIGKILL");
      await controllerClosed;
      await expect(
        WriterLease.acquire(s.native.file + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(
        spawnSync(
          "/usr/bin/flock",
          ["-n", "-E", "73", s.native.file + ".prw.lock", "/usr/bin/true"],
          { stdio: "ignore" },
        ).status,
      ).toBe(73);
      await expect(
        s.runtime.operation(s.record, {
          kind: "claim",
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("released");
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* child may have exited */
      }
      await eventually(async () => processGone(childPid));
      childPid = 0;
      const recovered = await Ledger.open(s.config.dataDir);
      expect(
        recovered.operation(
          JSON.parse(await readFile(ready, "utf8")).operationId,
        )?.status,
      ).toBe("UNKNOWN");
      recovered.close();
      expect(
        (await readFile(journal, "utf8"))
          .split("\n")
          .filter((x) => x === "prompt"),
      ).toHaveLength(1);
      const probe = await WriterLease.acquire(s.native.file + ".prw.lock");
      await probe.close();
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.kill("SIGTERM");
        await controllerClosed;
      }
      if (childPid > 1 && !(await processGone(childPid))) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* child may have exited */
        }
        await eventually(async () => processGone(childPid));
        childPid = 0;
      }
      await s.runtime.shutdown().catch(() => undefined);
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);

  it("keeps storage-failed sessions blocked even when UNKNOWN fallback succeeds", async () => {
    const s = await setup(),
      app = createApp(
        s.config,
        s.ledger,
        s.runtime,
        "test-owner-token-0123456789abcdef",
      );
    const oldJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_JOURNAL = join(s.dir, "storage-journal");
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const a = app.server.address();
      if (!a || typeof a === "string") throw Error("no_listener");
      const base = `http://127.0.0.1:${a.port}`;
      s.config.publicOrigin = base;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ token: "test-owner-token-0123456789abcdef" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const headers = {
        origin: base,
        "content-type": "application/json",
        cookie,
      };
      const id = randomUUID();
      let failed = false;
      const finish = s.ledger.finish.bind(s.ledger);
      s.ledger.finish = ((op: string, status: string, result?: unknown) => {
        if (!failed && status === "ACCEPTED") {
          failed = true;
          throw new Error("storage_error");
        }
        return finish(op, status, result);
      }) as typeof s.ledger.finish;
      const response = await fetch(
        `${base}/api/v1/sessions/${s.record.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: id,
            kind: "prompt",
            text: "single",
          }),
        },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "storage_error", message: "Request failed" },
      });
      expect(s.ledger.operation(id)?.status).toBe("UNKNOWN");
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("blocked");
      const again = await fetch(
        `${base}/api/v1/sessions/${s.record.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: id,
            kind: "prompt",
            text: "single",
          }),
        },
      );
      expect(again.status).toBe(409);
      expect(
        (await readFile(process.env.FAKE_PI_JOURNAL!, "utf8"))
          .split("\n")
          .filter((x) => x === "prompt"),
      ).toHaveLength(1);
    } finally {
      if (oldJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = oldJournal;
      await app.close();
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);

  it("persists stop queue clearing while abort is gated and rejects concurrent work", async () => {
    const s = await setup();
    const gate = join(s.dir, "abort.gate");
    const old = process.env.FAKE_PI_ABORT_GATE,
      oldJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_ABORT_GATE = gate;
    process.env.FAKE_PI_JOURNAL = join(s.dir, "journal");
    try {
      await s.runtime.operation(s.record, {
        kind: "prompt",
        operationId: randomUUID(),
        text: "hold:never",
      });
      await s.runtime.operation(s.record, {
        kind: "steer",
        operationId: randomUUID(),
        text: "steer",
      });
      await s.runtime.operation(s.record, {
        kind: "follow_up",
        operationId: randomUUID(),
        text: "follow",
      });
      const id = randomUUID();
      s.ledger.begin(s.record.id, "stop", id, {
        kind: "stop",
        operationId: id,
      });
      const stop = s.runtime.operation(
        s.record,
        { kind: "stop", operationId: id },
        id,
      );
      await eventually(
        async () => s.ledger.operation(id)?.result !== undefined,
      );
      expect(s.ledger.operation(id)?.result).toMatchObject({
        status: "stopping",
        cleared: [
          { kind: "steer", text: "steer" },
          { kind: "follow_up", text: "follow" },
        ],
      });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("stopping");
      await expect(
        s.runtime.operation(s.record, {
          kind: "prompt",
          operationId: randomUUID(),
          text: "blocked",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        s.runtime.operation(s.record, {
          kind: "steer",
          operationId: randomUUID(),
          text: "too late",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await writeFile(gate, "");
      await stop;
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("idle");
      expect(
        (await readFile(join(s.dir, "journal"), "utf8"))
          .split("\n")
          .filter((x) => x === "abort"),
      ).toHaveLength(1);
    } finally {
      if (old === undefined) delete process.env.FAKE_PI_ABORT_GATE;
      else process.env.FAKE_PI_ABORT_GATE = old;
      if (oldJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = oldJournal;
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);

  it("returns the HTTP stop receipt for a repeated operation ID without aborting twice", async () => {
    const s = await setup();
    const gate = join(s.dir, "http-abort.gate"),
      journal = join(s.dir, "http-journal");
    const oldGate = process.env.FAKE_PI_ABORT_GATE,
      oldJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_ABORT_GATE = gate;
    process.env.FAKE_PI_JOURNAL = journal;
    const app = createApp(
      s.config,
      s.ledger,
      s.runtime,
      "test-owner-token-0123456789abcdef",
    );
    try {
      await s.runtime.operation(s.record, {
        kind: "prompt",
        operationId: randomUUID(),
        text: "hold:never",
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw Error("no_listener");
      const base = `http://127.0.0.1:${address.port}`;
      s.config.publicOrigin = base;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ token: "test-owner-token-0123456789abcdef" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const headers = {
        origin: base,
        "content-type": "application/json",
        cookie,
      };
      const id = randomUUID();
      const body = JSON.stringify({ operationId: id, kind: "stop" });
      const firstPending = fetch(
        `${base}/api/v1/sessions/${s.record.id}/operations`,
        { method: "POST", headers, body },
      );
      await eventually(
        async () => s.ledger.operation(id)?.result !== undefined,
      );
      await writeFile(gate, "go");
      const first = await firstPending;
      expect(first.status).toBe(202);
      const repeated = await fetch(
        `${base}/api/v1/sessions/${s.record.id}/operations`,
        { method: "POST", headers, body },
      );
      expect([200, 202]).toContain(repeated.status);
      expect(await repeated.json()).toMatchObject({ operationId: id });
      expect(
        (await readFile(journal, "utf8"))
          .split("\n")
          .filter((x) => x === "abort"),
      ).toHaveLength(1);
    } finally {
      if (oldGate === undefined) delete process.env.FAKE_PI_ABORT_GATE;
      else process.env.FAKE_PI_ABORT_GATE = oldGate;
      if (oldJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = oldJournal;
      await app.close();
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);

  it("blocks without sending abort when saving the stopping receipt fails", async () => {
    const s = await setup();
    const journal = join(s.dir, "journal"),
      oldJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_JOURNAL = journal;
    try {
      await s.runtime.operation(s.record, {
        kind: "prompt",
        operationId: randomUUID(),
        text: "hold:never",
      });
      const id = randomUUID();
      s.ledger.begin(s.record.id, "stop", id, {
        kind: "stop",
        operationId: id,
      });
      const save = s.ledger.saveResult.bind(s.ledger);
      s.ledger.saveResult = (() => {
        throw new Error("storage_error");
      }) as typeof s.ledger.saveResult;
      await expect(
        s.runtime.operation(s.record, { kind: "stop", operationId: id }, id),
      ).rejects.toThrow("storage_error");
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("blocked");
      await expect(
        WriterLease.acquire(s.native.file + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(
        (await readFile(journal, "utf8"))
          .split("\n")
          .filter((x) => x === "abort"),
      ).toHaveLength(0);
      s.ledger.saveResult = save;
    } finally {
      if (oldJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = oldJournal;
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);
});
