import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("http-runtime");

describe("HTTP to synthetic Pi RPC", () => {
  it("creates a native session, accepts a prompt, releases and claims a writer", async () => {
    const dir = await mkdtemp(join(root, "e2e-"));
    const projectDir = join(dir, "project");
    const sessionDir = join(projectDir, ".pi", "sessions");
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
    const ledger = await Ledger.open(config.dataDir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const app = createApp(
      config,
      ledger,
      runtime,
      "synthetic-owner-token-0123456789abcdef",
    );
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("test_listener_unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      config.publicOrigin = base;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          token: "synthetic-owner-token-0123456789abcdef",
        }),
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
      const operationId = "123e4567-e89b-12d3-a456-426614174000";
      const prompt = await fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId,
            kind: "prompt",
            text: "Unicode 世界",
          }),
        },
      );
      expect(prompt.status).toBe(202);
      expect(
        ((await prompt.json()) as { result: { status: string } }).result.status,
      ).toBe("accepted");
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      const listedBefore = await fetch(`${base}/api/v1/runtimes`, {
        headers: { cookie: cookie ?? "" },
      });
      expect(listedBefore.status).toBe(200);
      expect(await listedBefore.json()).toMatchObject([
        {
          id: session.id,
          runtimeState: "idle",
          releaseEligible: true,
          cwd: projectDir,
        },
      ]);
      const release = await fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "123e4567-e89b-12d3-a456-426614174001",
            kind: "release",
          }),
        },
      );
      expect(release.status).toBe(202);
      const afterRelease = await fetch(`${base}/api/v1/runtimes`, {
        headers: { cookie: cookie ?? "" },
      });
      expect(afterRelease.status).toBe(200);
      expect(await afterRelease.json()).toEqual([]);
      expect(ledger.session(session.id)?.desiredOwner).toBe("tui");
      const claim = await fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "123e4567-e89b-12d3-a456-426614174002",
            kind: "claim",
          }),
        },
      );
      expect(claim.status).toBe(202);
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks a session when in-flight release receipt storage fails", async () => {
    const dir = await mkdtemp(join(root, "release-storage-"));
    const projectDir = join(dir, "project");
    const sessionDir = join(projectDir, ".pi", "sessions");
    const abortGate = join(dir, "abort.gate");
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
    const previousAbortGate = process.env.FAKE_PI_ABORT_GATE;
    process.env.FAKE_PI_ABORT_GATE = abortGate;
    const ledger = await Ledger.open(config.dataDir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const app = createApp(
      config,
      ledger,
      runtime,
      "synthetic-owner-token-0123456789abcdef",
    );
    let finishSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("test_listener_unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      config.publicOrigin = base;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          token: "synthetic-owner-token-0123456789abcdef",
        }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const headers = {
        origin: base,
        "content-type": "application/json",
        cookie,
      };
      const created = await fetch(`${base}/api/v1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "p", profileId: "f" }),
      });
      const session = (await created.json()) as { id: string };
      const stopPending = fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "123e4567-e89b-42d3-a456-426614174010",
            kind: "stop",
          }),
        },
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const originalFinish = ledger.finish.bind(ledger);
      finishSpy = vi
        .spyOn(ledger, "finish")
        .mockImplementation((id, status, result) => {
          if (status === "REJECTED") throw new Error("storage_error");
          return originalFinish(id, status, result);
        });
      const release = await fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operationId: "123e4567-e89b-42d3-a456-426614174011",
            kind: "release",
          }),
        },
      );
      expect(release.status).toBe(500);
      expect(await release.json()).toEqual({
        error: { code: "storage_error", message: "Request failed" },
      });
      expect(runtime.snapshot(ledger.session(session.id)!).runtimeState).toBe(
        "blocked",
      );
      expect(runtime.snapshot(ledger.session(session.id)!).lastError).toBe(
        "storage_error",
      );
      await writeFile(abortGate, "go");
      await stopPending;
    } finally {
      finishSpy?.mockRestore();
      await writeFile(abortGate, "go").catch(() => undefined);
      await app.close();
      await runtime.shutdown();
      ledger.close();
      if (previousAbortGate === undefined)
        delete process.env.FAKE_PI_ABORT_GATE;
      else process.env.FAKE_PI_ABORT_GATE = previousAbortGate;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
