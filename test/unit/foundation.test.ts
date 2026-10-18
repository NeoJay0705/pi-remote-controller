import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { loadConfig } from "../../src/server/config.js";
import { Ledger } from "../../src/server/store.js";
import { validateNative } from "../../src/server/native-sessions.js";
import { WriterLease } from "../../src/server/lease.js";
import type { Project } from "../../src/shared/contracts.js";

const root = testRoot("foundation");
const dirs: string[] = [];
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(root, prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("foundation regressions", () => {
  it("rolls back failed schema migration and rejects unsupported versions", async () => {
    const dir = await temp("migration-");
    const db = new DatabaseSync(join(dir, "ledger.sqlite"));
    db.exec(
      "CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES(9); PRAGMA user_version=9;",
    );
    db.close();
    await expect(Ledger.open(dir)).rejects.toThrow("storage_error");
    const verify = new DatabaseSync(join(dir, "ledger.sqlite"));
    expect(
      verify
        .prepare("SELECT name FROM sqlite_master WHERE name='sessions'")
        .get(),
    ).toBeUndefined();
    expect(verify.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 9,
    });
    verify.close();
  });
  it("rolls back partial migration DDL when schema validation fails", async () => {
    const dir = await temp("rollback-");
    const db = new DatabaseSync(join(dir, "ledger.sqlite"));
    db.exec(
      "CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES(1),(1); PRAGMA user_version=1;",
    );
    db.close();
    await expect(Ledger.open(dir)).rejects.toThrow("storage_error");
    const verify = new DatabaseSync(join(dir, "ledger.sqlite"));
    expect(
      verify
        .prepare("SELECT name FROM sqlite_master WHERE name='sessions'")
        .get(),
    ).toBeUndefined();
    verify.close();
  });
  it("does not recover dispatched receipts in readonly mode and hashes target plus canonical payload", async () => {
    const dir = await temp("ledger-");
    const ledger = await Ledger.open(dir);
    const one = ledger.createSession({
      nativeFile: join(dir, "one.jsonl"),
      nativeId: "n1",
      projectId: "p",
      profileId: "f",
    });
    const two = ledger.createSession({
      nativeFile: join(dir, "two.jsonl"),
      nativeId: "n2",
      projectId: "p",
      profileId: "f",
    });
    expect(() =>
      ledger.createSession({
        nativeFile: join(dir, "one.jsonl"),
        nativeId: "duplicate",
        projectId: "p",
        profileId: "f",
      }),
    ).toThrow("native_session_exists");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(ledger.begin(one.id, "prompt", id, { b: 2, a: 1 }).fresh).toBe(true);
    expect(ledger.begin(one.id, "prompt", id, { a: 1, b: 2 }).fresh).toBe(
      false,
    );
    expect(() => ledger.begin(two.id, "prompt", id, { a: 1, b: 2 })).toThrow(
      "operation_conflict",
    );
    ledger.close();
    const readonly = await Ledger.open(dir, { readOnly: true, recover: false });
    expect(readonly.operation(id)?.status).toBe("DISPATCHED");
    readonly.close();
    const recovered = await Ledger.open(dir);
    expect(recovered.operation(id)?.status).toBe("UNKNOWN");
    recovered.close();
  });
  it("returns only active-branch entries and permits a partial UTF-8 tail", async () => {
    const dir = await temp("native-");
    const project: Project = { id: "p", name: "p", cwd: dir, sessionDir: dir };
    const file = join(dir, "session.jsonl");
    const head = { type: "session", version: 3, id: "native-id", cwd: dir };
    const rows = [
      head,
      { type: "message", id: "a", parentId: null, content: "old" },
      { type: "message", id: "a2", parentId: "a", content: "old branch" },
      { type: "message", id: "b", parentId: null, content: "active" },
      { type: "message", id: "b2", parentId: "b", content: "active leaf" },
    ];
    await writeFile(
      file,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const validated = await validateNative(file, project);
    expect(validated.entries.map((entry) => entry.id)).toEqual([
      "native-id",
      "b",
      "b2",
    ]);
    await writeFile(
      file,
      `${JSON.stringify(head)}\n${JSON.stringify({ id: "x", parentId: "missing", type: "message" })}\n`,
    );
    await expect(validateNative(file, project)).rejects.toThrow(
      "native_parent_missing",
    );
    await writeFile(
      file,
      `${JSON.stringify(head)}\n${JSON.stringify(rows[1])}\n${Buffer.from([0xe2, 0x82])}`,
    );
    expect((await validateNative(file, project)).syncing).toBe(true);
  });
  it("rejects extra config fields, relative data paths, and origin components", async () => {
    const dir = await temp("config-");
    const project = join(dir, "project"),
      sessions = join(dir, "sessions");
    await mkdir(project);
    await mkdir(sessions);
    const cli = join(dir, "pi");
    await writeFile(cli, "synthetic");
    const file = join(dir, "config.json");
    const base = {
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: join(dir, "data"),
      piCli: cli,
      projects: [{ id: "p", name: "P", cwd: project, sessionDir: sessions }],
      profiles: [{ id: "f", name: "F" }],
    };
    await writeFile(file, JSON.stringify(base));
    await expect(loadConfig(file)).resolves.toMatchObject({
      projects: [{ id: "p" }],
    });
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        projectDiscovery: { root: "relative", sessionRoot: sessions },
      }),
    );
    await expect(loadConfig(file)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...base, unknown: true }));
    await expect(loadConfig(file)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...base, dataDir: "relative" }));
    await expect(loadConfig(file)).rejects.toThrow();
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        publicOrigin: "http://user@127.0.0.1:4317/path",
      }),
    );
    await expect(loadConfig(file)).rejects.toThrow();
  });
  it("validates project discovery boundaries and permits an empty static project list", async () => {
    const dir = await temp("discovery-config-");
    const discovery = join(dir, "repos");
    await mkdir(discovery);
    const cli = join(dir, "pi");
    await writeFile(cli, "synthetic");
    const file = join(dir, "config.json");
    const base = {
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: join(dir, "data"),
      piCli: cli,
      projects: [],
      profiles: [{ id: "f", name: "F" }],
    };
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        projectDiscovery: {
          root: discovery,
          sessionRoot: join(dir, "private", "sessions"),
        },
      }),
    );
    await expect(loadConfig(file)).resolves.toMatchObject({
      projects: [],
      projectDiscovery: { root: discovery },
    });
    for (const projectDiscovery of [
      null,
      {},
      { root: "relative", sessionRoot: join(dir, "sessions") },
      { root: discovery },
      { root: cli, sessionRoot: join(dir, "sessions") },
      { root: "/", sessionRoot: join(dir, "sessions") },
    ]) {
      await writeFile(file, JSON.stringify({ ...base, projectDiscovery }));
      await expect(loadConfig(file)).rejects.toThrow();
    }
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        projectDiscovery: { root: discovery, sessionRoot: null },
      }),
    );
    await expect(loadConfig(file)).rejects.toThrow();
  });
  it("classifies Linux lease contention separately", async () => {
    const dir = await temp("lease-");
    const path = join(dir, "session.lock");
    const first = await WriterLease.acquire(path);
    try {
      await expect(WriterLease.acquire(path)).rejects.toMatchObject({
        message: "writer_locked",
        statusCode: 423,
      });
    } finally {
      await first.close();
    }
  });
});
