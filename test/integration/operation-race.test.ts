import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("operation-race");
const token = "operation-race-owner-token-0123456789abcdef";
const releaseId = "123e4567-e89b-12d3-a456-426614174010";
const promptId = "123e4567-e89b-12d3-a456-426614174011";

describe("HTTP operation ownership race", () => {
  it("rejects a prompt queued behind a completed release", async () => {
    const dir = await mkdtemp(join(root, "operation-race-"));
    const projectDir = join(dir, "project");
    const sessionDir = join(projectDir, ".pi", "sessions");
    const journal = join(dir, "fake-command-journal");
    await mkdir(sessionDir, { recursive: true });
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1:1",
      dataDir: join(dir, "data"),
      piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
      projects: [{ id: "p", name: "Synthetic", cwd: projectDir, sessionDir }],
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
    const priorJournal = process.env.FAKE_PI_JOURNAL;
    process.env.FAKE_PI_JOURNAL = journal;
    const ledger = await Ledger.open(config.dataDir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const app = createApp(config, ledger, runtime, token);
    let enteredRelease!: () => void;
    let enteredPrompt!: () => void;
    let openRelease!: () => void;
    const releaseEntered = new Promise<void>((resolveEntered) => {
      enteredRelease = resolveEntered;
    });
    const releaseGate = new Promise<void>((resolveGate) => {
      openRelease = resolveGate;
    });
    const promptObserved = new Promise<void>((resolvePrompt) => {
      enteredPrompt = resolvePrompt;
    });
    const originalOperation = runtime.operation;
    let recordId = "";
    try {
      app.addHook("preHandler", async (request) => {
        if (
          request.method === "POST" &&
          request.url === `/api/v1/sessions/${recordId}/operations` &&
          (request.body as { kind?: unknown } | undefined)?.kind === "prompt"
        )
          enteredPrompt();
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("test_listener_unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      config.publicOrigin = base;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const headers = {
        origin: base,
        "content-type": "application/json",
        cookie: cookie ?? "",
      };
      const created = await fetch(`${base}/api/v1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "p", profileId: "f" }),
      });
      expect(created.status).toBe(201);
      const session = (await created.json()) as { id: string };
      recordId = session.id;
      const record = ledger.session(recordId);
      if (!record) throw new Error("session_missing");
      await runtime.ensure(record);
      expect(runtime.snapshot(record).runtimeState).toBe("idle");
      expect(
        (await readFile(journal, "utf8")).split("\n").filter(Boolean),
      ).not.toContain("prompt");

      runtime.operation = async function (currentRecord, input, operationId) {
        if (input.kind === "release") {
          enteredRelease();
          await releaseGate;
        }
        return originalOperation.call(this, currentRecord, input, operationId);
      };

      const releaseRequest = fetch(
        `${base}/api/v1/sessions/${recordId}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ operationId: releaseId, kind: "release" }),
        },
      );
      await releaseEntered;
      const promptRequest = fetch(
        `${base}/api/v1/sessions/${recordId}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: promptId,
            kind: "prompt",
            text: "must-not-reach-released-owner",
          }),
        },
      );
      await promptObserved;
      openRelease();
      const [release, prompt] = await Promise.all([
        releaseRequest,
        promptRequest,
      ]);
      expect(release.status).toBe(202);
      expect(prompt.status).toBe(409);
      expect(await prompt.json()).toMatchObject({
        error: { code: "owner_mismatch" },
      });
      expect(ledger.session(recordId)?.desiredOwner).toBe("tui");
      expect(runtime.snapshot(ledger.session(recordId)!).runtimeState).toBe(
        "released",
      );
      const lease = await (
        await import("../../src/server/lease.js")
      ).WriterLease.acquire(`${record.nativeFile}.prw.lock`);
      await lease.close();
      expect(
        (await readFile(journal, "utf8"))
          .split("\n")
          .filter(Boolean)
          .filter((line) => line === "prompt"),
      ).toHaveLength(0);
    } finally {
      openRelease();
      runtime.operation = originalOperation;
      await app.close();
      await runtime.shutdown();
      ledger.close();
      if (priorJournal === undefined) delete process.env.FAKE_PI_JOURNAL;
      else process.env.FAKE_PI_JOURNAL = priorJournal;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
