import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  WorkspaceConfig,
  OperationInput,
  SessionNameInfo,
} from "../shared/contracts.js";
import { normalizeSessionName } from "../shared/session-names.js";
import { Ledger } from "./store.js";
import { WorkspaceRuntime } from "./runtime.js";
import { refreshDiscoveredProjects } from "./project-discovery.js";
import { createAuth } from "./auth.js";
import { safeErrorCode, statusForError } from "./errors.js";
import { createNative, listNative } from "./native-sessions.js";
import {
  inspectNative,
  readNativeName,
  readNativePage,
  type NameReadBudget,
} from "./native-reader.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(
  value: unknown,
  allowed: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}
function error(reply: FastifyReply, exception: unknown): void {
  const fastifyCode =
    exception && typeof exception === "object" && "code" in exception
      ? String((exception as { code: unknown }).code)
      : "";
  if (
    fastifyCode.startsWith("FST_ERR_CTP_INVALID_JSON") ||
    fastifyCode === "FST_ERR_VALIDATION"
  ) {
    reply
      .code(400)
      .send({ error: { code: "invalid_schema", message: "Invalid request" } });
    return;
  }
  if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
    reply.code(413).send({
      error: { code: "payload_too_large", message: "Payload too large" },
    });
    return;
  }
  if (fastifyCode.startsWith("FST_ERR_CTP_")) {
    reply
      .code(415)
      .send({ error: { code: "json_required", message: "JSON required" } });
    return;
  }
  const code = safeErrorCode(exception);
  const status = statusForError(exception, code);
  reply.code(status).send({
    error: {
      code,
      message: status >= 500 ? "Request failed" : code.replaceAll("_", " "),
    },
  });
}
export function createApp(
  config: WorkspaceConfig,
  ledger: Ledger,
  runtime: WorkspaceRuntime,
  token: string,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 300 * 1024 });
  const auth = createAuth(config.secureCookies === true);
  const webRoot = fileURLToPath(new URL("../../dist/web/", import.meta.url));
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../../dist/web/assets/", import.meta.url)),
    prefix: "/assets/",
    wildcard: true,
  });
  app.get("/", async (_req, reply) => reply.sendFile("index.html", webRoot));
  const streams = new Set<() => void>();
  const tails = new Map<string, Promise<void>>();
  const blockedSessions = new Set<string>();
  let closing = false;
  const preClose = async () => {
    closing = true;
    for (const stop of [...streams]) stop();
    await Promise.allSettled([...tails.values()]);
  };
  app.addHook("preClose", preClose);
  app.addHook("onClose", preClose);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'self';script-src 'self';style-src 'self';connect-src 'self';img-src 'self' data:;object-src 'none';frame-ancestors 'none';base-uri 'none'",
      );
    return payload;
  });
  app.addHook("preHandler", async (req, reply) => {
    const route = req.routeOptions.url ?? req.url.split("?")[0]!;
    if (!route.startsWith("/api/")) return;
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (mutating) {
      if (req.headers.origin !== config.publicOrigin) {
        reply.code(403).send({
          error: { code: "origin_forbidden", message: "Origin rejected" },
        });
        return;
      }
      const contentType = req.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
      ) {
        reply
          .code(415)
          .send({ error: { code: "json_required", message: "JSON required" } });
        return;
      }
    }
    if (route === "/api/v1/auth/login") return;
    if (!auth.valid(req)) {
      reply.code(401).send({
        error: { code: "unauthorized", message: "Authentication required" },
      });
    }
  });
  app.post("/api/v1/auth/login", async (req, reply) => {
    if (!object(req.body, ["token"]) || typeof req.body.token !== "string") {
      reply.code(400).send({
        error: { code: "invalid_schema", message: "Invalid request" },
      });
      return;
    }
    auth.login(req, reply, token);
  });
  app.post("/api/v1/auth/logout", async (req, reply) =>
    auth.logout(req, reply),
  );
  app.get("/api/v1/auth/me", async () => ({ authenticated: true }));
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/v1/projects", async (_req, reply) => {
    try {
      const projects = await refreshDiscoveredProjects(config);
      return projects.map(({ id, name }) => ({ id, name }));
    } catch (e) {
      error(reply, e);
    }
  });
  app.get("/api/v1/profiles", async () =>
    config.profiles.map(
      ({ id, name, provider, model, thinking, extensions, tools }) => ({
        id,
        name,
        provider,
        model,
        thinking,
        extensions,
        tools,
      }),
    ),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/projects/:id/native-sessions",
    async (req, reply) => {
      const project = config.projects.find(
        (value) => value.id === req.params.id,
      );
      if (!project) {
        reply
          .code(404)
          .send({ error: { code: "not_found", message: "Project not found" } });
        return;
      }
      try {
        const managed = new Set(
          await Promise.all(
            ledger.sessions().map(async (session) => {
              try {
                return await realpath(session.nativeFile);
              } catch {
                return resolve(session.nativeFile);
              }
            }),
          ),
        );
        return (await listNative(project)).filter(
          (session) =>
            session.error !== undefined || !managed.has(session.file),
        );
      } catch (e) {
        error(reply, e);
      }
    },
  );
  app.post("/api/v1/sessions", async (req, reply) => {
    const body = req.body;
    if (
      !object(body, ["projectId", "profileId", "nativeFile", "name"]) ||
      typeof body.projectId !== "string" ||
      !body.projectId ||
      typeof body.profileId !== "string" ||
      !body.profileId ||
      (body.nativeFile !== undefined &&
        (typeof body.nativeFile !== "string" || !body.nativeFile)) ||
      (body.name !== undefined && typeof body.name !== "string") ||
      (body.nativeFile !== undefined && body.name !== undefined)
    ) {
      reply.code(400).send({
        error: { code: "invalid_schema", message: "Invalid request" },
      });
      return;
    }
    const validatedName =
      body.name === undefined
        ? { ok: true as const }
        : normalizeSessionName(body.name);
    if (!validatedName.ok) {
      reply.code(400).send({
        error: {
          code: "invalid_session_name",
          message: "Invalid session name",
        },
      });
      return;
    }
    try {
      const project = config.projects.find(
          (value) => value.id === body.projectId,
        ),
        profile = config.profiles.find((value) => value.id === body.profileId);
      if (!project || !profile) throw new Error("invalid_project_or_profile");
      const native = body.nativeFile
        ? await inspectNative(body.nativeFile, project)
        : await createNative(project, validatedName.name);
      const record = ledger.createSession({
        nativeFile: native.file,
        nativeId: native.id,
        projectId: project.id,
        profileId: profile.id,
      });
      const nameInfo =
        "nameInfo" in native
          ? native.nameInfo
          : await readNativeName(native.file, project, {
              expectedNativeId: native.id,
            });
      reply.code(201).send({ ...record, nameInfo });
    } catch (e) {
      error(reply, e);
    }
  });
  app.get("/api/v1/sessions", async (_req, reply) => {
    try {
      const budget: NameReadBudget = {
        bytes: 0,
        maxBytes: 8 * 1024 * 1024,
        deadline: Date.now() + 1000,
        now: Date.now,
        exhausted: false,
      };
      const sessions = [];
      for (const session of ledger.sessions()) {
        const project = config.projects.find(
          (value) => value.id === session.projectId,
        );
        const nameInfo: SessionNameInfo = project
          ? await readNativeName(session.nativeFile, project, {
              expectedNativeId: session.nativeId,
              sharedBudget: budget,
            })
          : { status: "error", code: "invalid_session_config" };
        sessions.push({ ...session, nameInfo });
      }
      return sessions;
    } catch (e) {
      error(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/snapshot",
    async (req, reply) => {
      try {
        const record = ledger.session(req.params.id);
        if (!record) {
          reply.code(404).send({
            error: { code: "not_found", message: "Session not found" },
          });
          return;
        }
        const project = config.projects.find(
          (value) => value.id === record.projectId,
        );
        const nameInfo: SessionNameInfo = project
          ? await readNativeName(record.nativeFile, project, {
              expectedNativeId: record.nativeId,
            })
          : { status: "error", code: "invalid_session_config" };
        return { ...runtime.snapshot(record), nameInfo };
      } catch (e) {
        error(reply, e);
      }
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string; previewBytes?: string };
  }>("/api/v1/sessions/:id/history", async (req, reply) => {
    try {
      const record = ledger.session(req.params.id);
      if (!record) {
        reply
          .code(404)
          .send({ error: { code: "not_found", message: "Session not found" } });
        return;
      }
      const project = config.projects.find(
        (value) => value.id === record.projectId,
      );
      if (!project) {
        reply
          .code(404)
          .send({ error: { code: "not_found", message: "Project not found" } });
        return;
      }
      const limit =
        req.query.limit === undefined
          ? 100
          : /^(?:[1-9][0-9]*)$/.test(req.query.limit)
            ? Number(req.query.limit)
            : NaN;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (req.query.before !== undefined && !req.query.before)
      )
        throw new Error("invalid_history_query");
      const previewBytes =
        req.query.previewBytes === undefined
          ? undefined
          : /^(?:[1-9][0-9]*)$/.test(req.query.previewBytes)
            ? Number(req.query.previewBytes)
            : NaN;
      if (
        previewBytes !== undefined &&
        (!Number.isInteger(previewBytes) ||
          previewBytes < 2048 ||
          previewBytes > 65536)
      )
        throw new Error("invalid_history_query");
      return readNativePage(
        record.nativeFile,
        project,
        req.query.before,
        limit,
        {
          expectedNativeId: record.nativeId,
          ...(previewBytes === undefined ? {} : { previewBytes }),
        },
      );
    } catch (e) {
      error(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/events",
    async (req, reply) => {
      try {
        const record = ledger.session(req.params.id);
        if (!record) {
          reply.code(404).send({
            error: { code: "not_found", message: "Session not found" },
          });
          return;
        }
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self';script-src 'self';style-src 'self';connect-src 'self';img-src 'self' data:;object-src 'none';frame-ancestors 'none';base-uri 'none'",
        });
        let ended = false;
        const cleanup = () => {
          if (ended) return;
          ended = true;
          clearInterval(timer);
          clearTimeout(expiryTimer);
          unsub();
          streams.delete(finish);
        };
        const finish = () => {
          cleanup();
          if (!res.writableEnded) res.end();
        };
        const send = (event: unknown) => {
          if (ended || closing) {
            finish();
            return;
          }
          if (res.writableLength > 512 * 1024) {
            const payload = `data: ${JSON.stringify({ type: "resync-required" })}\n\n`;
            if (!res.destroyed) res.write(payload);
            finish();
            return;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (res.writableLength > 512 * 1024) finish();
        };
        const unsub = runtime.subscribe(record.id, send);
        const expiry = auth.expiry(req) ?? Date.now();
        const expiryTimer = setTimeout(
          finish,
          Math.max(0, expiry - Date.now()),
        );
        const timer = setInterval(() => {
          if (!auth.valid(req)) finish();
          else send({ type: "heartbeat" });
        }, 15000);
        streams.add(finish);
        res.on("close", cleanup);
        res.on("error", cleanup);
        send({ type: "snapshot", data: runtime.snapshot(record) });
      } catch (e) {
        error(reply, e);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/operations",
    async (req, reply) => {
      const body = req.body;
      const kinds = [
        "prompt",
        "steer",
        "follow_up",
        "stop",
        "compact",
        "release",
        "claim",
        "ui_response",
      ];
      if (
        !object(body, [
          "operationId",
          "kind",
          "text",
          "dialogId",
          "method",
          "value",
        ]) ||
        typeof body.operationId !== "string" ||
        !UUID.test(body.operationId) ||
        typeof body.kind !== "string" ||
        !kinds.includes(body.kind) ||
        (body.text !== undefined &&
          (typeof body.text !== "string" ||
            Buffer.byteLength(body.text, "utf8") > 256 * 1024)) ||
        (body.dialogId !== undefined && typeof body.dialogId !== "string") ||
        (body.method !== undefined && typeof body.method !== "string") ||
        (["prompt", "steer", "follow_up"].includes(String(body.kind)) &&
          (typeof body.text !== "string" || !body.text.trim())) ||
        (body.kind === "ui_response" &&
          (typeof body.dialogId !== "string" ||
            !body.dialogId ||
            typeof body.method !== "string" ||
            !body.method ||
            body.value === undefined))
      ) {
        reply.code(400).send({
          error: { code: "invalid_schema", message: "Invalid request" },
        });
        return;
      }
      try {
        if (closing) throw new Error("closing");
        const record = ledger.session(req.params.id);
        if (!record) {
          reply.code(404).send({
            error: { code: "not_found", message: "Session not found" },
          });
          return;
        }
        const input = body as unknown as OperationInput;
        const admissionOwner = record.desiredOwner;
        if (blockedSessions.has(record.id)) throw new Error("session_blocked");
        const previous = tails.get(record.id) ?? Promise.resolve();
        const work = previous.then(async () => {
          if (blockedSessions.has(record.id))
            throw new Error("session_blocked");
          const start = ledger.begin(
            record.id,
            input.kind,
            input.operationId,
            input,
          );
          if (!start.fresh) {
            reply
              .code(start.receipt.status === "UNKNOWN" ? 409 : 202)
              .send(ledger.operation(input.operationId) ?? start.receipt);
            return;
          }
          let dispatched = false;
          try {
            const freshRecord = ledger.session(record.id);
            if (!freshRecord) throw new Error("not_found");
            if (
              input.kind === "prompt" &&
              admissionOwner === "web" &&
              freshRecord.desiredOwner === "tui"
            )
              throw new Error("owner_mismatch");
            dispatched = true;
            const result = await runtime.operation(
              freshRecord,
              input,
              input.operationId,
            );
            const handled =
              !!result &&
              typeof result === "object" &&
              (result as { status?: unknown }).status === "handled";
            ledger.finish(
              input.operationId,
              handled ? "HANDLED" : "ACCEPTED",
              result,
            );
            const receipt = ledger.operation(input.operationId);
            reply.code(202).send(receipt);
          } catch (e) {
            const code = safeErrorCode(e);
            const rejected =
              !dispatched ||
              (e &&
                typeof e === "object" &&
                "uncertain" in e &&
                (e as { uncertain?: unknown }).uncertain === false) ||
              (e && typeof e === "object" && "statusCode" in e) ||
              code === "rpc_command_rejected" ||
              (code !== "internal_error" &&
                !["storage_error", "cleanup_incomplete"].includes(code) &&
                !code.startsWith("rpc_"));
            if (code === "storage_error") {
              blockedSessions.add(record.id);
              await runtime.block(record.id, "storage_error");
            }
            try {
              ledger.finish(
                input.operationId,
                rejected ? "REJECTED" : "UNKNOWN",
              );
            } catch {
              blockedSessions.add(record.id);
              await runtime.block(record.id, "storage_error");
            }
            throw e;
          }
        });
        const tail = work.then(
          () => undefined,
          () => undefined,
        );
        tails.set(record.id, tail);
        try {
          await work;
        } finally {
          if (tails.get(record.id) === tail) tails.delete(record.id);
        }
      } catch (e) {
        error(reply, e);
      }
    },
  );
  app.get<{ Params: { operationId: string } }>(
    "/api/v1/operations/:operationId",
    async (req, reply) => {
      try {
        const operation = ledger.operation(req.params.operationId);
        if (!operation) {
          reply.code(404).send({
            error: { code: "not_found", message: "Operation not found" },
          });
          return;
        }
        return operation;
      } catch (e) {
        error(reply, e);
      }
    },
  );
  app.setErrorHandler((e, _req, reply) => error(reply, e));
  return app;
}
