import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testRoot } from "../helpers/environment.js";
import { tokenMatches } from "../../src/server/auth.js";
import {
  createNative,
  historyPage,
  validateNative,
} from "../../src/server/native-sessions.js";
import { Ledger } from "../../src/server/store.js";
import type { Project } from "../../src/shared/contracts.js";

const root = testRoot("backend");

describe("backend primitives", () => {
  it("compares owner tokens and rejects short values", () => {
    expect(tokenMatches("a".repeat(32), "a".repeat(32))).toBe(true);
    expect(tokenMatches("b".repeat(32), "a".repeat(32))).toBe(false);
    expect(tokenMatches("short", "short")).toBe(false);
  });
  it("creates and validates native v3 files without accepting links or corrupt UTF-8", async () => {
    const dir = await mkdtemp(join(root, "native-"));
    try {
      const project: Project = {
        id: "p",
        name: "p",
        cwd: dir,
        sessionDir: dir,
      };
      const n = await createNative(project);
      const valid = await validateNative(n.file, project);
      expect(valid.id).toBe(n.id);
      expect((await readFile(n.file)).toString()).toContain('"version":3');
      const link = join(dir, "linked.jsonl");
      await (await import("node:fs/promises")).symlink(n.file, link);
      await expect(validateNative(link, project)).rejects.toThrow();
      const bad = join(dir, "bad.jsonl");
      await writeFile(bad, Buffer.from([0xff]));
      await expect(validateNative(bad, project)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("deduplicates operation receipts and marks payload conflicts", async () => {
    const dir = await mkdtemp(join(root, "ledger-"));
    const ledger = await Ledger.open(dir);
    try {
      const p = join(dir, "s.jsonl");
      await writeFile(p, "{}\n");
      const session = ledger.createSession({
        nativeFile: p,
        nativeId: "n",
        projectId: "p",
        profileId: "f",
      });
      const first = ledger.begin(
        session.id,
        "prompt",
        "123e4567-e89b-12d3-a456-426614174000",
        { text: "hello" },
      );
      expect(first.fresh).toBe(true);
      const second = ledger.begin(
        session.id,
        "prompt",
        "123e4567-e89b-12d3-a456-426614174000",
        { text: "hello" },
      );
      expect(second.fresh).toBe(false);
      expect(() =>
        ledger.begin(
          session.id,
          "prompt",
          "123e4567-e89b-12d3-a456-426614174000",
          { text: "different" },
        ),
      ).toThrow();
      ledger.finish(first.receipt.operationId, "ACCEPTED");
      expect(ledger.operation(first.receipt.operationId)?.status).toBe(
        "ACCEPTED",
      );
    } finally {
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("paginates native entries with bounded page sizes", async () => {
    const dir = await mkdtemp(join(root, "history-"));
    try {
      const project: Project = {
        id: "p",
        name: "p",
        cwd: dir,
        sessionDir: dir,
      };
      const n = await createNative(project);
      const entries = Array.from({ length: 4 }, (_, i) => ({
        type: "message",
        id: `${i}`,
        parentId: i ? `${i - 1}` : null,
      }));
      await writeFile(
        n.file,
        `${JSON.stringify({ type: "session", version: 3, id: n.id, cwd: dir })}\n${entries.map(JSON.stringify).join("\n")}\n`,
      );
      const page = historyPage(
        await validateNative(n.file, project),
        undefined,
        2,
      );
      expect(page.entries).toHaveLength(2);
      expect(page.nextBefore).toBe("2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
