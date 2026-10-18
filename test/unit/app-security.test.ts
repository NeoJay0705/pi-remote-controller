import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("app-security");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("HTTP auth and strict request boundaries", () => {
  it("requires authentication, exact Origin, JSON and rejects extra schema keys", async () => {
    const dir = await mkdtemp(join(root, "http-"));
    dirs.push(dir);
    const config: WorkspaceConfig = {
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: dir,
      piCli: "/unused",
      projects: [],
      profiles: [],
    };
    const ledger = await Ledger.open(dir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const token = "owner-token-".repeat(4);
    const app = createApp(config, ledger, runtime, token);
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/projects" }))
          .statusCode,
      ).toBe(401);
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: "http://attacker.invalid",
          "content-type": "application/json",
        },
        payload: { token },
      });
      expect(rejected.statusCode).toBe(403);
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers["set-cookie"];
      expect(typeof cookie).toBe("string");
      const extra = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
          cookie: String(cookie).split(";")[0],
        },
        payload: { projectId: "p", profileId: "f", arbitrary: true },
      });
      expect(extra.statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/projects",
            headers: { cookie: String(cookie).split(";")[0] },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });

  it("rejects encoded, normalized and traversal request targets without leaking files or API data", async () => {
    const dir = await mkdtemp(join(root, "http-"));
    dirs.push(dir);
    const config: WorkspaceConfig = {
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: dir,
      piCli: "/unused",
      projects: [],
      profiles: [],
    };
    const ledger = await Ledger.open(dir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const token = "owner-token-".repeat(4);
    const app = createApp(config, ledger, runtime, token);
    const urls = [
      "/api/v1/projects",
      "/%61pi/v1/projects",
      "/api%2fv1%2fprojects",
      "//api/v1/projects",
      "/assets/../../package.json",
      "/assets/%2e%2e/%2e%2e/package.json",
      "/assets/..%2f..%2fpackage.json",
      "/assets/%252e%252e%252fpackage.json",
      "/assets/../api/v1/projects",
    ];
    try {
      for (const url of urls) {
        const response = await app.inject({ method: "GET", url });
        const body = response.body;
        if (url === "/api/v1/projects") {
          expect(response.statusCode, url).toBe(401);
        } else {
          expect([400, 401, 403, 404], url).toContain(response.statusCode);
        }
        expect(body, url).not.toContain('"name":"pi-remote-controller"');
        expect(body, url).not.toContain('"version":"0.1.0"');
        expect(body, url).not.toBe("[]");
      }
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });

  it("applies auth and CSRF checks to encoded API routes", async () => {
    const dir = await mkdtemp(join(root, "http-"));
    dirs.push(dir);
    const config: WorkspaceConfig = {
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: dir,
      piCli: "/unused",
      projects: [],
      profiles: [],
    };
    const ledger = await Ledger.open(dir);
    const runtime = new WorkspaceRuntime(config, ledger);
    const token = "owner-token-".repeat(4);
    const app = createApp(config, ledger, runtime, token);
    const headers = {
      origin: config.publicOrigin,
      "content-type": "application/json",
    };
    try {
      const login = await app.inject({
        method: "POST",
        url: "/%61pi/v1/auth/login",
        headers,
        payload: { token },
      });
      expect(login.statusCode).toBe(200);
      expect(typeof login.headers["set-cookie"]).toBe("string");
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      expect(ledger.sessions()).toEqual([]);

      const badOriginLogin = await app.inject({
        method: "POST",
        url: "/%61pi/v1/auth/login",
        headers: { ...headers, origin: "http://attacker.invalid" },
        payload: { token },
      });
      expect(badOriginLogin.statusCode).toBe(403);
      expect(ledger.sessions()).toEqual([]);

      const badTypeLogin = await app.inject({
        method: "POST",
        url: "/%61pi/v1/auth/login",
        headers: { ...headers, "content-type": "text/plain" },
        payload: JSON.stringify({ token }),
      });
      expect(badTypeLogin.statusCode).toBe(415);
      expect(ledger.sessions()).toEqual([]);

      const noCookie = await app.inject({
        method: "POST",
        url: "/%61pi/v1/sessions",
        headers,
        payload: {},
      });
      expect(noCookie.statusCode).toBe(401);
      expect(ledger.sessions()).toEqual([]);

      const badOrigin = await app.inject({
        method: "POST",
        url: "/%61pi/v1/sessions",
        headers: { ...headers, origin: "http://attacker.invalid", cookie },
        payload: {},
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(ledger.sessions()).toEqual([]);

      const badType = await app.inject({
        method: "POST",
        url: "/%61pi/v1/sessions",
        headers: { ...headers, "content-type": "text/plain", cookie },
        payload: "{}",
      });
      expect(badType.statusCode).toBe(415);
      expect(ledger.sessions()).toEqual([]);

      expect(
        (await app.inject({ method: "GET", url: "/%61pi/v1/auth/me" }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/%61pi/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(ledger.sessions()).toEqual([]);
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
});
