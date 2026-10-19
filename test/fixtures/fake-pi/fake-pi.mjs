#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  appendFileSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "node:timers";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { deserialize, serialize } from "node:v8";
const session = process.argv[process.argv.indexOf("--session") + 1];
const tuiMode = !process.argv.includes("--mode");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const argvJournal = process.env.FAKE_PI_ARGV_JOURNAL;
// Keep the legacy fake response stable unless the opt-in argv journal is enabled.
const selectedProvider = argvJournal ? flag("--provider", "fake") : "fake";
const selectedModel = argvJournal
  ? flag("--model", "fake-model")
  : "fake-model";
const selectedThinking = argvJournal ? flag("--thinking", "low") : "low";
if (argvJournal)
  appendFileSync(
    argvJournal,
    `${JSON.stringify({ event: "spawn", pid: process.pid, argv: process.argv.slice(2) })}\n`,
  );
process.once("exit", () => {
  if (argvJournal)
    appendFileSync(
      argvJournal,
      `${JSON.stringify({ event: "exit", pid: process.pid })}\n`,
    );
});
const records = readFileSync(session, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
let parentId =
  records.at(-1)?.type === "session" ? null : (records.at(-1)?.id ?? null);
let seq = records.length;
let cachedRecords = [...records];
let streaming = false;
let runTimer;
let abortTimer;
let steering = [];
let followUp = [];
let compactRejected = false;
let reloadModelMismatch = false;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
if (tuiMode) {
  const gate = process.env.FAKE_TUI_GATE;
  const ready = process.env.FAKE_TUI_READY;
  const timer = setInterval(() => {
    if (gate && existsSync(gate)) {
      clearInterval(timer);
      entry("message", { role: "user", content: "from managed TUI" });
      process.exit(0);
    }
  }, 10);
  if (ready) writeFileSync(ready, JSON.stringify({ pid: process.pid }));
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
if (process.env.FAKE_PI_DESCENDANT === "1")
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
if (process.env.FAKE_PI_SURVIVE_EOF === "1") {
  setInterval(() => {}, 1000);
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") return;
    throw error;
  });
}
rl.on("close", () => {
  if (!tuiMode && process.env.FAKE_PI_SURVIVE_EOF !== "1") process.exit(0);
});
function response(req, data = {}) {
  const mode = process.env.FAKE_PI_MODE;
  if (mode === "invalid_utf8") {
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    return;
  }
  if (mode === "oversize") {
    process.stdout.write(`${"x".repeat(16 * 1024 * 1024 + 1)}\n`);
    return;
  }
  const record = {
    id: req.id,
    type: "response",
    command: mode === "mismatch" ? "wrong-command" : req.type,
    success: true,
    ...(Object.keys(data).length ? { data } : {}),
  };
  const output = () =>
    process.stdout.write(
      `${JSON.stringify(record)}${mode === "crlf" ? "\r\n" : "\n"}`,
    );
  if (mode === "late" && req.type === "get_state" && req.id === "1")
    setTimeout(output, 100);
  else output();
}
function entry(type, message) {
  const e = {
    type,
    id: `fake-entry-${++seq}`,
    parentId,
    timestamp: new Date().toISOString(),
    message,
  };
  appendFileSync(session, `${JSON.stringify(e)}\n`);
  parentId = e.id;
  cachedRecords.push(e);
  return e;
}
function rpc(type, fields = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...fields })}\n`);
}
function nativeMessage(message) {
  return entry("message", message);
}
function beginToolsScenario(kind, nonce) {
  streaming = true;
  const callId = `fake-${kind}-${nonce}`;
  const toolName = kind === "tools-demo" ? "subagent" : "write";
  const args =
    kind === "tools-demo"
      ? {
          mode: "single",
          tasks: [
            {
              agent: "implementation-worker",
              user: "fake child task",
              cwd: process.cwd(),
            },
          ],
        }
      : { path: "fake/proof", content: "synthetic proof" };
  rpc("agent_start", {});
  const assistantCall = {
    role: "assistant",
    content: [
      { type: "toolCall", id: callId, name: toolName, arguments: args },
    ],
  };
  rpc("message_start", { message: assistantCall });
  nativeMessage(assistantCall);
  rpc("message_end", { message: assistantCall });
  rpc("tool_execution_start", { toolCallId: callId, toolName, args });
  const child = {
    agent: "implementation-worker",
    model: "fake/worker-model",
    exitCode: 0,
    messages: [],
  };
  const snapshot = () => ({
    toolCallId: callId,
    toolName,
    args,
    partialResult: {
      content: [{ type: "text", text: "synthetic progress" }],
      details: {
        results: kind === "tools-demo" ? [deserialize(serialize(child))] : [],
        systemPrompt: "SYSTEM-SENTINEL",
        thinking: "THINKING-SENTINEL",
        signature: "SIGNATURE-SENTINEL",
        rawStderr: "RAWSTDERR-SENTINEL",
      },
    },
  });
  let progressed = false;
  const stage = (name) =>
    existsSync(`${process.env.FAKE_PI_GATE_DIR}/${nonce}.${name}`);
  runTimer = setInterval(() => {
    if (kind === "tools-demo" && !progressed && stage("progress")) {
      progressed = true;
      child.messages.push(
        {
          role: "assistant",
          model: "worker-model",
          provider: "fake",
          content: [
            {
              type: "text",
              text: `child-working-${nonce} <b>raw</b> [link](javascript:alert(1)) ![img](https://external.invalid/x)`,
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `bash-${nonce}`,
              name: "bash",
              arguments: { command: "synthetic command" },
            },
          ],
        },
      );
      const update = snapshot();
      rpc("tool_execution_update", update);
      rpc("tool_execution_update", update);
    }
    if (
      kind === "tools-demo" &&
      !child.messages.some((message) => message.role === "toolResult") &&
      stage("repair")
    ) {
      child.messages.push(
        {
          role: "toolResult",
          toolCallId: `bash-${nonce}`,
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "recoverable-error-proof" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `repair-progress-${nonce}` }],
        },
      );
      rpc("tool_execution_update", snapshot());
    }
    if (!stage("finish")) return;
    clearInterval(runTimer);
    runTimer = undefined;
    if (kind === "tools-demo") {
      child.messages.push(
        {
          role: "toolResult",
          toolCallId: `bash-${nonce}`,
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "synthetic child success" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `child-complete-${nonce}` }],
        },
      );
    }
    const result = {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      isError: false,
      content: [{ type: "text", text: "synthetic tool complete" }],
      details: {
        mode: "single",
        agent: "implementation-worker",
        cwd: process.cwd(),
        model: "fake/worker-model",
        results: kind === "tools-demo" ? [child] : [],
      },
    };
    nativeMessage(result);
    rpc("tool_execution_end", {
      toolCallId: callId,
      toolName,
      args,
      isError: false,
      result,
    });
    if (kind === "tools-demo")
      rpc("tool_execution_update", {
        toolCallId: callId,
        toolName: "subagent",
        args,
        partialResult: {
          details: {
            results: [
              {
                agent: child.agent,
                exitCode: 0,
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "late-child" }],
                  },
                ],
              },
            ],
          },
        },
      });
    const final = {
      role: "assistant",
      content: [{ type: "text", text: `tools-done-${nonce}` }],
    };
    nativeMessage(final);
    rpc("message_start", { message: final });
    rpc("message_end", { message: final });
    streaming = false;
    rpc("agent_settled", { aborted: false });
  }, 20);
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  if (process.env.FAKE_PI_JOURNAL)
    appendFileSync(process.env.FAKE_PI_JOURNAL, `${req.type}\n`);
  switch (req.type) {
    case "get_state":
      if (
        ["compact-state-unavailable", "compact-timeout"].includes(
          process.env.FAKE_PI_MODE,
        ) &&
        compactRejected
      )
        break;
      if (process.env.FAKE_PI_MODE === "unicode")
        process.stdout.write(
          `${JSON.stringify({ type: "state", text: "valid � \u2028 \u2029" })}\r\n`,
        );
      response(req, {
        sessionFile: session,
        sessionId: cachedRecords[0].id,
        model: {
          id: reloadModelMismatch ? "mismatch-model" : selectedModel,
          provider: selectedProvider,
        },
        thinkingLevel: selectedThinking,
        isStreaming: streaming,
        isCompacting: false,
        pendingMessageCount: steering.length + followUp.length,
        messageCount: cachedRecords.length - 1,
      });
      break;
    case "get_entries": {
      const entries = cachedRecords.slice(1);
      const index =
        req.since === undefined
          ? -1
          : entries.findIndex((row) => row.id === req.since);
      if (req.since !== undefined && index < 0) {
        process.stdout.write(
          `${JSON.stringify({ id: req.id, type: "response", command: req.type, success: false, error: "Entry not found" })}\n`,
        );
        break;
      }
      response(req, {
        entries: req.since === undefined ? entries : entries.slice(index + 1),
        leafId: entries.at(-1)?.id ?? null,
      });
      break;
    }
    case "switch_session": {
      const mode = process.env.FAKE_PI_MODE;
      if (mode === "reloadtimeout") break;
      if (mode === "reloadmodel") reloadModelMismatch = true;
      if (mode === "reloadcancel") {
        response(req, { cancelled: true });
        break;
      }
      try {
        const fresh = readFileSync(session, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        if (mode === "reloadidentity") fresh[0].id = `${fresh[0].id}-mismatch`;
        cachedRecords = fresh;
        parentId =
          fresh.at(-1)?.type === "session" ? null : (fresh.at(-1)?.id ?? null);
        seq = fresh.length;
        response(req, { cancelled: false });
      } catch {
        response(req, { cancelled: true });
      }
      break;
    }
    case "set_steering_mode":
    case "set_follow_up_mode":
      response(req);
      break;
    case "prompt":
    case "steer":
    case "follow_up": {
      const kind = req.type === "prompt" ? "user" : req.type;
      if (kind === "steer") steering.push(req.message);
      else if (kind === "follow_up") followUp.push(req.message);
      entry("message", { role: "user", content: req.message ?? "" });
      if (req.type === "steer" || req.type === "follow_up")
        process.stdout.write(
          `${JSON.stringify({ type: "queue_update", steering, followUp })}\n`,
        );
      if (
        req.type === "prompt" &&
        req.message !== "handled" &&
        req.message !== "fast"
      )
        streaming = true;
      if (req.type === "prompt" && req.message === "fast") {
        streaming = false;
        process.stdout.write(
          `${JSON.stringify({ type: "agent_settled", aborted: false })}\n`,
        );
      }
      if (req.type === "prompt" && req.message === "error") {
        entry("message", {
          role: "assistant",
          content: "failed",
          stopReason: "error",
        });
        process.stdout.write(
          `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error" } })}\n`,
        );
        process.stdout.write(
          `${JSON.stringify({ type: "agent_settled", aborted: false })}\n`,
        );
      }
      response(req, {
        disposition:
          req.type === "prompt" && req.message === "handled"
            ? "handled"
            : req.type === "prompt"
              ? "started"
              : "queued",
      });
      const special =
        typeof req.message === "string"
          ? req.message.match(/^(tools-demo|tools-simple):([a-zA-Z0-9-]+)$/)
          : null;
      if (req.type === "prompt" && special && process.env.FAKE_PI_GATE_DIR) {
        beginToolsScenario(special[1], special[2]);
        break;
      }
      if (
        req.type === "prompt" &&
        !["fast", "error", "handled"].includes(req.message ?? "")
      ) {
        const finish = () => {
          if (!streaming) return;
          streaming = false;
          clearTimeout(runTimer);
          clearInterval(runTimer);
          runTimer = undefined;
          entry("message", {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          });
          process.stdout.write(
            `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })}\n`,
          );
          process.stdout.write(
            `${JSON.stringify({ type: "agent_settled", aborted: false })}\n`,
          );
        };
        const holdMessage = String(req.message).startsWith("hold:");
        const holdAll = process.env.FAKE_PI_HOLD === "1";
        if (holdMessage || holdAll) {
          const gateDir = process.env.FAKE_PI_GATE_DIR;
          const gate =
            holdMessage && gateDir
              ? `${gateDir}/${String(req.message).slice(5)}`
              : undefined;
          if (gate) {
            runTimer = setInterval(() => {
              if (existsSync(gate)) finish();
            }, 10);
          }
        } else {
          process.stdout.write(
            `${JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } })}\n`,
          );
          for (const [type, fields] of [
            ["text_start", { contentIndex: 0 }],
            ["text_delta", { contentIndex: 0, delta: "streaming " }],
            ["text_delta", { contentIndex: 0, delta: "response" }],
            [
              "text_end",
              {
                contentIndex: 0,
                content: { type: "text", text: "streaming response" },
              },
            ],
          ])
            process.stdout.write(
              `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type, ...fields } })}\n`,
            );
          process.stdout.write(
            `${JSON.stringify({ type: "tool_execution_start", toolName: "fixture" })}\n`,
          );
          runTimer = setTimeout(finish, req.message === "normal" ? 150 : 30);
        }
      }
      break;
    }
    case "clear_queue": {
      const data = { steering, followUp };
      steering = [];
      followUp = [];
      response(req, data);
      process.stdout.write(
        `${JSON.stringify({ type: "queue_update", steering, followUp })}\n`,
      );
      break;
    }
    case "abort": {
      clearTimeout(runTimer);
      clearInterval(runTimer);
      runTimer = undefined;
      if (process.env.FAKE_PI_ABORT_HANG === "1") break;
      const gate = process.env.FAKE_PI_ABORT_GATE;
      if (gate) {
        const finishAbort = () => {
          if (!existsSync(gate)) return;
          clearInterval(abortTimer);
          abortTimer = undefined;
          streaming = false;
          response(req);
        };
        abortTimer = setInterval(finishAbort, 10);
        finishAbort();
        break;
      }
      streaming = false;
      clearInterval(abortTimer);
      abortTimer = undefined;
      response(req);
      break;
    }
    case "compact":
      if (process.env.FAKE_PI_MODE === "compact-timeout") break;
      if (
        [
          "compact-reject",
          "compact-reject-busy",
          "compact-state-unavailable",
          "compact-too-small",
          "compact-already-compacted",
        ].includes(process.env.FAKE_PI_MODE)
      ) {
        compactRejected = true;
        if (process.env.FAKE_PI_MODE === "compact-reject-busy")
          streaming = true;
        process.stdout.write(
          `${JSON.stringify({
            id: req.id,
            type: "response",
            command: req.type,
            success: false,
            error:
              process.env.FAKE_PI_MODE === "compact-too-small"
                ? "RAW_TOO_SMALL_SENTINEL"
                : process.env.FAKE_PI_MODE === "compact-already-compacted"
                  ? "RAW_ALREADY_COMPACTED_SENTINEL"
                  : "RAW_COMPACT_REJECTION_SENTINEL",
          })}\n`,
        );
      } else response(req);
      break;
    case "extension_ui_response":
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ id: req.id, type: "response", command: req.type, success: false, error: "unsupported" })}\n`,
      );
  }
});
