import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
