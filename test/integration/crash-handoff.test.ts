import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { WriterLease } from "../../src/server/lease.js";
import { createNative } from "../../src/server/native-sessions.js";
import { PiRpc } from "../../src/server/rpc.js";
import type { Project } from "../../src/shared/contracts.js";
const execFileAsync = promisify(execFile);
const root = testRoot("crash-handoff");
describe("inherited native-session lease", () => {
  it("keeps the lock through the Pi child after the controller-side fd closes", async () => {
    const dir = await mkdtemp(join(root, "handoff-"));
    await mkdir(dir, { recursive: true });
    const project: Project = { id: "p", name: "p", cwd: dir, sessionDir: dir };
    const native = await createNative(project);
    let lease: WriterLease | undefined;
    let rpc: PiRpc | undefined;
    try {
      lease = await WriterLease.acquire(native.file + ".prw.lock");
      rpc = new PiRpc(
        resolve("test/fixtures/fake-pi/fake-pi.mjs"),
        native.file,
        project,
        { id: "f", name: "f" },
        lease,
      );
      await rpc.command("get_state");
      await lease.close();
      lease = undefined;
      await expect(
        execFileAsync("/usr/bin/flock", [
          "-n",
          "-E",
          "73",
          native.file + ".prw.lock",
          "/usr/bin/true",
        ]),
      ).rejects.toMatchObject({ code: 73 });
      await rpc.close();
      rpc = undefined;
      await expect(
        execFileAsync("/usr/bin/flock", [
          "-n",
          "-E",
          "73",
          native.file + ".prw.lock",
          "/usr/bin/true",
        ]),
      ).resolves.toBeDefined();
    } finally {
      await rpc?.close().catch(() => undefined);
      await lease?.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
