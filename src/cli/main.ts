#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadConfig } from "../server/config.js";
import { Ledger } from "../server/store.js";
import { WriterLease } from "../server/lease.js";
import { inspectNative } from "../server/native-reader.js";
import { safeErrorCode } from "../server/errors.js";

async function tui(id: string): Promise<void> {
  const config = await loadConfig();
  const ledger = await Ledger.open(config.dataDir, {
    readOnly: true,
    recover: false,
  });
  let lease: WriterLease | undefined;
  try {
    const session = ledger.session(id);
    if (!session) throw new Error("session_not_found");
    const project = config.projects.find((p) => p.id === session.projectId),
      profile = config.profiles.find((p) => p.id === session.profileId);
    if (!project || !profile) throw new Error("invalid_session_config");
    lease = await WriterLease.acquire(session.nativeFile + ".prw.lock");
    const current = ledger.session(id);
    if (!current || current.desiredOwner !== "tui")
      throw new Error("tui_not_owner");
    const native = await inspectNative(current.nativeFile, project);
    if (native.id !== current.nativeId || native.file !== current.nativeFile)
      throw new Error("native_id_mismatch");
    const args = [config.piCli, "--session", native.file];
    if (profile.provider) args.push("--provider", profile.provider);
    if (profile.model) args.push("--model", profile.model);
    if (profile.thinking) args.push("--thinking", profile.thinking);
    for (const extension of profile.extensions ?? [])
      args.push("-e", extension);
    if (profile.tools?.length) args.push("--tools", profile.tools.join(","));
    for (const prompt of profile.appendSystemPrompts ?? [])
      args.push("--append-system-prompt", prompt);
    const child = spawn(process.execPath, args, {
      cwd: project.cwd,
      shell: false,
      detached: false,
      stdio: ["inherit", "inherit", "inherit", lease.fd],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "PRW_OWNER_TOKEN",
        ),
      ),
    });
    let signal: NodeJS.Signals | undefined;
    const forward = (received: NodeJS.Signals) => {
      signal ??= received;
      if (child.exitCode === null && child.signalCode === null)
        child.kill(received);
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    try {
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, childSignal) =>
          resolve({ code, signal: childSignal }),
        );
      });
      if (result.code !== null) process.exitCode = result.code;
      else if (signal) process.exitCode = signal === "SIGINT" ? 130 : 143;
      else if (result.signal)
        process.exitCode =
          result.signal === "SIGINT"
            ? 130
            : result.signal === "SIGTERM"
              ? 143
              : 1;
      else process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
  } finally {
    await lease?.close();
    ledger.close();
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args[0] !== "tui" ||
    args[1] !== "--session" ||
    !args[2] ||
    args.length !== 3
  ) {
    process.stderr.write("usage: prw tui --session <appUUID>\n");
    process.exitCode = 2;
    return;
  }
  try {
    await tui(args[2]);
  } catch (e) {
    const code = safeErrorCode(e);
    process.stderr.write(
      `${code === "internal_error" ? "tui_failed" : code}\n`,
    );
    process.exitCode = 1;
  }
}
void main();
