import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Owner, Receipt } from "../shared/contracts.js";

export interface SessionRecord {
  id: string;
  nativeFile: string;
  nativeId: string;
  projectId: string;
  profileId: string;
  profileRevision: number;
  desiredOwner: Owner;
}
interface LedgerOptions {
  recover?: boolean;
  readOnly?: boolean;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
function stable(error: unknown): never {
  if (
    error instanceof Error &&
    (error.message === "operation_conflict" ||
      error.message === "storage_error")
  )
    throw error;
  throw new Error("storage_error");
}
export class Ledger {
  readonly db: DatabaseSync;
  private readonly revisionsAvailable: boolean;
  private constructor(
    readonly dir: string,
    options: LedgerOptions = {},
  ) {
    this.db = new DatabaseSync(join(dir, "ledger.sqlite"), {
      readOnly: options.readOnly === true,
    });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      if (options.readOnly) {
        const version = this.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        };
        if (version.user_version !== 1) throw new Error("storage_error");
        const meta = this.db
          .prepare("SELECT version FROM meta")
          .all() as Array<{ version: number }>;
        if (meta.length !== 1 || meta[0]?.version !== 1)
          throw new Error("storage_error");
        this.revisionsAvailable =
          (
            this.db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='session_profile_revisions'",
              )
              .get() as { name?: string } | undefined
          )?.name === "session_profile_revisions";
      } else {
        this.revisionsAvailable = true;
        this.db.exec("PRAGMA journal_mode=WAL;");
        this.db.exec("BEGIN IMMEDIATE;");
        try {
          const current =
            (
              this.db.prepare("PRAGMA user_version").get() as {
                user_version?: number;
              }
            ).user_version ?? 0;
          if (current !== 0 && current !== 1) throw new Error("storage_error");
          this.db
            .exec(`CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,native_file TEXT NOT NULL UNIQUE,native_id TEXT NOT NULL,project_id TEXT NOT NULL,profile_id TEXT NOT NULL,desired_owner TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(operation_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id));
            CREATE TABLE IF NOT EXISTS session_profile_revisions(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),FOREIGN KEY(session_id) REFERENCES sessions(id));
            INSERT INTO meta(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta);
            PRAGMA user_version=1;`);
          const rows = this.db
            .prepare("SELECT version FROM meta")
            .all() as Array<{ version: number }>;
          if (rows.length !== 1 || rows[0]?.version !== 1)
            throw new Error("storage_error");
          if (options.recover !== false)
            this.db.exec(
              "UPDATE operations SET status='UNKNOWN' WHERE status IN ('DISPATCHED','RECEIVED');",
            );
          this.db.exec("COMMIT;");
        } catch (e) {
          try {
            this.db.exec("ROLLBACK;");
          } catch {
            /* Preserve the original failure. */
          }
          throw e;
        }
      }
    } catch (e) {
      this.db.close();
      stable(e);
    }
  }
  static async open(dir: string, options: LedgerOptions = {}): Promise<Ledger> {
    try {
      if (!options.readOnly) await mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("storage_error");
      const canonicalDir = await realpath(dir);
      if (canonicalDir !== dir) dir = canonicalDir;
      if (!options.readOnly) await chmod(dir, 0o700);
      const file = join(dir, "ledger.sqlite");
      try {
        const st = await lstat(file);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)
          throw new Error("storage_error");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (options.readOnly) throw new Error("storage_error");
      }
      for (const suffix of ["-wal", "-shm"]) {
        try {
          const sidecar = await lstat(file + suffix);
          if (
            sidecar.isSymbolicLink() ||
            !sidecar.isFile() ||
            sidecar.nlink !== 1
          )
            throw new Error("storage_error");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const ledger = new Ledger(dir, options);
      if (!options.readOnly) {
        await chmod(file, 0o600);
        for (const suffix of ["-wal", "-shm"]) {
          try {
            const path = file + suffix;
            const st = await lstat(path);
            if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)
              throw new Error("storage_error");
            await chmod(path, 0o600);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              ledger.close();
              throw e;
            }
          }
        }
      }
      return ledger;
    } catch {
      throw new Error("storage_error");
    }
  }
  createSession(
    data: Omit<SessionRecord, "id" | "desiredOwner" | "profileRevision"> & {
      id?: string;
    },
  ): SessionRecord {
    const record = {
      ...data,
      id: data.id ?? randomUUID(),
      desiredOwner: "web" as const,
    };
    try {
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
        .run(
          record.id,
          record.nativeFile,
          record.nativeId,
          record.projectId,
          record.profileId,
          record.desiredOwner,
        );
      return { ...record, profileRevision: 0 };
    } catch (e) {
      if (
        (e as { code?: string; errcode?: number }).code ===
          "SQLITE_CONSTRAINT_UNIQUE" ||
        (e as { errcode?: number }).errcode === 2067
      )
        throw Object.assign(new Error("native_session_exists"), {
          statusCode: 409,
        });
      stable(e);
    }
  }
  session(id: string): SessionRecord | undefined {
    try {
      return this.db
        .prepare(
          this.revisionsAvailable
            ? "SELECT s.id,s.native_file nativeFile,s.native_id nativeId,s.project_id projectId,s.profile_id profileId,COALESCE(r.revision,0) profileRevision,s.desired_owner desiredOwner FROM sessions s LEFT JOIN session_profile_revisions r ON r.session_id=s.id WHERE s.id=?"
            : "SELECT id,native_file nativeFile,native_id nativeId,project_id projectId,profile_id profileId,0 profileRevision,desired_owner desiredOwner FROM sessions WHERE id=?",
        )
        .get(id) as SessionRecord | undefined;
    } catch (e) {
      stable(e);
    }
  }
  sessions(): SessionRecord[] {
    try {
      return this.db
        .prepare(
          this.revisionsAvailable
            ? "SELECT s.id,s.native_file nativeFile,s.native_id nativeId,s.project_id projectId,s.profile_id profileId,COALESCE(r.revision,0) profileRevision,s.desired_owner desiredOwner FROM sessions s LEFT JOIN session_profile_revisions r ON r.session_id=s.id"
            : "SELECT id,native_file nativeFile,native_id nativeId,project_id projectId,profile_id profileId,0 profileRevision,desired_owner desiredOwner FROM sessions",
        )
        .all() as unknown as SessionRecord[];
    } catch (e) {
      stable(e);
    }
  }
  setOwner(id: string, owner: Owner): void {
    try {
      this.db
        .prepare("UPDATE sessions SET desired_owner=? WHERE id=?")
        .run(owner, id);
    } catch (e) {
      stable(e);
    }
  }
  begin(
    sessionId: string,
    kind: string,
    operationId: string,
    payload: unknown,
  ): { receipt: Receipt; fresh: boolean } {
    const hash = createHash("sha256")
      .update(`${sessionId}\0${kind}\0${canonical(payload)}`)
      .digest("hex");
    try {
      const prior = this.db
        .prepare(
          "SELECT operation_id operationId,session_id sessionId,kind,status,result,payload_hash payloadHash FROM operations WHERE operation_id=?",
        )
        .get(operationId) as
        (Receipt & { payloadHash: string; result?: string }) | undefined;
      if (prior) {
        if (prior.payloadHash !== hash) throw new Error("operation_conflict");
        return {
          receipt: {
            operationId: prior.operationId,
            sessionId: prior.sessionId,
            kind: prior.kind as Receipt["kind"],
            status: prior.status,
            ...(prior.result !== null && prior.result !== undefined
              ? { result: JSON.parse(prior.result) as unknown }
              : {}),
          },
          fresh: false,
        };
      }
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(
          operationId,
          sessionId,
          kind,
          hash,
          "DISPATCHED",
          null,
          new Date().toISOString(),
        );
      return {
        receipt: {
          operationId,
          sessionId,
          kind: kind as Receipt["kind"],
          status: "DISPATCHED",
        },
        fresh: true,
      };
    } catch (e) {
      if (e instanceof Error && e.message === "operation_conflict")
        throw Object.assign(e, { statusCode: 409 });
      stable(e);
    }
  }
  unresolvedProfileSwitch(
    sessionId: string,
    exceptOperationId?: string,
  ): boolean {
    try {
      return !!this.db
        .prepare(
          "SELECT 1 FROM operations WHERE session_id=? AND kind='change_profile' AND status IN ('DISPATCHED','RECEIVED','UNKNOWN') AND (? IS NULL OR operation_id<>?) LIMIT 1",
        )
        .get(sessionId, exceptOperationId ?? null, exceptOperationId ?? null);
    } catch (e) {
      stable(e);
    }
  }
  commitProfileChange(
    sessionId: string,
    operationId: string,
    expectedProfileId: string,
    expectedRevision: number,
    targetProfileId: string,
    expectedOwner: Owner,
    result: unknown,
  ): number {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const current = this.db
          .prepare(
            "SELECT s.profile_id profileId,s.desired_owner desiredOwner,COALESCE(r.revision,0) revision FROM sessions s LEFT JOIN session_profile_revisions r ON r.session_id=s.id WHERE s.id=?",
          )
          .get(sessionId) as
          | { profileId: string; desiredOwner: Owner; revision: number }
          | undefined;
        if (
          !current ||
          current.profileId !== expectedProfileId ||
          current.revision !== expectedRevision ||
          current.desiredOwner !== expectedOwner
        )
          throw Object.assign(new Error("profile_conflict"), {
            statusCode: 409,
          });
        const receipt = this.db
          .prepare(
            "SELECT session_id sessionId,kind,status FROM operations WHERE operation_id=?",
          )
          .get(operationId) as
          { sessionId: string; kind: string; status: string } | undefined;
        if (
          !receipt ||
          receipt.sessionId !== sessionId ||
          receipt.kind !== "change_profile" ||
          receipt.status !== "DISPATCHED"
        )
          throw new Error("storage_error");
        const next =
          targetProfileId === expectedProfileId
            ? expectedRevision
            : expectedRevision + 1;
        if (targetProfileId !== expectedProfileId) {
          const updated = this.db
            .prepare("UPDATE sessions SET profile_id=? WHERE id=?")
            .run(targetProfileId, sessionId);
          if (updated.changes !== 1) throw new Error("storage_error");
          this.db
            .prepare(
              "INSERT INTO session_profile_revisions(session_id,revision) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision",
            )
            .run(sessionId, next);
        }
        const accepted = this.db
          .prepare(
            "UPDATE operations SET status='ACCEPTED',result=? WHERE operation_id=? AND session_id=? AND kind='change_profile' AND status='DISPATCHED'",
          )
          .run(JSON.stringify(result), operationId, sessionId);
        if (accepted.changes !== 1) throw new Error("storage_error");
        this.db.exec("COMMIT;");
        return next;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          /* Preserve original failure. */
        }
        throw e;
      }
    } catch (e) {
      if (
        e instanceof Error &&
        ["profile_conflict", "storage_error"].includes(e.message)
      )
        throw e;
      stable(e);
    }
  }
  finish(id: string, status: string, result?: unknown): void {
    try {
      if (result === undefined)
        this.db
          .prepare("UPDATE operations SET status=? WHERE operation_id=?")
          .run(status, id);
      else
        this.db
          .prepare(
            "UPDATE operations SET status=?,result=? WHERE operation_id=?",
          )
          .run(status, JSON.stringify(result), id);
    } catch (e) {
      stable(e);
    }
  }
  saveResult(id: string, result: unknown): void {
    try {
      this.db
        .prepare("UPDATE operations SET result=? WHERE operation_id=?")
        .run(JSON.stringify(result), id);
    } catch (e) {
      stable(e);
    }
  }
  latestCleared(
    sessionId: string,
  ): { kind: "steer" | "follow_up"; text: string }[] {
    try {
      const row = this.db
        .prepare(
          "SELECT result FROM operations WHERE session_id=? AND kind='stop' AND result IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(sessionId) as { result?: unknown } | undefined;
      if (!row || typeof row.result !== "string") return [];
      const result: unknown = JSON.parse(row.result);
      if (!result || typeof result !== "object" || Array.isArray(result))
        return [];
      const cleared = (result as { cleared?: unknown }).cleared;
      if (!Array.isArray(cleared)) return [];
      return cleared
        .filter(
          (item): item is { kind: "steer" | "follow_up"; text: string } =>
            !!item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            ((item as { kind?: unknown }).kind === "steer" ||
              (item as { kind?: unknown }).kind === "follow_up") &&
            typeof (item as { text?: unknown }).text === "string",
        )
        .map(({ kind, text }) => ({ kind, text }));
    } catch {
      stable(new Error("storage_error"));
    }
  }
  operation(id: string): Receipt | undefined {
    try {
      const r = this.db
        .prepare(
          "SELECT operation_id operationId,session_id sessionId,kind,status,result FROM operations WHERE operation_id=?",
        )
        .get(id) as (Receipt & { result?: string | null }) | undefined;
      return r
        ? {
            operationId: r.operationId,
            sessionId: r.sessionId,
            kind: r.kind as Receipt["kind"],
            status: r.status,
            ...(r.result !== null && r.result !== undefined
              ? { result: JSON.parse(r.result) as unknown }
              : {}),
          }
        : undefined;
    } catch (e) {
      stable(e);
    }
  }
  close(): void {
    this.db.close();
  }
}
