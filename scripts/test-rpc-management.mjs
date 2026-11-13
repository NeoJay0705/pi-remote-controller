import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import process from "node:process";

const repo = process.cwd();
const artifacts = join(
  repo,
  ".test-artifacts",
  "rpc-management-v1",
  randomUUID(),
);
const home = join(artifacts, "home");
const xdg = join(artifacts, "xdg");
const temporary = await mkdtemp(join(tmpdir(), "prw-rpc-v1-"));
await Promise.all([
  mkdir(home, { recursive: true, mode: 0o700 }),
  mkdir(xdg, { recursive: true, mode: 0o700 }),
  mkdir(join(artifacts, "screenshots"), { recursive: true, mode: 0o700 }),
  mkdir(join(artifacts, "private"), { recursive: true, mode: 0o700 }),
]);
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePort(address.port));
  });
});
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(xdg, "config"),
  XDG_CACHE_HOME: join(xdg, "cache"),
  XDG_DATA_HOME: join(xdg, "data"),
  TMPDIR: temporary,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  FAKE_PI_ARGV_JOURNAL: join(artifacts, "private", "fake-pi-argv.jsonl"),
  FAKE_PI_JOURNAL: join(artifacts, "private", "fake-pi-rpc.journal"),
  FAKE_PI_GATE_DIR: join(artifacts, "private", "gates"),
  PRW_RPC_DESCRIPTOR: join(artifacts, "private", "descriptor.json"),
  NEXT_TELEMETRY_DISABLED: "1",
  PRW_RPC_BUILD_ROOT: artifacts,
  PRW_RPC_PORT: String(port),
  PRW_RPC_OUTPUT: join(artifacts, "playwright-output"),
  PRW_RPC_SCREENSHOTS: join(artifacts, "screenshots"),
  PRW_BROWSER_EXECUTABLE: process.env.PRW_BROWSER_EXECUTABLE,
  CI: "1",
};
async function run(label, command, args) {
  process.stdout.write(`\n[rpc-management] ${label}\n`);
  const result = spawnSync(command, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${label} failed (${result.status})`);
}
try {
  await Promise.all([
    mkdir(env.FAKE_PI_GATE_DIR, { recursive: true, mode: 0o700 }),
    chmod(artifacts, 0o700),
    chmod(join(artifacts, "private"), 0o700),
  ]);
  await run("server TypeScript build", "npx", [
    "tsc",
    "-p",
    "tsconfig.server.json",
    "--outDir",
    join(artifacts, "dist"),
  ]);
  await run("frontend build", "npx", [
    "vite",
    "build",
    "--outDir",
    join(artifacts, "dist", "web"),
    "--emptyOutDir",
  ]);
  await run("isolated Playwright acceptance", "npx", [
    "playwright",
    "test",
    "--config",
    "playwright.rpc-management.config.ts",
    ...process.argv.slice(2),
  ]);
  process.stdout.write(
    `\nIsolated artifacts: ${artifacts}\nScreenshots: ${join(artifacts, "screenshots")}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\nArtifacts retained: ${artifacts}\n`);
  process.exitCode = 1;
}
