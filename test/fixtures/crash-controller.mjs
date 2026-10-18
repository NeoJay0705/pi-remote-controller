#!/usr/bin/env node
import process from "node:process";
import { writeFileSync } from "node:fs";
import { Ledger } from "../../dist/server/store.js";
import { WorkspaceRuntime } from "../../dist/server/runtime.js";
const config = JSON.parse(process.env.FAKE_CONTROLLER_CONFIG);
const ledger = await Ledger.open(config.dataDir);
const runtime = new WorkspaceRuntime(config, ledger);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.shutdown().catch(() => undefined);
  ledger.close();
};
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
const record = ledger.session(process.env.FAKE_CONTROLLER_SESSION);
if (!record) throw new Error("missing_session");
const operationId = process.env.FAKE_CONTROLLER_OPERATION;
ledger.begin(record.id, "prompt", operationId, {
  kind: "prompt",
  operationId,
  text: "crash once",
});
await runtime.operation(
  record,
  { kind: "prompt", operationId, text: "crash once" },
  operationId,
);
const live = runtime.live.get(record.id);
writeFileSync(
  process.env.FAKE_CONTROLLER_READY,
  JSON.stringify({
    controllerPid: process.pid,
    childPid: live.rpc.child.pid,
    recordId: record.id,
    operationId,
  }),
);
await new Promise(() => {});
