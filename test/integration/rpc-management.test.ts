import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WriterLease } from "../../src/server/lease.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { Ledger, type SessionRecord } from "../../src/server/store.js";
import type {
  Project,
  RuntimeSession,
  WorkspaceConfig,
} from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("rpc-management");
const token = "rpc-management-test-token-12345678901234567890";
const ids = {
  release: "123e4567-e89b-42d3-a456-426614174100",
  duplicate: "123e4567-e89b-42d3-a456-426614174101",
  prompt: "123e4567-e89b-42d3-a456-426614174102",
  compact: "123e4567-e89b-42d3-a456-426614174103",
  profile: "123e4567-e89b-42d3-a456-426614174104",
  racedRelease: "123e4567-e89b-42d3-a456-426614174105",
  failedRelease: "123e4567-e89b-42d3-a456-426614174106",
};

async function fixture(projectCount = 1) {
  const dir = await mkdtemp(join(root, "case-"));
  const projects: Project[] = [];
  for (let index = 0; index < projectCount; index++) {
    const cwd = join(dir, `project-${index + 1}`);
    const sessionDir = join(cwd, ".pi", "sessions");
    await mkdir(sessionDir, { recursive: true });
    projects.push({
      id: `p${index + 1}`,
      name: `Project ${index + 1}`,
      cwd,
      sessionDir,
    });
  }
  const journal = join(dir, "rpc-journal");
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects,
    profiles: [
      {
        id: "f",
        name: "Fake",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      },
    ],
  };
  const previousJournal = process.env.FAKE_PI_JOURNAL;
  process.env.FAKE_PI_JOURNAL = journal;
  const ledger = await Ledger.open(config.dataDir);
  const runtime = new WorkspaceRuntime(config, ledger);
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
  const makeRecord = async (
    project: Project,
    name: string,
  ): Promise<SessionRecord> => {
    const native = await createNative(project, name);
    return ledger.createSession({
      nativeFile: native.file,
      nativeId: native.id,
      projectId: project.id,
      profileId: "f",
    });
  };
  const cleanup = async () => {
    await app.close();
    await runtime.shutdown();
    ledger.close();
    if (previousJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
    else process.env.FAKE_PI_JOURNAL = previousJournal;
    await rm(dir, { recursive: true, force: true });
  };
  return {
    dir,
    journal,
    config,
    projects,
    ledger,
    runtime,
    app,
    headers,
    makeRecord,
    cleanup,
  };
}

async function start(
  f: Awaited<ReturnType<typeof fixture>>,
  record: SessionRecord,
) {
  await f.runtime.ensure(record);
  return f.runtime.ensure(record);
}

