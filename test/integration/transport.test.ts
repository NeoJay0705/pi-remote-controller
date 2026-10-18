import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { WriterLease } from "../../src/server/lease.js";
import { PiRpc } from "../../src/server/rpc.js";
import { createNative } from "../../src/server/native-sessions.js";
import type { Project } from "../../src/shared/contracts.js";
const root = testRoot("transport");
const fixture = resolve("test/fixtures/fake-pi/fake-pi.mjs");
async function setup(mode?: string) {
  const dir = await mkdtemp(join(root, "transport-"));
  await mkdir(dir, { recursive: true });
  const project: Project = { id: "p", name: "fake", cwd: dir, sessionDir: dir };
  const native = await createNative(project),
    lease = await WriterLease.acquire(native.file + ".prw.lock");
  const previous = process.env.FAKE_PI_MODE;
  if (mode) process.env.FAKE_PI_MODE = mode;
  else delete process.env.FAKE_PI_MODE;
  const rpc = new PiRpc(
    fixture,
    native.file,
    project,
    { id: "f", name: "f" },
    lease,
  );
  return {
    dir,
    lease,
    rpc,
    restore: () => {
      if (previous === undefined) delete process.env.FAKE_PI_MODE;
      else process.env.FAKE_PI_MODE = previous;
    },
  };
}
describe("strict RPC framing and correlation", () => {
  it("accepts literal replacement Unicode, U+2028/U+2029 and CRLF framing", async () => {
    const s = await setup("unicode");
    try {
      const events: unknown[] = [];
      s.rpc.on("event", (e) => events.push(e));
      expect((await s.rpc.command("get_state")).success).toBe(true);
      expect(events).toHaveLength(1);
    } finally {
      await s.rpc.close();
      await s.lease.close();
      s.restore();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it.each(["invalid_utf8", "oversize", "mismatch"])(
    "fails closed for %s",
    async (mode) => {
      const s = await setup(mode);
      try {
        await expect(
          s.rpc.command("get_state", {}, 3000),
        ).rejects.toBeInstanceOf(Error);
      } finally {
        await s.rpc.close().catch(() => undefined);
        await s.lease.close();
        s.restore();
        await rm(s.dir, { recursive: true, force: true });
      }
    },
  );
  it("bounds stdin buffering and never writes a timed-out queued frame later", async () => {
    const s = await setup();
    const stdin = s.rpc.child.stdin!;
    const original = stdin.write.bind(stdin);
    let writes = 0;
    Object.defineProperty(stdin, "write", {
      configurable: true,
      value: () => {
        writes++;
        return false;
      },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          s.rpc
            .command("prompt", { message: "x".repeat(20_000) }, 80)
            .catch((error) => error),
        ),
      );
      expect(
        results.some(
          (result) =>
            result instanceof Error &&
            result.message === "rpc_write_queue_full",
        ),
      ).toBe(true);
      Object.defineProperty(stdin, "write", {
        configurable: true,
        value: original,
      });
      stdin.emit("drain");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writes).toBe(1);
    } finally {
      Object.defineProperty(stdin, "write", {
        configurable: true,
        value: original,
      });
      if (!stdin.destroyed) stdin.emit("drain");
      await s.rpc.close().catch(() => undefined);
      await s.lease.close();
      s.restore();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("joins and kills only descendants in its owned process group", async () => {
    const old = process.env.FAKE_PI_DESCENDANT;
    process.env.FAKE_PI_DESCENDANT = "1";
    const s = await setup();
    try {
      await s.rpc.command("get_state");
      await s.rpc.close(200);
    } finally {
      if (old === undefined) delete process.env.FAKE_PI_DESCENDANT;
      else process.env.FAKE_PI_DESCENDANT = old;
      await s.rpc.close().catch(() => undefined);
      await s.lease.close();
      s.restore();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
  it("ignores a late response for a timed-out id and sends no-ack UI response", async () => {
    const s = await setup("late");
    try {
      await expect(s.rpc.command("get_state", {}, 10)).rejects.toMatchObject({
        code: "rpc_timeout",
        uncertain: true,
      });
      expect((await s.rpc.command("get_state", {}, 3000)).success).toBe(true);
      await expect(
        s.rpc.respondUI("dialog-1", { value: "ok" }),
      ).resolves.toBeUndefined();
    } finally {
      await s.rpc.close();
      await s.lease.close();
      s.restore();
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});
