import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 10000;
const MAX_ATTEMPTS = 4096;
export function tokenMatches(provided: string, expected: string): boolean {
  if (expected.length < 32) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}
function cookie(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("prw_session="));
  return value?.slice("prw_session=".length);
}
export class Auth {
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private readonly secure: boolean) {}
  expiry(request: FastifyRequest): number | undefined {
    const id = cookie(request);
    if (!id) return undefined;
    const expires = this.sessions.get(id);
    if (expires === undefined) return undefined;
    if (expires <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return expires;
  }
  valid(request: FastifyRequest): boolean {
    return this.expiry(request) !== undefined;
  }
  login(
    request: FastifyRequest,
    reply: FastifyReply,
    expected: string,
  ): boolean {
    const now = Date.now();
    for (const [ip, entry] of this.attempts)
      if (entry.until <= now) this.attempts.delete(ip);
    for (const [id, expires] of this.sessions)
      if (expires <= now) this.sessions.delete(id);
    const ip = request.ip;
    let old = this.attempts.get(ip);
    if (old && old.until > now && old.count >= 10) {
      reply.code(429).send({
        error: { code: "rate_limited", message: "Too many attempts" },
      });
      return false;
    }
    const body = request.body as { token?: unknown };
    const ok =
      typeof body?.token === "string" && tokenMatches(body.token, expected);
    if (!ok) {
      if (!old || old.until <= now) old = { count: 0, until: now + 60000 };
      old.count++;
      if (!this.attempts.has(ip) && this.attempts.size >= MAX_ATTEMPTS)
        this.attempts.delete(this.attempts.keys().next().value as string);
      this.attempts.set(ip, old);
      reply.code(401).send({
        error: { code: "unauthorized", message: "Authentication failed" },
      });
      return false;
    }
    this.attempts.delete(ip);
    if (this.sessions.size >= MAX_SESSIONS)
      this.sessions.delete(this.sessions.keys().next().value as string);
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, now + SESSION_TTL);
    reply
      .header(
        "set-cookie",
        `prw_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${this.secure ? "; Secure" : ""}`,
      )
      .code(200)
      .send({ ok: true });
    return true;
  }
  logout(request: FastifyRequest, reply: FastifyReply): void {
    const id = cookie(request);
    if (id) this.sessions.delete(id);
    reply
      .header(
        "set-cookie",
        `prw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secure ? "; Secure" : ""}`,
      )
      .code(200)
      .send({ ok: true });
  }
}
export function createAuth(secure: boolean): Auth {
  return new Auth(secure);
}
