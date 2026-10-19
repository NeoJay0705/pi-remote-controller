import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { WriterLease } from "../../src/server/lease.js";
import { PiRpc } from "../../src/server/rpc.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("session-profile-guards");
const token = "profile-guards-test-token-12345678901234567890";
const id = (n: number) =>
  `123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, "0")}`;

type TestLive = { rpc: PiRpc; snapshot: { runtimeState: string } };
type RuntimeInternals = { live: Map<string, TestLive> };

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
  const priorArgv = process.env.FAKE_PI_ARGV_JOURNAL;
  const priorJournal = process.env.FAKE_PI_JOURNAL;
  process.env.FAKE_PI_ARGV_JOURNAL = join(dir, "argv.jsonl");
  process.env.FAKE_PI_JOURNAL = join(dir, "journal.jsonl");
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
  const operationWatchers: Array<() => void> = [];
  app.addHook("preHandler", async (request) => {
    if (request.url.endsWith("/operations")) operationWatchers.shift()?.();
  });
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
  const send = (operationId: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/sessions/${record.id}/operations`,
      headers,
      payload: {
        operationId,
        kind: "change_profile",
        profileId: "b",
        expectedProfileId: "a",
        expectedProfileRevision: 0,
      },
    });
  const restoreEnv = () => {
    if (priorArgv === undefined) delete process.env.FAKE_PI_ARGV_JOURNAL;
    else process.env.FAKE_PI_ARGV_JOURNAL = priorArgv;
    if (priorJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
    else process.env.FAKE_PI_JOURNAL = priorJournal;
  };
  return {
    dir,
    config,
    ledger,
    runtime,
    record,
    app,
    headers,
    send,
    watchOperationRequest: () =>
      new Promise<void>((resolve) => operationWatchers.push(resolve)),
    live: () => (runtime as unknown as RuntimeInternals).live.get(record.id),
    restoreEnv,
    dispose: async () => {
      await app.close();
      await runtime.shutdown().catch(() => undefined);
      ledger.close();
      restoreEnv();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const cases = [
  "queue",
  "dialog",
  "compacting",
  "starting",
  "releasing",
  "blocked",
  "TUI desiredOwner",
  "cold competing lease",
] as const;
describe("session profile unsafe-state refusal guards", () => {
  it.each(cases)(
    "rejects a profile switch while %s is established",
    async (condition) => {
      const f = await fixture(condition.replaceAll(" ", "-"));
      let lease: WriterLease | undefined;
      let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
      const abortCalls: string[] = [];
      const originalCommand = PiRpc.prototype.command;
      const commandSpy = vi
        .spyOn(PiRpc.prototype, "command")
        .mockImplementation(async function (name, params, timeout) {
          if (condition === "compacting" && name === "get_state") {
            const result = await originalCommand.call(
              this,
              name,
              params,
              timeout,
            );
            (result.data as Record<string, unknown>).isCompacting = true;
            return result;
          }
          if (name === "abort") abortCalls.push(name);
          return originalCommand.call(this, name, params, timeout);
        });
      try {
        if (condition !== "cold competing lease")
          await f.runtime.ensure(f.record);
        if (condition === "queue") {
          f.live()!.rpc.emit("event", {
            type: "queue_update",
            steering: ["pending"],
            followUp: [],
          });
          expect(f.runtime.snapshot(f.record).queue).toHaveLength(1);
        } else if (condition === "dialog") {
          f.live()!.rpc.emit("event", {
            type: "extension_ui_request",
            id: "confirm-1",
            method: "confirm",
            title: "Confirm?",
          });
          expect(f.runtime.snapshot(f.record).pendingDialogs).toHaveLength(1);
        } else if (condition === "compacting") {
          expect((await f.live()!.rpc.command("get_state")).data).toMatchObject(
            { isCompacting: true },
          );
        } else if (["starting", "releasing", "blocked"].includes(condition)) {
          f.live()!.snapshot.runtimeState = condition;
          expect(f.runtime.snapshot(f.record).runtimeState).toBe(condition);
        } else if (condition === "TUI desiredOwner") {
          f.ledger.setOwner(f.record.id, "tui");
          expect(f.ledger.session(f.record.id)?.desiredOwner).toBe("tui");
        } else {
          lease = await WriterLease.acquire(f.record.nativeFile + ".prw.lock");
          expect(lease).toBeDefined();
        }
        if (condition !== "cold competing lease") {
          closeSpy = vi.spyOn(PiRpc.prototype, "close");
        }
        const response = await f.send(id(1));
        expect(response.statusCode).toBe(
          condition === "cold competing lease" ? 423 : 409,
        );
        expect(f.ledger.operation(id(1))?.status).toBe("REJECTED");
        expect(f.ledger.session(f.record.id)).toMatchObject({
          profileId: "a",
          profileRevision: 0,
        });
        if (closeSpy) expect(closeSpy).not.toHaveBeenCalled();
        expect(abortCalls).toEqual([]);
        const argv = await readFile(join(f.dir, "argv.jsonl"), "utf8").catch(
          () => "",
        );
        expect(argv.trim() ? argv.trim().split(/\r?\n/) : []).toHaveLength(
          condition === "cold competing lease" ? 0 : 1,
        );
        if (lease)
          await expect(
            WriterLease.acquire(f.record.nativeFile + ".prw.lock"),
          ).rejects.toMatchObject({ statusCode: 423 });
        else if (condition !== "cold competing lease")
          await expect(
            WriterLease.acquire(f.record.nativeFile + ".prw.lock"),
          ).rejects.toMatchObject({ statusCode: 423 });
      } finally {
        closeSpy?.mockRestore();
        commandSpy.mockRestore();
        await lease?.close();
        await f.dispose();
      }
    },
  );

  it("rejects admission during a prompt tail even when the runtime snapshot is idle", async () => {
    const f = await fixture("admission-race");
    const original = PiRpc.prototype.command;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptSpy = vi
      .spyOn(PiRpc.prototype, "command")
      .mockImplementation(async function (name, params, timeout) {
        const result = await original.call(this, name, params, timeout);
        if (name === "prompt") {
          enter();
          await gate;
        }
        return result;
      });
    try {
      await f.runtime.ensure(f.record);
      const prompt = f.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${f.record.id}/operations`,
        headers: f.headers,
        payload: { operationId: id(2), kind: "prompt", text: "fast" },
      });
      await entered;
      expect(f.runtime.snapshot(f.record).runtimeState).toBe("idle");
      const enteredRequest = f.watchOperationRequest();
      const switching = f.send(id(3));
      await enteredRequest;
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      const [promptResponse, switchResponse] = await Promise.all([
        prompt,
        switching,
      ]);
      expect(promptResponse.statusCode).toBe(202);
      expect(switchResponse.statusCode).toBe(409);
      expect(f.ledger.operation(id(3))?.status).toBe("REJECTED");
      expect(f.ledger.session(f.record.id)).toMatchObject({
        profileId: "a",
        profileRevision: 0,
      });
      const snapshots: Record<string, unknown>[] = [];
      const unsubscribe = f.runtime.subscribe(f.record.id, (event) => {
        const value = event as {
          type?: string;
          data?: Record<string, unknown>;
        };
        if (value.type === "snapshot" && value.data) snapshots.push(value.data);
      });
      try {
        const normalSwitch = await f.send(id(4));
        expect(normalSwitch.statusCode).toBe(202);
        expect(snapshots).toContainEqual(
          expect.objectContaining({ runtimeState: "reconfiguring" }),
        );
        expect(snapshots).not.toContainEqual(
          expect.objectContaining({ lastError: "profile_switch_unconfirmed" }),
        );
      } finally {
        unsubscribe();
      }
    } finally {
      release();
      promptSpy.mockRestore();
      await f.dispose();
    }
  });
});
