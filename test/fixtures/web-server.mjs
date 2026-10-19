import process from "node:process";
import { URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../../src/server/store.ts";
import { WorkspaceRuntime } from "../../src/server/runtime.ts";
import { createApp } from "../../src/server/app.ts";
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const testRunRoot = process.env.PRW_TEST_RUN_DIR
  ? resolve(process.env.PRW_TEST_RUN_DIR)
  : resolve(
      repoRoot,
      ".test-artifacts",
      "standalone-tests",
      String(process.pid),
    );
const root = join(testRunRoot, `browser-${randomUUID()}`);
const gateDir = join(root, "gates");
await mkdir(join(root, "project/.pi/sessions"), { recursive: true });
const discoveryRoot = join(root, "repos"),
  privateSessionRoot = join(root, "pi", "sessions");
await mkdir(discoveryRoot, { recursive: true });
await mkdir(privateSessionRoot, { recursive: true });
for (const name of ["repoA", "repoB", "repoC"])
  await mkdir(join(discoveryRoot, name));
await mkdir(join(root, "home"), { recursive: true });
await mkdir(gateDir, { recursive: true });
process.env.FAKE_PI_GATE_DIR = gateDir;
process.env.FAKE_PI_ARGV_JOURNAL = join(root, "fake-pi-argv.jsonl");
const descriptor = resolve(
  process.env.PRW_TEST_DESCRIPTOR ??
    ".test-artifacts/browser-state/descriptor.json",
);
await mkdir(resolve(descriptor, ".."), { recursive: true });
await writeFile(
  descriptor,
  JSON.stringify({
    gateDir,
    cwd: join(root, "project"),
    sessionDir: join(root, "project/.pi/sessions"),
    repoRoot: discoveryRoot,
    privateSessionRoot,
    argvJournal: process.env.FAKE_PI_ARGV_JOURNAL,
  }),
  { mode: 0o600 },
);
const config = {
  port: 4179,
  publicOrigin: "http://127.0.0.1:4179",
  dataDir: join(root, "data"),
  piCli: resolve("test/fixtures/fake-pi/fake-pi.mjs"),
  projects: [
    {
      id: "demo",
      name: "示範專案",
      cwd: join(root, "project"),
      sessionDir: join(root, "project/.pi/sessions"),
    },
  ],
  projectDiscovery: { root: discoveryRoot, sessionRoot: privateSessionRoot },
  profiles: [
    {
      id: "fake",
      name: "Fake local",
      provider: "fake",
      model: "fake-model",
      thinking: "low",
    },
    {
      id: "fake-alt",
      name: "Fake alternate",
      provider: "fake-alt-provider",
      model: "fake-alt-model",
      thinking: "medium",
    },
  ],
};
const token = "browser-fixture-owner-token-0123456789";
const ledger = await Ledger.open(config.dataDir);
const runtime = new WorkspaceRuntime(config, ledger);
const app = createApp(config, ledger, runtime, token);
await app.listen({ host: "127.0.0.1", port: 4179 });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await runtime.shutdown();
    ledger.close();
    process.exit(0);
  });
