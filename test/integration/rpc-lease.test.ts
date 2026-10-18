import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { WriterLease } from "../../src/server/lease.js";
import { PiRpc } from "../../src/server/rpc.js";
import { createNative } from "../../src/server/native-sessions.js";
import type { Profile, Project } from "../../src/shared/contracts.js";

const root = testRoot("rpc-lease");

describe("real stdio RPC child and Linux lease", () => {
  it("talks to synthetic Pi and keeps the fd-backed writer lease exclusive", async () => {
    const dir = await mkdtemp(join(root, "rpc-"));
    let lease: WriterLease | undefined;
    let rpc: PiRpc | undefined;
    try {
      const project: Project = {
        id: "p",
        name: "fixture",
        cwd: dir,
        sessionDir: dir,
      };
      await mkdir(project.sessionDir, { recursive: true });
      const native = await createNative(project);
      lease = await WriterLease.acquire(native.file + ".prw.lock");
      await expect(
        WriterLease.acquire(native.file + ".prw.lock"),
      ).rejects.toMatchObject({ statusCode: 423 });
      const profile: Profile = {
        id: "f",
        name: "fake",
        provider: "fake",
        model: "fake-model",
        thinking: "low",
      };
      const cli = resolve("test/fixtures/fake-pi/fake-pi.mjs");
      rpc = new PiRpc(cli, native.file, project, profile, lease);
      const state = await rpc.command("get_state");
      expect(state.success).toBe(true);
      const prompt = await rpc.command("prompt", { message: "Unicode 世界" });
      expect((prompt.data as { disposition: string }).disposition).toBe(
        "started",
      );
      await rpc.command("clear_queue");
      await rpc.command("abort");
    } finally {
      await rpc?.close();
      await lease?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
