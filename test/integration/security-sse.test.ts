import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("security-sse");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("auth isolation and SSE lifecycle", () => {
  it("isolates login cookies per app and streams a snapshot before disconnect cleanup", async () => {
    const dir = await mkdtemp(join(root, "sse-"));
    dirs.push(dir);
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1:1",
      dataDir: dir,
      piCli: "/unused",
      projects: [],
      profiles: [],
    };
    const ledger = await Ledger.open(dir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const session = ledger.createSession({
      nativeFile: join(dir, "session.jsonl"),
      nativeId: "native",
      projectId: "p",
      profileId: "f",
    });
    const token = "synthetic-owner-token-0123456789abcdef";
    const first = createApp(config, ledger, runtime, token),
      second = createApp(config, ledger, runtime, token);
    try {
      const login = await first.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      expect(
        (
          await second.inject({
            method: "GET",
            url: "/api/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
      await first.listen({ host: "127.0.0.1", port: 0 });
      const address = first.server.address();
      if (!address || typeof address === "string")
        throw new Error("test_listener_unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      config.publicOrigin = base;
      const other = ledger.createSession({
        nativeFile: join(dir, "other.jsonl"),
        nativeId: "other-native",
        projectId: "p",
        profileId: "f",
      });
      const operation = {
        operationId: "123e4567-e89b-42d3-a456-426614174000",
        kind: "prompt",
        text: "synthetic",
      };
      const operationHeaders = {
        origin: base,
        "content-type": "application/json",
        cookie,
      };
      const original = await fetch(
        `${base}/api/v1/sessions/${session.id}/operations`,
        {
          method: "POST",
          headers: operationHeaders,
          body: JSON.stringify(operation),
        },
      );
      expect(original.status).toBe(400);
      const crossTarget = await fetch(
        `${base}/api/v1/sessions/${other.id}/operations`,
        {
          method: "POST",
          headers: operationHeaders,
          body: JSON.stringify(operation),
        },
      );
      expect(crossTarget.status).toBe(409);
      const controller = new AbortController();
      const response = await fetch(
        `${base}/api/v1/sessions/${session.id}/events`,
        { headers: { cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("sse_stream_missing");
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain(
        '"type":"snapshot"',
      );
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      const active = await fetch(
        `${base}/api/v1/sessions/${session.id}/events`,
        { headers: { cookie } },
      );
      const activeReader = active.body?.getReader();
      if (!activeReader) throw new Error("sse_stream_missing");
      await activeReader.read();
      await first.close();
      expect((await activeReader.read()).done).toBe(true);
      expect(
        (
          await second.inject({
            method: "GET",
            url: "/api/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await first.close().catch(() => undefined);
      await second.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
});
