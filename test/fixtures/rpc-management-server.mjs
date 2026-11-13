import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
const root = resolve(process.env.PRW_RPC_BUILD_ROOT);
const [{ Ledger }, { WorkspaceRuntime }, { createApp }, { createNative }] =
  await Promise.all([
    import(pathToFileURL(join(root, "dist/server/store.js")).href),
    import(pathToFileURL(join(root, "dist/server/runtime.js")).href),
    import(pathToFileURL(join(root, "dist/server/app.js")).href),
    import(pathToFileURL(join(root, "dist/server/native-sessions.js")).href),
  ]);
const port = Number(process.env.PRW_RPC_PORT);
const fixture = join(root, "fixture");
const dataDir = join(fixture, "data");
const projects = ["alpha", "beta"].map((suffix) => {
  const cwd = join(fixture, `project-${suffix}`);
  return {
    id: `rpc-${suffix}`,
    name: `RPC ${suffix.toUpperCase()} project`,
    cwd,
    sessionDir: join(cwd, ".pi", "sessions"),
  };
});
await Promise.all(
  projects.map((project) =>
    mkdir(project.sessionDir, { recursive: true, mode: 0o700 }),
  ),
);
const config = {
  port,
  publicOrigin: `http://127.0.0.1:${port}`,
  dataDir,
  piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
  projects,
  profiles: [
    {
      id: "fixture-profile",
      name: "Fixture",
      provider: "fake",
      model: "fake-model",
      thinking: "low",
    },
  ],
};
const token = "rpc-management-fixture-owner-token";
const ledger = await Ledger.open(dataDir);
const runtime = new WorkspaceRuntime(config, ledger);
const entries = {};
const makeRecord = async (project, name) => {
  const native = await createNative(project, name);
  return ledger.createSession({
    nativeFile: native.file,
    nativeId: native.id,
    projectId: project.id,
    profileId: "fixture-profile",
  });
};
const seed = async (key, project, name) => {
  const record = await makeRecord(project, name);
  const live = await runtime.ensure(record);
  entries[key] = {
    id: record.id,
    nativeId: record.nativeId,
    name,
    cwd: project.cwd,
    pid: live.rpc.child.pid,
  };
  return { record, live };
};
try {
  await seed("idleAlpha", projects[0], "Idle Alpha runtime");
  await seed("idleBeta", projects[1], "Idle Beta runtime");
  const held = await seed("held", projects[0], "Held prompt runtime");
  const nonce = `rpc-held-${randomUUID()}`;
  await runtime.operation(
    held.record,
    { kind: "prompt", text: `hold:${nonce}` },
    randomUUID(),
  );
  const blocked = await seed("blocked", projects[1], "Blocked runtime");
  await runtime.block(blocked.record.id, "synthetic_block");
  const released = await seed("released", projects[0], "Released runtime");
  await runtime.operation(released.record, { kind: "release" }, randomUUID());
  const descriptor = {
    projects: projects.map(({ id, name, cwd }) => ({ id, name, cwd })),
    entries,
    gateDir: process.env.FAKE_PI_GATE_DIR,
    rpcJournal: process.env.FAKE_PI_JOURNAL,
    argvJournal: process.env.FAKE_PI_ARGV_JOURNAL,
    exitJournal: process.env.FAKE_PI_ARGV_JOURNAL,
    dataDir,
    token,
  };
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(process.env.PRW_RPC_DESCRIPTOR, JSON.stringify(descriptor), {
    mode: 0o600,
  });
  const app = createApp(config, ledger, runtime, token);
  await app.listen({ host: "127.0.0.1", port });
  const stop = async () => {
    await app.close();
    await runtime.shutdown();
    ledger.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await runtime.shutdown();
  ledger.close();
  throw error;
}
