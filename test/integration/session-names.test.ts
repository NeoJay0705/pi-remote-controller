import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const token = "owner-token-1234567890123456789012345678901234567890";
describe("session naming HTTP contract", () => {
  it("validates before create, creates a persistent native name, and projects names without starting Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-name-api-"));
    roots.push(root);
    const cwd = join(root, "project"),
      sessionDir = join(cwd, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1",
      dataDir: join(root, "data"),
      piCli: "/not-started",
      projects: [{ id: "p", name: "P", cwd, sessionDir }],
      profiles: [{ id: "f", name: "F" }],
    };
    const ledger = await Ledger.open(config.dataDir),
      runtime = new WorkspaceRuntime(config, ledger),
      app = createApp(config, ledger, runtime, token);
    try {
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
      const post = (payload: unknown) =>
        app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          headers: {
            origin: config.publicOrigin,
            "content-type": "application/json",
            cookie,
          },
          payload,
        });
      expect(
        (await post({ projectId: "p", profileId: "f", name: "bad\nname" }))
          .statusCode,
      ).toBe(400);
      expect(await readdir(sessionDir)).toEqual([]);
      expect(
        (await post({ projectId: "p", profileId: "f", name: "😀".repeat(129) }))
          .statusCode,
      ).toBe(400);
      const named = await post({
        projectId: "p",
        profileId: "f",
        name: "  中文工作 🚀  ",
      });
      expect(named.statusCode).toBe(201);
      const created = named.json() as {
        id: string;
        nativeId: string;
        nativeFile: string;
        nameInfo: unknown;
      };
      expect(created.nameInfo).toEqual({
        status: "named",
        name: "中文工作 🚀",
      });
      expect(
        (await readFile(created.nativeFile, "utf8")).split("\n")[1],
      ).toContain("中文工作 🚀");
      const emoji = await post({
        projectId: "p",
        profileId: "f",
        name: "😀".repeat(128),
      });
      expect(emoji.statusCode).toBe(201);
      const unnamed = await post({ projectId: "p", profileId: "f" });
      expect(unnamed.statusCode).toBe(201);
      expect(unnamed.json().nameInfo).toEqual({ status: "unnamed" });
      const before = await readFile(created.nativeFile);
      const refused = await post({
        projectId: "p",
        profileId: "f",
        nativeFile: created.nativeFile,
        name: "",
      });
      expect(refused.statusCode).toBe(400);
      expect(await readFile(created.nativeFile)).toEqual(before);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: { cookie },
      });
      expect(list.json()[0].nameInfo).toEqual({
        status: "named",
        name: "中文工作 🚀",
      });
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${created.id}/snapshot`,
        headers: { cookie },
      });
      expect(snapshot.json()).toMatchObject({
        nativeId: created.nativeId,
        nameInfo: { status: "named", name: "中文工作 🚀" },
        runtimeState: "released",
      });
      expect(runtime.snapshot(ledger.sessions()[0]!).runtimeState).toBe(
        "released",
      );
      const candidateId = randomUUID(),
        candidateFile = join(sessionDir, `${candidateId}.jsonl`);
      await writeFile(
        candidateFile,
        `${JSON.stringify({ type: "session", version: 3, id: candidateId, cwd })}\n${JSON.stringify({ type: "session_info", id: "i", parentId: null, name: "候選名稱" })}\n`,
      );
      const candidates = await app.inject({
        method: "GET",
        url: "/api/v1/projects/p/native-sessions",
        headers: { cookie },
      });
      expect(candidates.json()).toContainEqual({
        file: candidateFile,
        id: candidateId,
        nameInfo: { status: "named", name: "候選名稱" },
      });
      const candidateHash = createHash("sha256")
        .update(await readFile(candidateFile))
        .digest("hex");
      const imported = await post({
        projectId: "p",
        profileId: "f",
        nativeFile: candidateFile,
      });
      expect(imported.statusCode).toBe(201);
      expect(
        createHash("sha256")
          .update(await readFile(candidateFile))
          .digest("hex"),
      ).toBe(candidateHash);
      const candidateSession = imported.json() as {
        nativeId: string;
        nativeFile: string;
      };
      const lines = (await readFile(candidateFile, "utf8")).split("\n");
      const changedHeader = JSON.parse(lines[0]!) as Record<string, unknown>;
      changedHeader.id = randomUUID();
      lines[0] = JSON.stringify(changedHeader);
      await writeFile(candidateSession.nativeFile, lines.join("\n"));
      const mismatched = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: { cookie },
      });
      expect(
        mismatched
          .json()
          .find(
            (session: { nativeId: string }) =>
              session.nativeId === candidateSession.nativeId,
          ).nameInfo,
      ).toEqual({ status: "error", code: "native_id_mismatch" });
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
  it("re-derives the same name and native ID after reopening the ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-name-reopen-"));
    roots.push(root);
    const cwd = join(root, "project"),
      sessionDir = join(cwd, "sessions"),
      dataDir = join(root, "data");
    await mkdir(sessionDir, { recursive: true });
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1",
      dataDir,
      piCli: "/not-started",
      projects: [{ id: "p", name: "P", cwd, sessionDir }],
      profiles: [{ id: "f", name: "F" }],
    };
    let ledger = await Ledger.open(dataDir);
    let runtime = new WorkspaceRuntime(config, ledger);
    let app = createApp(config, ledger, runtime, token);
    let cookie = "";
    let originalIdentity: { id: string; nativeId: string } | undefined;
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
          cookie,
        },
        payload: { projectId: "p", profileId: "f", name: "重新開啟仍在" },
      });
      expect(created.statusCode).toBe(201);
      originalIdentity = created.json() as { id: string; nativeId: string };
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
    ledger = await Ledger.open(dataDir);
    runtime = new WorkspaceRuntime(config, ledger);
    app = createApp(config, ledger, runtime, token);
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const sessions = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: { cookie },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json()).toHaveLength(1);
      expect(sessions.json()[0]).toMatchObject({
        id: originalIdentity!.id,
        nativeId: originalIdentity!.nativeId,
        nameInfo: { status: "named", name: "重新開啟仍在" },
      });
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
});
