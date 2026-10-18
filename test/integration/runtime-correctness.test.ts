import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { WriterLease } from "../../src/server/lease.js";
import { createNative } from "../../src/server/native-sessions.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import { Ledger } from "../../src/server/store.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
const root = testRoot("runtime-correctness");
async function make(model = "fake-model") {
  const dir = await mkdtemp(join(root, "runtime-")),
    projectDir = join(dir, "project"),
    sessionDir = join(projectDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const config: WorkspaceConfig = {
    port: 0,
    publicOrigin: "http://127.0.0.1:1",
    dataDir: join(dir, "data"),
    piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
    projects: [{ id: "p", name: "p", cwd: projectDir, sessionDir }],
    profiles: [
      { id: "f", name: "f", provider: "fake", model, thinking: "low" },
    ],
  };
  const ledger = await Ledger.open(config.dataDir),
    runtime = new WorkspaceRuntime(config, ledger),
    native = await createNative(config.projects[0]!);
  const record = ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: "p",
    profileId: "f",
  });
  return { dir, config, ledger, runtime, record };
}
describe("runtime ownership and stop ordering", () => {
  it("keeps a TUI-owned snapshot read-only until an explicit prompt", async () => {
    const s = await make();
    s.ledger.setOwner(s.record.id, "tui");
    s.record.desiredOwner = "tui";
    try {
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("released");
      await s.runtime.operation(s.record, {
        operationId: "x",
        kind: "prompt",
        text: "explicit prompt",
      });
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("web");
      expect(s.runtime.snapshot(s.record).runtimeState).not.toBe("released");
    } finally {
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("rejects a prompt while the external writer lease is held, then permits it", async () => {
    const s = await make();
    s.ledger.setOwner(s.record.id, "tui");
    s.record.desiredOwner = "tui";
    const lease = await WriterLease.acquire(s.record.nativeFile + ".prw.lock");
    try {
      await expect(
        s.runtime.operation(s.record, {
          operationId: "held",
          kind: "prompt",
          text: "prompt after lock",
        }),
      ).rejects.toMatchObject({ statusCode: 423 });
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("tui");
      await lease.close();
      await s.runtime.operation(s.record, {
        operationId: "unheld",
        kind: "prompt",
        text: "prompt after unlock",
      });
    } finally {
      await lease.close();
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("keeps TUI owner on failed claim and joins a spawned child before releasing lease", async () => {
    const s = await make("not-the-selected-model");
    s.ledger.setOwner(s.record.id, "tui");
    s.record.desiredOwner = "tui";
    try {
      await expect(
        s.runtime.operation(s.record, { operationId: "claim", kind: "claim" }),
      ).rejects.toBeInstanceOf(Error);
      expect(s.ledger.session(s.record.id)?.desiredOwner).toBe("tui");
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("released");
      const lease = await WriterLease.acquire(
        s.record.nativeFile + ".prw.lock",
      );
      await lease.close();
    } finally {
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("persists steering and follow-up clear results before abort completes", async () => {
    const old = process.env.FAKE_PI_HOLD;
    process.env.FAKE_PI_HOLD = "1";
    const s = await make();
    try {
      await s.runtime.operation(s.record, {
        operationId: "p",
        kind: "prompt",
        text: "long work",
      });
      await s.runtime.operation(s.record, {
        operationId: "s",
        kind: "steer",
        text: "steer item",
      });
      await s.runtime.operation(s.record, {
        operationId: "f",
        kind: "follow_up",
        text: "follow item",
      });
      const id = "123e4567-e89b-42d3-a456-426614174111";
      s.ledger.begin(s.record.id, "stop", id, {
        kind: "stop",
        operationId: id,
      });
      const result = (await s.runtime.operation(
        s.record,
        { operationId: id, kind: "stop" },
        id,
      )) as { cleared: unknown[] };
      expect(result.cleared).toEqual([
        { kind: "steer", text: "steer item" },
        { kind: "follow_up", text: "follow item" },
      ]);
      expect(s.ledger.operation(id)?.result).toMatchObject({
        cleared: result.cleared,
      });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("idle");
      await s.runtime.shutdown();
      const restarted = new WorkspaceRuntime(s.config, s.ledger);
      expect(restarted.snapshot(s.record).cleared).toEqual(result.cleared);
      await restarted.shutdown();
    } finally {
      if (old === undefined) delete process.env.FAKE_PI_HOLD;
      else process.env.FAKE_PI_HOLD = old;
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("treats handled and fast-settled acknowledgements correctly and resets stop reason per run", async () => {
    const old = process.env.FAKE_PI_PROMPT_MODE;
    const s = await make();
    try {
      process.env.FAKE_PI_PROMPT_MODE = "handled";
      expect(
        await s.runtime.operation(s.record, {
          operationId: "h",
          kind: "prompt",
          text: "handled",
        }),
      ).toMatchObject({ status: "handled" });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("idle");
      process.env.FAKE_PI_PROMPT_MODE = "fastsettled";
      expect(
        await s.runtime.operation(s.record, {
          operationId: "f",
          kind: "prompt",
          text: "fast",
        }),
      ).toMatchObject({ status: "accepted" });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("idle");
      process.env.FAKE_PI_PROMPT_MODE = "error";
      await s.runtime.operation(s.record, {
        operationId: "e",
        kind: "prompt",
        text: "error",
      });
      expect(s.runtime.snapshot(s.record).lastOutcome).toBe("error");
      process.env.FAKE_PI_PROMPT_MODE = "normal";
      await s.runtime.operation(s.record, {
        operationId: "n",
        kind: "prompt",
        text: "next",
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
      expect(s.runtime.snapshot(s.record).lastOutcome).toBe("settled");
    } finally {
      if (old === undefined) delete process.env.FAKE_PI_PROMPT_MODE;
      else process.env.FAKE_PI_PROMPT_MODE = old;
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("blocks and retains the lease when abort times out", async () => {
    const oldHold = process.env.FAKE_PI_HOLD,
      oldAbort = process.env.FAKE_PI_ABORT_HANG;
    process.env.FAKE_PI_HOLD = "1";
    process.env.FAKE_PI_ABORT_HANG = "1";
    const s = await make();
    try {
      await s.runtime.operation(s.record, {
        operationId: "long",
        kind: "prompt",
        text: "busy",
      });
      const id = "123e4567-e89b-42d3-a456-426614174112";
      s.ledger.begin(s.record.id, "stop", id, {
        kind: "stop",
        operationId: id,
      });
      await expect(
        s.runtime.operation(s.record, { operationId: id, kind: "stop" }, id),
      ).rejects.toMatchObject({ message: "rpc_timeout" });
      expect(s.runtime.snapshot(s.record).runtimeState).toBe("blocked");
      expect(s.ledger.operation(id)?.result).toMatchObject({
        status: "stopping",
        cleared: [],
      });
      await expect(
        WriterLease.acquire(s.record.nativeFile + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
    } finally {
      if (oldHold === undefined) delete process.env.FAKE_PI_HOLD;
      else process.env.FAKE_PI_HOLD = oldHold;
      if (oldAbort === undefined) delete process.env.FAKE_PI_ABORT_HANG;
      else process.env.FAKE_PI_ABORT_HANG = oldAbort;
      await s.runtime.shutdown();
      s.ledger.close();
      await rm(s.dir, { recursive: true, force: true });
    }
  }, 20000);
});
