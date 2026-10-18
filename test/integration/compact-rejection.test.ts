import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { PiRpc } from "../../src/server/rpc.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";
const root = testRoot("compact-rejection"),
  dirs: string[] = [];
let compactCommands = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  if (process.env.FAKE_PI_MODE?.startsWith("compact-"))
    delete process.env.FAKE_PI_MODE;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function make(mode: string) {
  const dir = await mkdtemp(join(root, "case-"));
  dirs.push(dir);
  const cwd = join(dir, "project"),
    sessionDir = join(cwd, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects: [{ id: "p", name: "P", cwd, sessionDir }],
    profiles: [
      {
        id: "f",
        name: "F",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      },
    ],
  };
  const ledger = await Ledger.open(config.dataDir),
    runtime = new WorkspaceRuntime(config, ledger),
    native = await createNative(config.projects[0]!);
  const session = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  const app = createApp(
    config,
    ledger,
    runtime,
    "compact-test-token-123456789012345678901234567890",
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: {
      origin: config.publicOrigin,
      "content-type": "application/json",
    },
    payload: { token: "compact-test-token-123456789012345678901234567890" },
  });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  process.env.FAKE_PI_MODE = mode;
  compactCommands = 0;
  const command = PiRpc.prototype.command;
  vi.spyOn(PiRpc.prototype, "command").mockImplementation(function (
    this: PiRpc,
    name,
    params,
    timeoutMs,
  ) {
    if (name === "compact") compactCommands++;
    return command.call(
      this,
      name,
      params,
      name === "compact" || (name === "get_state" && compactCommands > 0)
        ? 80
        : timeoutMs,
    );
  });
  return { config, ledger, runtime, app, session, cookie };
}
describe("compact rejection safety", () => {
  it.each(["compact-reject", "compact-too-small", "compact-already-compacted"])(
    "records a definite rejection and resumes only after idle state confirmation (%s)",
    async (mode) => {
      const s = await make(mode);
      try {
        const operationId = "123e4567-e89b-42d3-a456-426614174201";
        const historyBefore = await readFile(
          s.ledger.session(s.session.id)!.nativeFile,
        );
        const response = await s.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${s.session.id}/operations`,
          headers: {
            cookie: s.cookie,
            origin: s.config.publicOrigin,
            "content-type": "application/json",
          },
          payload: { operationId, kind: "compact" },
        });
        expect(response.statusCode).toBe(409);
        expect(response.body).not.toContain("RAW_COMPACT_REJECTION_SENTINEL");
        expect(response.body).not.toContain("RAW_TOO_SMALL_SENTINEL");
        expect(response.body).not.toContain("RAW_ALREADY_COMPACTED_SENTINEL");
        expect(s.ledger.operation(operationId)?.status).toBe("REJECTED");
        expect(s.runtime.snapshot(s.session).runtimeState).toBe("idle");
        expect(s.runtime.snapshot(s.session).lastError).toBe(
          "compact_rejected",
        );
        const repeated = await s.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${s.session.id}/operations`,
          headers: {
            cookie: s.cookie,
            origin: s.config.publicOrigin,
            "content-type": "application/json",
          },
          payload: { operationId, kind: "compact" },
        });
        expect(repeated.statusCode).toBe(202);
        expect(compactCommands).toBe(1);
        expect(
          await readFile(s.ledger.session(s.session.id)!.nativeFile),
        ).toEqual(historyBefore);
        const prompt = await s.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${s.session.id}/operations`,
          headers: {
            cookie: s.cookie,
            origin: s.config.publicOrigin,
            "content-type": "application/json",
          },
          payload: {
            operationId: "123e4567-e89b-42d3-a456-426614174202",
            kind: "prompt",
            text: "continue",
          },
        });
        expect(prompt.statusCode).toBe(202);
      } finally {
        await s.app.close();
        await s.runtime.shutdown();
        s.ledger.close();
      }
    },
  );
  it.each([
    "compact-reject-busy",
    "compact-state-unavailable",
    "compact-timeout",
  ])("blocks unconfirmed rejection (%s)", async (mode) => {
    const s = await make(mode);
    try {
      const operationId = "123e4567-e89b-42d3-a456-426614174203";
      const response = await s.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${s.session.id}/operations`,
        headers: {
          cookie: s.cookie,
          origin: s.config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { operationId, kind: "compact" },
      });
      expect(response.statusCode).toBe(503);
      expect(s.ledger.operation(operationId)?.status).toBe("UNKNOWN");
      expect(s.runtime.snapshot(s.session).runtimeState).toBe("blocked");
      await expect(
        import("../../src/server/lease.js").then(({ WriterLease }) =>
          WriterLease.acquire(s.session.nativeFile + ".prw.lock"),
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
    } finally {
      await s.app.close();
      await s.runtime.shutdown();
      s.ledger.close();
    }
  });
});
