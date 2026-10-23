import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { WriterLease } from "./lease.js";
import { Ledger } from "./store.js";
import { WorkspaceRuntime } from "./runtime.js";

export async function startServer(): Promise<{
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}> {
  const config = await loadConfig();
  const token = process.env.PRW_OWNER_TOKEN;
  if (!token || token.length < 32) throw new Error("owner_token_invalid");
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const controller = await WriterLease.acquire(
    join(config.dataDir, "controller.lock"),
  );
  let ledger: Ledger;
  try {
    ledger = await Ledger.open(config.dataDir);
  } catch (error) {
    await controller.close();
    throw error;
  }
  const runtime = new WorkspaceRuntime(config, ledger);
  const app = createApp(config, ledger, runtime, token);
  let listening = false;
  try {
    await app.listen({
      host: config.listenHost ?? "127.0.0.1",
      port: config.port,
    });
    listening = true;
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      closing = (async () => {
        await app.close();
        // Keep the ledger and controller lease if a runtime cannot prove child shutdown.
        await runtime.shutdown();
        ledger.close();
        await controller.close();
        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);
      })();
      return closing;
    };
    const onInt = () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    const onTerm = () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    return { app, close };
  } finally {
    if (!listening) {
      await runtime.shutdown();
      ledger.close();
      await controller.close();
    }
  }
}
if (import.meta.url === `file://${process.argv[1]}`)
  void startServer().catch(() => {
    process.stderr.write("server_start_failed\n");
    process.exitCode = 1;
  });
