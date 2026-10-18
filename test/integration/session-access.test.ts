import { appendFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WriterLease } from "../../src/server/lease.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("session-access");
const token = "session-access-test-token-12345678901234567890";

async function make(options: { cwd?: string; owner?: "web" | "tui" } = {}) {
  const dir = await mkdtemp(join(root, "case-"));
  const cwd = options.cwd ?? join(dir, "project");
  const sessionDir = join(cwd, ".pi", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
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
  const ledger = await Ledger.open(config.dataDir);
  const runtime = new WorkspaceRuntime(config, ledger);
  const native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  if (options.owner === "tui") {
    ledger.setOwner(record.id, "tui");
    record.desiredOwner = "tui";
  }
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
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const headers = {
    cookie,
    origin: config.publicOrigin,
    "content-type": "application/json",
  };
  return { dir, config, ledger, runtime, record, app, headers };
}

async function operation(
  s: Awaited<ReturnType<typeof make>>,
  operationId: string,
  kind: string,
  text?: string,
) {
  return s.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${s.record.id}/operations`,
    headers: s.headers,
    payload: { operationId, kind, ...(text === undefined ? {} : { text }) },
  });
}

async function dispose(s: Awaited<ReturnType<typeof make>>): Promise<void> {
  try {
    await s.app.close();
  } finally {
    try {
      await s.runtime.shutdown();
    } finally {
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("session access runtime integration", () => {
  it("keeps read-only history access inert and reloads before the next prompt", async () => {
    const s = await make();
    const priorJournal = process.env.FAKE_PI_JOURNAL;
    const journal = join(s.dir, "rpc.log");
    process.env.FAKE_PI_JOURNAL = journal;
    try {
      const first = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174301",
        "prompt",
        "fast",
      );
      expect(first.statusCode).toBe(202);
      const nativeFile = s.record.nativeFile;
      const before = await readFile(nativeFile);
      const records = before
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id?: string });
      const parentId = records.at(-1)?.id;
      expect(parentId).toBeTruthy();
      const externalId = "external-entry-session-access";
      await appendFile(
        nativeFile,
        `${JSON.stringify({ type: "message", id: externalId, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "external context marker" } })}\n`,
      );
      const appended = await readFile(nativeFile);
      const snapshot = await s.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${s.record.id}/snapshot`,
        headers: s.headers,
      });
      const history = await s.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${s.record.id}/history`,
        headers: s.headers,
      });
      expect(snapshot.statusCode).toBe(200);
      expect(history.statusCode).toBe(200);
      expect(await readFile(nativeFile)).toEqual(appended);
      expect((await readFile(journal, "utf8")).split("\n")).not.toContain(
        "switch_session",
      );

      const continued = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174302",
        "prompt",
        "fast",
      );
      expect(continued.statusCode).toBe(202);
      const after = await readFile(nativeFile, "utf8");
      const userEntry = after
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              parentId?: string;
              message?: { content?: string };
            },
        )
        .filter((entry) => entry.message?.content === "fast")
        .at(-1);
      expect(userEntry?.parentId).toBe(externalId);
      expect(after).toContain("external context marker");
      const journalAfterPrompt = await readFile(journal, "utf8");
      expect(journalAfterPrompt).toContain("switch_session");
      const journalLinesBeforeDuplicate = journalAfterPrompt.trim().split("\n");
      const userEntriesBeforeDuplicate = after
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message?: { role?: string } })
        .filter((entry) => entry.message?.role === "user").length;
      const duplicate = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174302",
        "prompt",
        "fast",
      );
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json()).toEqual(continued.json());
      const afterDuplicate = await readFile(nativeFile, "utf8");
      const userEntriesAfterDuplicate = afterDuplicate
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message?: { role?: string } })
        .filter((entry) => entry.message?.role === "user").length;
      expect(userEntriesAfterDuplicate).toBe(userEntriesBeforeDuplicate);
      expect((await readFile(journal, "utf8")).trim().split("\n")).toHaveLength(
        journalLinesBeforeDuplicate.length,
      );
    } finally {
      restoreEnv("FAKE_PI_JOURNAL", priorJournal);
      await dispose(s);
    }
  });

  it("lets a prompt explicitly claim a TUI-owned session", async () => {
    const s = await make({ owner: "tui" });
    try {
      const response = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174303",
        "prompt",
        "fast",
      );
      expect(response.statusCode).toBe(202);
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("web");
      const latestRecord = s.ledger.session(s.record.id)!;
      expect(s.runtime.snapshot(latestRecord).desiredOwner).toBe("web");
      const snapshot = await s.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${s.record.id}/snapshot`,
        headers: s.headers,
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().desiredOwner).toBe("web");
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("web");
    } finally {
      await dispose(s);
    }
  });

  it.each(["reloadcancel", "reloadidentity", "reloadmodel"])(
    "blocks a stale prompt after unsafe reload mode %s and keeps the web lease",
    async (mode) => {
      const s = await make();
      const priorMode = process.env.FAKE_PI_MODE;
      process.env.FAKE_PI_MODE = mode;
      try {
        const start = await operation(
          s,
          "123e4567-e89b-42d3-a456-426614174304",
          "prompt",
          "fast",
        );
        expect(start.statusCode).toBe(202);
        const original = (await readFile(s.record.nativeFile, "utf8"))
          .trim()
          .split("\n")
          .at(-1)!;
        const tail = JSON.parse(original) as {
          id: string;
          parentId: string | null;
        };
        await appendFile(
          s.record.nativeFile,
          `${JSON.stringify({ type: "message", id: `external-${mode}`, parentId: tail.id, timestamp: new Date().toISOString(), message: { role: "user", content: "external" } })}\n`,
        );
        const blocked = await operation(
          s,
          "123e4567-e89b-42d3-a456-426614174305",
          "prompt",
          "must not send",
        );
        expect(blocked.statusCode).toBe(mode === "reloadcancel" ? 409 : 503);
        expect(s.runtime.snapshot(s.record).runtimeState).toBe("blocked");
        expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("web");
        await expect(
          WriterLease.acquire(s.record.nativeFile + ".prw.lock"),
        ).rejects.toMatchObject({ statusCode: 423 });
      } finally {
        restoreEnv("FAKE_PI_MODE", priorMode);
        await dispose(s);
      }
    },
  );

  it("blocks after a reload switch timeout and does not retry the operation", async () => {
    const s = await make();
    const priorMode = process.env.FAKE_PI_MODE;
    const priorJournal = process.env.FAKE_PI_JOURNAL;
    const journal = join(s.dir, "rpc.log");
    let commandSpy: ReturnType<typeof vi.spyOn> | undefined;
    process.env.FAKE_PI_JOURNAL = journal;
    process.env.FAKE_PI_MODE = "reloadtimeout";
    try {
      const first = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174310",
        "prompt",
        "fast",
      );
      expect(first.statusCode).toBe(202);
      const records = (await readFile(s.record.nativeFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string });
      const parentId = records.at(-1)!.id;
      await appendFile(
        s.record.nativeFile,
        `${JSON.stringify({ type: "message", id: "external-reload-timeout", parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "external" } })}\n`,
      );
      const promptsBeforeReload = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter((command) => command === "prompt").length;
      const live = (
        s.runtime as unknown as {
          live: Map<string, { rpc: import("../../src/server/rpc.js").PiRpc }>;
        }
      ).live.get(s.record.id)!;
      const originalCommand = live.rpc.command.bind(live.rpc);
      commandSpy = vi
        .spyOn(live.rpc, "command")
        .mockImplementation((command, params, timeoutMs) =>
          originalCommand(
            command,
            params,
            command === "switch_session" ? 100 : timeoutMs,
          ),
        );
      const operationId = "123e4567-e89b-42d3-a456-426614174311";
      const timedOut = await operation(
        s,
        operationId,
        "prompt",
        "must not send",
      );
      expect(timedOut.statusCode).toBe(503);
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("blocked");
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("web");
      await expect(
        WriterLease.acquire(s.record.nativeFile + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      const duplicate = await operation(
        s,
        operationId,
        "prompt",
        "must not send",
      );
      expect(duplicate.statusCode).toBe(409);
      const commands = (await readFile(journal, "utf8")).trim().split("\n");
      expect(commands.filter((line) => line === "switch_session")).toHaveLength(
        1,
      );
      expect(commands.filter((line) => line === "prompt")).toHaveLength(
        promptsBeforeReload,
      );
    } finally {
      commandSpy?.mockRestore();
      restoreEnv("FAKE_PI_MODE", priorMode);
      restoreEnv("FAKE_PI_JOURNAL", priorJournal);
      await dispose(s);
    }
  });

  it("accepts steer and follow-up while busy, then rejects a stale steer without reload or abort", async () => {
    const s = await make();
    const priorHold = process.env.FAKE_PI_HOLD;
    const priorJournal = process.env.FAKE_PI_JOURNAL;
    const journal = join(s.dir, "rpc.log");
    process.env.FAKE_PI_HOLD = "1";
    process.env.FAKE_PI_JOURNAL = journal;
    try {
      expect(
        (
          await operation(
            s,
            "123e4567-e89b-42d3-a456-426614174306",
            "prompt",
            "hold:never",
          )
        ).statusCode,
      ).toBe(202);
      expect(
        (
          await operation(
            s,
            "123e4567-e89b-42d3-a456-426614174307",
            "steer",
            "steer while running",
          )
        ).statusCode,
      ).toBe(202);
      expect(
        (
          await operation(
            s,
            "123e4567-e89b-42d3-a456-426614174308",
            "follow_up",
            "follow while running",
          )
        ).statusCode,
      ).toBe(202);
      const lines = (await readFile(s.record.nativeFile, "utf8"))
        .trim()
        .split("\n");
      const tail = JSON.parse(lines.at(-1)!) as { id: string };
      await appendFile(
        s.record.nativeFile,
        `${JSON.stringify({ type: "message", id: "external-busy-entry", parentId: tail.id, timestamp: new Date().toISOString(), message: { role: "user", content: "external busy" } })}\n`,
      );
      const rejected = await operation(
        s,
        "123e4567-e89b-42d3-a456-426614174309",
        "steer",
        "do not switch",
      );
      expect(rejected.statusCode).toBe(409);
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("running");
      const commands = await readFile(journal, "utf8");
      expect(commands).not.toContain("switch_session");
      expect(commands).not.toContain("abort");
    } finally {
      restoreEnv("FAKE_PI_HOLD", priorHold);
      restoreEnv("FAKE_PI_JOURNAL", priorJournal);
      await dispose(s);
    }
  });

  it("quotes native command paths and session identifiers safely", async () => {
    const s = await make({ cwd: join(root, "project's cwd") });
    try {
      s.record.nativeId = "native's id";
      s.ledger.db
        .prepare("UPDATE sessions SET native_id=? WHERE id=?")
        .run(s.record.nativeId, s.record.id);
      const response = await s.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${s.record.id}/snapshot`,
        headers: s.headers,
      });
      expect(response.statusCode).toBe(200);
      const snapshot = response.json() as {
        nativeId: string;
        cwd: string;
        sessionDir: string;
        nativeCommand: string;
      };
      expect(snapshot.nativeId).toBe("native's id");
      expect(snapshot.nativeCommand).toBe(
        `cd '${snapshot.cwd.replaceAll("'", `'"'"'`)}' && pi --session-dir '${snapshot.sessionDir.replaceAll("'", `'"'"'`)}' --session 'native'"'"'s id'`,
      );
    } finally {
      await dispose(s);
    }
  });
});
