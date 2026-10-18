import { randomUUID } from "node:crypto";
import { error } from "node:console";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, ...args] = process.argv.slice(2);
if (mode !== "vitest" && mode !== "playwright") {
  error("Usage: node scripts/test-env.mjs <vitest|playwright> [...args]");
  process.exit(2);
}

const runRoot = join(repoRoot, ".test-artifacts", "runs", randomUUID());
const dirs = [
  runRoot,
  join(runRoot, "home"),
  join(runRoot, "xdg-config"),
  join(runRoot, "xdg-data"),
  join(runRoot, "tmp"),
  join(runRoot, "cache"),
  join(runRoot, "playwright"),
];
for (const dir of dirs) await mkdir(dir, { recursive: true, mode: 0o700 });

const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: join(runRoot, "home"),
  XDG_CONFIG_HOME: join(runRoot, "xdg-config"),
  XDG_DATA_HOME: join(runRoot, "xdg-data"),
  TMPDIR: join(runRoot, "tmp"),
  NODE_COMPILE_CACHE: join(runRoot, "cache"),
  PRW_TEST_RUN_DIR: runRoot,
  PRW_TEST_DESCRIPTOR: join(runRoot, "descriptor.json"),
  PRW_PLAYWRIGHT_OUTPUT: join(runRoot, "playwright"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  TZ: "UTC",
  LANG: "C.UTF-8",
  NO_PROXY: "127.0.0.1,localhost",
};
for (const name of ["CI", "PRW_BROWSER_EXECUTABLE"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(os.homedir(), ".cache", "ms-playwright");

const runner =
  mode === "vitest"
    ? join(repoRoot, "node_modules", "vitest", "vitest.mjs")
    : join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const tasks = [
  [
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    ["-p", "tsconfig.server.json"],
  ],
];
if (mode === "playwright") {
  tasks.push([
    join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
    ["build"],
  ]);
}
tasks.push([runner, mode === "vitest" ? ["run", ...args] : ["test", ...args]]);

let currentChild;
let receivedSignal;
let signalForwarded = false;
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    receivedSignal ??= signal;
    if (!signalForwarded && currentChild?.pid !== undefined) {
      signalForwarded = true;
      currentChild.kill(signal);
    }
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 0);
}

async function runTask(script, taskArgs) {
  if (receivedSignal) return signalExitCode(receivedSignal);
  const child = spawn(process.execPath, [script, ...taskArgs], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  currentChild = child;
  if (receivedSignal && !signalForwarded && child.pid !== undefined) {
    signalForwarded = true;
    child.kill(receivedSignal);
  }
  let failedToStart = false;
  const result = await new Promise((done) => {
    child.once("error", () => {
      failedToStart = true;
      error("Test task process failed to start.");
    });
    child.once("close", (code, signal) => done({ code, signal }));
  });
  currentChild = undefined;
  if (failedToStart) return 125;
  if (receivedSignal) return signalExitCode(receivedSignal);
  if (result.code !== null) return result.code;
  return result.signal ? signalExitCode(result.signal) : 1;
}

try {
  for (const [script, taskArgs] of tasks) {
    const code = await runTask(script, taskArgs);
    if (code !== 0 || receivedSignal) {
      process.exitCode = code;
      break;
    }
  }
} finally {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}
