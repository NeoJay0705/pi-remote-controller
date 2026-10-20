import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const root = testRoot("native-discovery");
const token = "owner-token-1234567890123456789012345678901234567890";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("native session discovery", () => {
  it("lists only unjoined files, preserves history, rejects duplicates, and never starts Pi on GET", async () => {
    const dir = await mkdtemp(join(root, "case-"));
    dirs.push(dir);
    const cwd = join(dir, "project"),
      sessionDir = join(cwd, ".pi/sessions");
    await mkdir(sessionDir, { recursive: true });
    const joinedId = randomUUID(),
      unjoinedId = randomUUID();
    const joinedFile = join(sessionDir, `${joinedId}.jsonl`),
      unjoinedFile = join(sessionDir, `${unjoinedId}.jsonl`);
    const header = (id: string) =>
      `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`;
    const joinedBytes = `${header(joinedId)}${JSON.stringify({ type: "message", id: "history-entry", parentId: null, message: { role: "user", content: "unchanged history" } })}\n`;
    await writeFile(joinedFile, joinedBytes, { mode: 0o600 });
    await writeFile(unjoinedFile, header(unjoinedId), { mode: 0o600 });
    const unjoinedFileUpdatedAt = new Date("2020-01-02T03:04:05Z");
    await utimes(unjoinedFile, unjoinedFileUpdatedAt, unjoinedFileUpdatedAt);
    const config: WorkspaceConfig = {
      port: 0,
      publicOrigin: "http://127.0.0.1",
      dataDir: join(dir, "data"),
      piCli: "/unused",
      projects: [{ id: "p", name: "P", cwd, sessionDir }],
      profiles: [{ id: "f", name: "F" }],
    };
    const ledger = await Ledger.open(config.dataDir);
    ledger.createSession({
      nativeFile: joinedFile,
      nativeId: joinedId,
      projectId: "p",
      profileId: "f",
    });
    const runtime = new WorkspaceRuntime(config, ledger),
      app = createApp(config, ledger, runtime, token);
    try {
      expect(token.length).toBeGreaterThanOrEqual(48);
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
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/projects/p/native-sessions",
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([
        {
          file: unjoinedFile,
          id: unjoinedId,
          nameInfo: { status: "unnamed" },
          fileUpdatedAt: unjoinedFileUpdatedAt.getTime(),
        },
      ]);
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
          cookie,
        },
        payload: { projectId: "p", profileId: "f", nativeFile: joinedFile },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(await readFile(joinedFile, "utf8")).toBe(joinedBytes);
      expect(runtime.snapshot(ledger.sessions()[0]!).runtimeState).toBe(
        "released",
      );
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
});
