#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { error, log } from "node:console";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metadataPath = join(
  repoRoot,
  ".test-artifacts/live-instance/service.pid.json",
);
const port = 4317;
const timeoutMs = 30_000;
const pollMs = 300;

function parseMetadata(contents) {
  let metadata;
  try {
    metadata = JSON.parse(contents);
  } catch {
    throw new Error("invalid service PID metadata");
  }
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 1 ||
    typeof metadata.starttime !== "string" ||
    !/^[1-9]\d*$/.test(metadata.starttime)
  ) {
    throw new Error("invalid service PID metadata");
  }
  return { pid: metadata.pid, starttime: metadata.starttime };
}

function parseStarttime(stat) {
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) throw new Error("invalid process stat");
  const fields = stat
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error("invalid process stat");
  }
  return fields[19];
}

export async function readProcessStarttime(pid, read = readFile) {
  try {
    return parseStarttime(await read(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function createSystemIO() {
  return {
    readMetadata: () => readFile(metadataPath, "utf8"),
    readStarttime: (pid) => readProcessStarttime(pid),
    hasListener() {
      return (
        execFileSync("ss", ["-H", "-ltn", "sport", "=", `:${port}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim().length > 0
      );
    },
    signal(pid, signal) {
      process.kill(pid, signal);
    },
    now: () => Date.now(),
    wait: (ms) => setTimeout(ms),
  };
}

export async function stopService(io = createSystemIO()) {
  const { pid, starttime } = parseMetadata(await io.readMetadata());
  const currentStarttime = await io.readStarttime(pid);
  if (currentStarttime === null) {
    if (await io.hasListener()) {
      throw new Error("service PID is absent but port 4317 is occupied");
    }
    return "already stopped";
  }
  if (currentStarttime !== starttime) {
    throw new Error("service PID identity mismatch");
  }

  io.signal(pid, "SIGTERM");
  const deadline = io.now() + timeoutMs;
  while (true) {
    const observedStarttime = await io.readStarttime(pid);
    if (observedStarttime !== starttime) {
      if (observedStarttime !== null) {
        throw new Error("service PID identity mismatch while stopping");
      }
      if (!(await io.hasListener())) return "stopped";
    }
    if (io.now() >= deadline) throw new Error("service stop timed out");
    await io.wait(Math.min(pollMs, Math.max(0, deadline - io.now())));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await stopService();
    log(`service:stop: ${result}`);
  } catch (failure) {
    error(`service:stop: ${failure.message}`);
    process.exitCode = 1;
  }
}
