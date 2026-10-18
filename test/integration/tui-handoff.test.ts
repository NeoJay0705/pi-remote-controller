import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { WriterLease } from "../../src/server/lease.js";
import {
  createNative,
  validateNative,
} from "../../src/server/native-sessions.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";

const artifacts = testRoot("tui-handoff");
async function eventually(check: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("eventually_timeout");
}
function closePromise(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose) =>
      child.once("close", (code, signal) => resolveClose({ code, signal })),
  );
}
async function processGone(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
  } catch {
    return true;
  }
}
function entryText(entry: Record<string, unknown>) {
  const message = entry.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}
async function setup() {
  const dir = join(artifacts, `tui-${randomUUID()}`);
  const cwd = join(dir, "project"),
    sessionDir = join(dir, "sessions");
  const dataDir = join(dir, "data"),
    fakePackage = join(dir, "fake-pi");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(fakePackage, { recursive: true });
  const fakePi = join(fakePackage, "fake-pi.mjs");
  await writeFile(
    fakePi,
    await readFile(resolve("test/fixtures/fake-pi/fake-pi.mjs")),
  );
  await writeFile(
    join(fakePackage, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.3.0",
    }),
  );
  const config: WorkspaceConfig = {
    port: 4317,
    publicOrigin: "http://127.0.0.1:4317",
    dataDir,
    piCli: fakePi,
    projects: [{ id: "p", name: "project", cwd, sessionDir }],
    profiles: [
      {
        id: "f",
        name: "fake",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      },
    ],
  };
  await mkdir(cwd, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  const ledger = await Ledger.open(dataDir);
  const runtime = new WorkspaceRuntime(config, ledger);
  const native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  const home = join(dir, "home"),
    xdgConfig = join(dir, "xdg-config"),
    xdgData = join(dir, "xdg-data"),
    tmp = join(dir, "tmp"),
    cache = join(dir, "compile-cache");
  for (const path of [home, xdgConfig, xdgData, tmp, cache])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    TMPDIR: tmp,
    NODE_COMPILE_CACHE: cache,
    PI_CODING_AGENT_OFFLINE: "1",
    PI_CODING_AGENT_NO_AUTO_UPDATE: "1",
    PI_CODING_AGENT_NO_TELEMETRY: "1",
    PRW_CONFIG: join(dir, "config.json"),
    FAKE_TUI_READY: join(dir, "ready"),
    FAKE_TUI_GATE: join(dir, "gate"),
  };
  return { dir, config, ledger, runtime, record, native, env };
}
async function launch(s: Awaited<ReturnType<typeof setup>>) {
  await s.runtime.ensure(s.record);
  await s.runtime.operation(s.record, {
    kind: "release",
    operationId: randomUUID(),
  });
  const wrapper = spawn(
    process.execPath,
    [resolve("dist/cli/main.js"), "tui", "--session", s.record.id],
    { env: s.env, cwd: s.dir, stdio: "ignore" },
  );
  const closed = closePromise(wrapper);
  try {
    await eventually(async () => {
      try {
        const ready = JSON.parse(
          await readFile(s.env.FAKE_TUI_READY!, "utf8"),
        ) as { pid: number };
        return ready.pid > 1;
      } catch {
        return false;
      }
    });
    const pid = (
      JSON.parse(await readFile(s.env.FAKE_TUI_READY!, "utf8")) as {
        pid: number;
      }
    ).pid;
    return { wrapper, closed, pid };
  } catch (error) {
    if (wrapper.exitCode === null && wrapper.signalCode === null)
      wrapper.kill("SIGTERM");
    await closed;
    try {
      const pid = (
        JSON.parse(await readFile(s.env.FAKE_TUI_READY!, "utf8")) as {
          pid: number;
        }
      ).pid;
      if (pid > 1 && !(await processGone(pid))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* known child may have exited */
        }
        await eventually(async () => processGone(pid));
      }
    } catch {
      /* no known child was published */
    }
    throw error;
  }
}
describe("managed TUI CLI handoff", () => {
  it("holds the writer through real CLI TUI use and returns the same native history to web", async () => {
    const s = await setup();
    let managed: Awaited<ReturnType<typeof launch>> | undefined;
    let claimedRuntime: WorkspaceRuntime | undefined;
    try {
      managed = await launch(s);
      const { closed, pid } = managed;
      const prefix = await readFile(s.native.file);
      await expect(
        WriterLease.acquire(s.native.file + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      await expect(
        s.runtime.operation(s.record, {
          kind: "claim",
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("tui");
      await writeFile(s.env.FAKE_TUI_GATE!, "go");
      expect(await closed).toEqual({ code: 0, signal: null });
      await eventually(async () => processGone(pid));
      const afterTui = await readFile(s.native.file);
      const tuiHistory = await validateNative(
        s.native.file,
        s.config.projects[0]!,
      );
      expect(tuiHistory.id).toBe(s.native.id);
      expect(tuiHistory.cwd).toBe(s.config.projects[0]!.cwd);
      const tuiEntry = tuiHistory.entries.find(
        (entry) => entryText(entry) === "from managed TUI",
      );
      expect(tuiEntry).toBeDefined();
      expect(afterTui.subarray(0, prefix.length)).toEqual(prefix);
      const nextRuntime = new WorkspaceRuntime(s.config, s.ledger);
      claimedRuntime = nextRuntime;
      await nextRuntime.operation(s.record, {
        kind: "claim",
        operationId: randomUUID(),
      });
      await nextRuntime.operation(s.record, {
        kind: "prompt",
        operationId: randomUUID(),
        text: "after handoff",
      });
      await eventually(
        async () => nextRuntime.snapshot(s.record).runtimeState === "idle",
      );
      const webHistory = await validateNative(
        s.native.file,
        s.config.projects[0]!,
      );
      expect(webHistory.id).toBe(s.native.id);
      expect(webHistory.file).toBe(s.native.file);
      expect(webHistory.cwd).toBe(s.config.projects[0]!.cwd);
      expect(
        (await readFile(s.native.file)).subarray(0, prefix.length),
      ).toEqual(prefix);
      const webEntry = webHistory.entries.find(
        (entry) => entryText(entry) === "after handoff",
      );
      expect(webEntry).toBeDefined();
      const byId = new Map(
        webHistory.entries.map((entry) => [entry.id, entry]),
      );
      let parent = webEntry?.parentId;
      let linked = false;
      while (typeof parent === "string") {
        if (parent === tuiEntry?.id) {
          linked = true;
          break;
        }
        parent = (byId.get(parent) as { parentId?: unknown } | undefined)
          ?.parentId;
      }
      expect(linked).toBe(true);
      await nextRuntime.shutdown();
      claimedRuntime = undefined;
    } finally {
      if (
        managed &&
        managed.wrapper.exitCode === null &&
        managed.wrapper.signalCode === null
      ) {
        managed.wrapper.kill("SIGTERM");
        await managed.closed;
      }
      if (managed && !(await processGone(managed.pid))) {
        try {
          process.kill(managed.pid, "SIGKILL");
        } catch {
          /* known child may have exited */
        }
        await eventually(async () => processGone(managed.pid));
      }
      await claimedRuntime?.shutdown();
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 30000);

  it("forwards SIGTERM to the known Pi child, joins both processes, and releases the lease", async () => {
    const s = await setup();
    let wrapper: ReturnType<typeof spawn> | undefined;
    let wrapperClosed:
      | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
      | undefined;
    let childPid = 0;
    try {
      await s.runtime.ensure(s.record);
      await s.runtime.operation(s.record, {
        kind: "release",
        operationId: randomUUID(),
      });
      wrapper = spawn(
        process.execPath,
        [resolve("dist/cli/main.js"), "tui", "--session", s.record.id],
        {
          env: {
            ...s.env,
            FAKE_TUI_READY: join(s.dir, "term-ready"),
            FAKE_TUI_GATE: join(s.dir, "term-gate"),
          },
          cwd: s.dir,
          stdio: "ignore",
        },
      );
      wrapperClosed = closePromise(wrapper);
      const readyPath = join(s.dir, "term-ready");
      await eventually(async () => {
        try {
          childPid = (
            JSON.parse(await readFile(readyPath, "utf8")) as { pid: number }
          ).pid;
          return childPid > 1;
        } catch {
          return false;
        }
      });
      wrapper.kill("SIGTERM");
      expect(await wrapperClosed).toEqual({ code: 0, signal: null });
      await eventually(async () => processGone(childPid));
      childPid = 0;
      const lease = await WriterLease.acquire(s.native.file + ".prw.lock");
      await lease.close();
    } finally {
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGTERM");
        await wrapperClosed;
      }
      if (childPid <= 1) {
        try {
          childPid = (
            JSON.parse(await readFile(join(s.dir, "term-ready"), "utf8")) as {
              pid: number;
            }
          ).pid;
        } catch {
          childPid = 0;
        }
      }
      if (childPid > 1 && !(await processGone(childPid))) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* known child may have exited */
        }
        await eventually(async () => processGone(childPid));
        childPid = 0;
      }
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 30000);
});
