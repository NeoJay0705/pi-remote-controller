import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/server/store.js";
import { testRoot } from "../helpers/environment.js";

const root = testRoot("session-profile-store");

describe("session profile revision storage", () => {
  it("commits profile, CAS revision, and ACCEPTED receipt atomically", async () => {
    const dir = await mkdtemp(join(root, "ledger-"));
    const ledger = await Ledger.open(dir);
    try {
      const session = ledger.createSession({
        nativeFile: join(dir, "native.jsonl"),
        nativeId: "native",
        projectId: "p",
        profileId: "a",
      });
      const id = "123e4567-e89b-42d3-a456-426614174000";
      ledger.begin(session.id, "change_profile", id, { profileId: "b" });
      expect(
        ledger.commitProfileChange(session.id, id, "a", 0, "b", "web", {
          status: "profile_saved",
        }),
      ).toBe(1);
      expect(ledger.session(session.id)).toMatchObject({
        profileId: "b",
        profileRevision: 1,
      });
      expect(ledger.operation(id)).toMatchObject({
        status: "ACCEPTED",
        result: { status: "profile_saved" },
      });
      expect(() =>
        ledger.commitProfileChange(session.id, id, "a", 0, "a", "web", {}),
      ).toThrow("profile_conflict");

      const rollbackId = "123e4567-e89b-42d3-a456-426614174002";
      ledger.begin(session.id, "change_profile", rollbackId, {
        profileId: "c",
      });
      ledger.db
        .exec(`CREATE TRIGGER fail_profile_receipt BEFORE UPDATE ON operations
        WHEN NEW.operation_id='${rollbackId}' AND NEW.status='ACCEPTED'
        BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;`);
      expect(() =>
        ledger.commitProfileChange(
          session.id,
          rollbackId,
          "b",
          1,
          "c",
          "web",
          {},
        ),
      ).toThrow("storage_error");
      expect(ledger.session(session.id)).toMatchObject({
        profileId: "b",
        profileRevision: 1,
      });
      expect(ledger.operation(rollbackId)?.status).toBe("DISPATCHED");
      ledger.db.exec("DROP TRIGGER fail_profile_receipt;");
      expect(() =>
        ledger.commitProfileChange(session.id, id, "a", 0, "c", "web", {}),
      ).toThrow("profile_conflict");

      const wrongSession = ledger.createSession({
        nativeFile: join(dir, "other-native.jsonl"),
        nativeId: "other",
        projectId: "p",
        profileId: "a",
      });
      const invalidId = "123e4567-e89b-42d3-a456-426614174003";
      ledger.begin(session.id, "change_profile", invalidId, {});
      expect(() =>
        ledger.commitProfileChange(
          wrongSession.id,
          invalidId,
          "a",
          0,
          "b",
          "web",
          {},
        ),
      ).toThrow("storage_error");
      const wrongKindId = "123e4567-e89b-42d3-a456-426614174004";
      ledger.begin(session.id, "prompt", wrongKindId, {});
      expect(() =>
        ledger.commitProfileChange(
          session.id,
          wrongKindId,
          "b",
          1,
          "c",
          "web",
          {},
        ),
      ).toThrow("storage_error");
      const backId = "123e4567-e89b-42d3-a456-426614174005";
      ledger.begin(session.id, "change_profile", backId, { profileId: "a" });
      expect(
        ledger.commitProfileChange(session.id, backId, "b", 1, "a", "web", {}),
      ).toBe(2);
      expect(ledger.session(session.id)).toMatchObject({
        profileId: "a",
        profileRevision: 2,
      });
      const staleId = "123e4567-e89b-42d3-a456-426614174006";
      ledger.begin(session.id, "change_profile", staleId, { profileId: "b" });
      expect(() =>
        ledger.commitProfileChange(session.id, staleId, "a", 0, "b", "web", {}),
      ).toThrow("profile_conflict");
      expect(ledger.operation(staleId)?.status).toBe("DISPATCHED");
    } finally {
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