async function postOperation(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  operationId: string,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  return f.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/operations`,
    headers: f.headers,
    payload: { operationId, kind, ...extra },
  });
}

describe("RPC runtime management HTTP acceptance", () => {
  it("authenticates listing and rejects a release with a wrong Origin", async () => {
    const f = await fixture();
    try {
      const record = await f.makeRecord(f.projects[0]!, "Protected");
      await start(f, record);
      const unauthenticated = await f.app.inject({
        method: "GET",
        url: "/api/v1/runtimes",
      });
      expect(unauthenticated.statusCode).toBe(401);
      const rejected = await f.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${record.id}/operations`,
        headers: {
          cookie: f.headers.cookie,
          origin: "http://attacker.invalid",
          "content-type": "application/json",
        },
        payload: { operationId: ids.release, kind: "release" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(f.runtime.snapshot(record).runtimeState).toBe("idle");
    } finally {
      await f.cleanup();
    }
  });

  it("lists managed runtimes across projects without spawning, and marks blocked or unavailable rows ineligible", async () => {
    const f = await fixture(3);
    try {
      const first = await f.makeRecord(f.projects[0]!, "First project runtime");
      const second = await f.makeRecord(
        f.projects[1]!,
        "Second project runtime",
      );
      const blocked = await f.makeRecord(f.projects[0]!, "Blocked runtime");
      const missing = await f.makeRecord(
        f.projects[2]!,
        "Missing project runtime",
      );
      const released = await f.makeRecord(f.projects[1]!, "Released runtime");
      await Promise.all([
        start(f, first),
        start(f, second),
        start(f, blocked),
        start(f, missing),
        start(f, released),
      ]);
      await f.runtime.block(blocked.id, "synthetic_block");
      const release = await postOperation(
        f,
        released.id,
        ids.release,
        "release",
      );
      expect(release.statusCode).toBe(202);
      f.config.projects = f.config.projects.filter(
        (project) => project.id !== missing.projectId,
      );
      const spawnsBefore = (await readFile(f.journal, "utf8"))
        .split("\n")
        .filter((line) => line === "get_state").length;
      const response = await f.app.inject({
        method: "GET",
        url: "/api/v1/runtimes",
        headers: { cookie: f.headers.cookie },
      });
      expect(response.statusCode).toBe(200);
      const rows = response.json() as RuntimeSession[];
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            nameInfo: { status: "named", name: "First project runtime" },
            cwd: f.projects[0]!.cwd,
            runtimeState: "idle",
            releaseEligible: true,
          }),
          expect.objectContaining({
            id: second.id,
            nameInfo: { status: "named", name: "Second project runtime" },
            cwd: f.projects[1]!.cwd,
            runtimeState: "idle",
            releaseEligible: true,
          }),
          expect.objectContaining({
            id: blocked.id,
            releaseEligible: false,
            releaseBlockedReason: "runtime_not_idle",
          }),
          expect.objectContaining({
            id: missing.id,
            releaseEligible: false,
            releaseBlockedReason: "cwd_unavailable",
          }),
        ]),
      );
      expect(rows.some((row) => row.id === released.id)).toBe(false);
      const spawnsAfter = (await readFile(f.journal, "utf8"))
        .split("\n")
        .filter((line) => line === "get_state").length;
      expect(spawnsAfter).toBe(spawnsBefore);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    ["prompt", ids.prompt, { text: "fast" }],
    ["compact", ids.compact, {}],
    [
      "change_profile",
      ids.profile,
      { profileId: "f", expectedProfileId: "f", expectedProfileRevision: 0 },
    ],
  ] as const)(
    "rejects release immediately while a %s operation owns the HTTP tail",
    async (kind, operationId, extra) => {
      const f = await fixture();
      let entered!: () => void;
      let proceed!: () => void;
      const hasEntered = new Promise<void>((resolveEntered) => {
        entered = resolveEntered;
      });
      const gate = new Promise<void>((resolveGate) => {
        proceed = resolveGate;
      });
      const record = await f.makeRecord(f.projects[0]!, `Tail ${kind}`);
      const live = await start(f, record);
      const closeSpy = vi.spyOn(live.rpc, "close");
      const original = f.runtime.operation;
      f.runtime.operation = async function (current, input, currentId) {
        if (input.kind === kind) {
          entered();
          await gate;
        }
        return original.call(this, current, input, currentId);
      };
      try {
        const existing = postOperation(f, record.id, operationId, kind, extra);
        await hasEntered;
        const release = await postOperation(
          f,
          record.id,
          ids.racedRelease,
          "release",
        );
        expect(release.statusCode).toBe(409);
        expect(release.json()).toMatchObject({
          status: "REJECTED",
          result: { status: "rejected", reason: "operation_in_flight" },
        });
        expect(closeSpy).not.toHaveBeenCalled();
        proceed();
        expect((await existing).statusCode).toBe(202);
        expect(closeSpy).not.toHaveBeenCalled();
        await expect(
          WriterLease.acquire(record.nativeFile + ".prw.lock"),
        ).rejects.toMatchObject({ statusCode: 423 });
        expect(f.runtime.snapshot(record).runtimeState).toBe("idle");
        expect(f.runtime.releaseEligibility(record)).toBeUndefined();
        expect(
          await f.app.inject({
            method: "GET",
            url: "/api/v1/runtimes",
            headers: { cookie: f.headers.cookie },
          }),
        ).toHaveProperty("statusCode", 200);
        expect(f.ledger.session(record.id)?.desiredOwner).toBe("web");
      } finally {
        proceed();
        f.runtime.operation = original;
        closeSpy?.mockRestore();
        await f.cleanup();
      }
    },
  );

  it("deduplicates release, closes only its target, and preserves native history and the managed record", async () => {
    const f = await fixture();
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const target = await f.makeRecord(f.projects[0]!, "Release target");
      const survivor = await f.makeRecord(f.projects[0]!, "Survivor");
      const targetLive = await start(f, target);
      const survivorLive = await start(f, survivor);
      const bytesBefore = await readFile(target.nativeFile);
      let closeCount = 0;
      const actualClose = targetLive.rpc.close.bind(targetLive.rpc);
      closeSpy = vi
        .spyOn(targetLive.rpc, "close")
        .mockImplementation(async (...args) => {
          closeCount++;
          return actualClose(...args);
        });
      const first = await postOperation(f, target.id, ids.duplicate, "release");
      expect(first.statusCode).toBe(202);
      const receipt = first.json();
      const duplicate = await postOperation(
        f,
        target.id,
        ids.duplicate,
        "release",
      );
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toEqual(receipt);
      expect(closeCount).toBe(1);
      expect(f.ledger.session(target.id)?.desiredOwner).toBe("tui");
      expect(f.ledger.session(target.id)?.nativeFile).toBe(target.nativeFile);
      expect(await readFile(target.nativeFile)).toEqual(bytesBefore);
      expect(f.runtime.snapshot(target).runtimeState).toBe("released");
      expect(f.runtime.snapshot(survivor).runtimeState).toBe("idle");
      expect(survivorLive.rpc.child.exitCode).toBeNull();
      await expect(
        WriterLease.acquire(survivor.nativeFile + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      const targetLease = await WriterLease.acquire(
        target.nativeFile + ".prw.lock",
      );
      await targetLease.close();
    } finally {
      closeSpy?.mockRestore();
      await f.cleanup();
    }
  });

  it("records UNKNOWN and blocks the runtime when the real RPC close fails", async () => {
    const f = await fixture();
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const record = await f.makeRecord(f.projects[0]!, "Close failure target");
      const live = await start(f, record);
      closeSpy = vi
        .spyOn(live.rpc, "close")
        .mockRejectedValue(new Error("synthetic_close_failure"));
      const response = await postOperation(
        f,
        record.id,
        ids.failedRelease,
        "release",
      );
      expect(response.statusCode).toBe(500);
      const receipt = f.ledger.operation(ids.failedRelease);
      expect(receipt?.status).toBe("UNKNOWN");
      expect(f.runtime.snapshot(record)).toMatchObject({
        runtimeState: "blocked",
        lastError: "cleanup_incomplete",
      });
      expect(f.ledger.session(record.id)?.desiredOwner).toBe("web");
      closeSpy.mockRestore();
      closeSpy = undefined;
    } finally {
      closeSpy?.mockRestore();
      await f.cleanup();
    }
  });
});
