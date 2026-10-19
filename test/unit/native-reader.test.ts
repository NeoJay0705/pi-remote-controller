import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  link,
  readFile,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../../src/shared/contracts.js";
import {
  inspectNative,
  readNativePage,
  readNativeTail,
} from "../../src/server/native-reader.js";
import { listNative } from "../../src/server/native-sessions.js";
import { safeErrorCode } from "../../src/server/errors.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "native-reader-"));
  dirs.push(dir);
  const project: Project = { id: "p", name: "P", cwd: dir, sessionDir: dir };
  const file = join(dir, "session.jsonl");
  const rows = [
    { type: "session", version: 3, id: "native", cwd: dir },
    {
      type: "message",
      id: "a",
      parentId: null,
      message: { role: "user", content: "héllo" },
    },
    {
      type: "message",
      id: "b",
      parentId: "a",
      message: { role: "assistant", content: "world" },
    },
  ];
  await writeFile(file, `${rows.map(JSON.stringify).join("\r\n")}\r\n`, {
    mode: 0o600,
  });
  return { dir, file, project };
}
describe("bounded native JSONL reader", () => {
  it("inspects header, reads active tail/page and preserves source bytes", async () => {
    const { file, project } = await fixture();
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    expect((await inspectNative(file, project)).id).toBe("native");
    expect(await readNativeTail(file, project)).toMatchObject({
      id: "b",
      parentId: "a",
    });
    const page = await readNativePage(file, project, undefined, 2);
    expect(page.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ).toBe(before);
  });
  it("rejects history when the same file header has a different native ID", async () => {
    const { file, project } = await fixture();
    const rows = (await readFile(file, "utf8")).trim().split("\n");
    const header = JSON.parse(rows[0]!) as Record<string, unknown>;
    header.id = "replacement-native";
    rows[0] = JSON.stringify(header);
    await writeFile(file, `${rows.join("\n")}\n`);

    expect((await inspectNative(file, project)).id).toBe("replacement-native");
    expect(await listNative(project)).toContainEqual({
      file,
      id: "replacement-native",
      nameInfo: { status: "unnamed" },
    });
    await expect(
      readNativePage(file, project, undefined, 100, {
        expectedNativeId: "native",
      }),
    ).rejects.toThrow("reload-required");
    await expect(
      readNativeTail(file, project, { expectedNativeId: "native" }),
    ).rejects.toThrow("reload-required");
  });
  it("ignores a partial UTF-8 tail and returns the last complete record", async () => {
    const { file, project } = await fixture();
    const handle = await open(file, "a");
    try {
      await handle.write(
        Buffer.from('{"type":"message","id":"partial-雪', "utf8"),
      );
    } finally {
      await handle.close();
    }
    expect(await readNativeTail(file, project)).toMatchObject({ id: "b" });
    expect(
      (await readNativePage(file, project, undefined, 2)).entries.map(
        (e) => e.id,
      ),
    ).toEqual(["a", "b"]);
  });
  it("returns visible invalid candidates and rejects symlink/hardlink files", async () => {
    const { dir, file, project } = await fixture();
    expect(await listNative(project)).toContainEqual({
      file,
      id: "native",
      nameInfo: { status: "unnamed" },
    });
    const sl = join(dir, "symlink.jsonl"),
      hl = join(dir, "hardlink.jsonl");
    await symlink(file, sl);
    await link(file, hl);
    await expect(inspectNative(sl, project)).rejects.toThrow();
    await expect(inspectNative(hl, project)).rejects.toThrow();
    const bad = join(dir, "bad.jsonl");
    await writeFile(bad, "not-json\n");
    const candidates = await listNative(project);
    expect(
      candidates.some((candidate) => candidate.file === bad && candidate.error),
    ).toBe(true);
  });
  it("follows only the tail parent branch and pages each entry once", async () => {
    const { dir, file, project } = await fixture();
    const rows = [
      { type: "session", version: 3, id: "native", cwd: dir },
      { type: "message", id: "a", parentId: null },
      { type: "message", id: "a2", parentId: "a" },
      { type: "message", id: "b", parentId: null },
      { type: "message", id: "b2", parentId: "b" },
      ...Array.from({ length: 110 }, (_, i) => ({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? "b2" : `e${i - 1}`,
      })),
    ];
    await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await readNativePage(file, project, cursor, 7);
      seen.push(...page.entries.map((entry) => String(entry.id)));
      cursor = page.nextBefore;
    } while (cursor);
    expect(seen).toHaveLength(112);
    expect(new Set(seen).size).toBe(112);
    expect(seen).not.toContain("a");
    expect(seen).not.toContain("a2");
    expect(seen).toContain("e108");
    expect(seen).toContain("e109");
  });
  it("keeps an older retained message intact across oversized appended tool results", async () => {
    const { dir, file, project } = await fixture();
    const oldText = "u".repeat(4096);
    const rows = [
      { type: "session", version: 3, id: "native", cwd: dir },
      {
        type: "message",
        id: "old",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: oldText }] },
      },
    ];
    await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`);
    const initial = await readNativePage(file, project, undefined, 100);
    const initialOld = initial.entries.find((entry) => entry.id === "old")!;
    expect(
      (initialOld.message as { content: { type: string; text: string }[] })
        .content[0]!.text,
    ).toBe(oldText);
    expect(initialOld.truncated).not.toBe(true);

    const handle = await open(file, "a");
    try {
      let parentId = "old";
      for (let i = 0; i < 12; i++) {
        const id = `large-tool-${i}`;
        await handle.write(
          `${JSON.stringify({
            type: "message",
            id,
            parentId,
            message: {
              role: "toolResult",
              content: `tool-${i}-${"x".repeat(70 * 1024)}`,
            },
          })}\n`,
        );
        parentId = id;
      }
    } finally {
      await handle.close();
    }

    const seen: string[] = [];
    const oldEntries = [];
    let cursor: string | undefined;
    let finished = false;
    for (let calls = 0; calls < 20 && !finished; calls++) {
      const page = await readNativePage(file, project, cursor, 100);
      expect(page.stats.retainedBytes).toBeLessThanOrEqual(
        Math.floor((1024 * 1024 - 8192) / 6),
      );
      expect(
        Buffer.byteLength(JSON.stringify(page), "utf8"),
      ).toBeLessThanOrEqual(1024 * 1024);
      for (const entry of page.entries) {
        expect(seen).not.toContain(entry.id);
        seen.push(entry.id);
        if (entry.id === "old") oldEntries.push(entry);
      }
      if (page.incomplete) {
        expect(page.continuation).toBeDefined();
        cursor = page.continuation;
      } else if (page.nextBefore) cursor = page.nextBefore;
      else finished = true;
    }
    expect(finished).toBe(true);
    expect(seen).toHaveLength(13);
    expect(new Set(seen)).toEqual(
      new Set([
        "old",
        ...Array.from({ length: 12 }, (_, i) => `large-tool-${i}`),
      ]),
    );
    expect(oldEntries).toHaveLength(1);
    expect(
      (oldEntries[0]!.message as { content: { type: string; text: string }[] })
        .content[0]!.text,
    ).toBe(oldText);
    expect(oldEntries[0]!.truncated).not.toBe(true);
  });
  it("accepts ancestor-preserving append and rejects a new root branch", async () => {
    const a = await fixture();
    const first = await readNativePage(a.file, a.project, undefined, 1);
    await writeFile(
      a.file,
      `${JSON.stringify({ type: "message", id: "c", parentId: "b" })}\n`,
      { flag: "a" },
    );
    const continued = await readNativePage(
      a.file,
      a.project,
      first.nextBefore,
      1,
    );
    expect(continued.entries.map((entry) => entry.id)).toEqual(["a"]);

    const b = await fixture();
    const cursor = await readNativePage(b.file, b.project, undefined, 1);
    await writeFile(
      b.file,
      `${JSON.stringify({ type: "message", id: "root", parentId: null })}\n`,
      { flag: "a" },
    );
    await expect(
      readNativePage(b.file, b.project, cursor.nextBefore, 1),
    ).rejects.toThrow("reload-required");
  });
  it("continues reverse scanning across blocks without losing or repeating entries", async () => {
    const { dir, file, project } = await fixture();
    const rows: unknown[] = [
      { type: "session", version: 3, id: "native", cwd: dir },
      { type: "message", id: "a", parentId: null },
    ];
    for (let i = 0; i < 12_000; i++)
      rows.push({
        type: "message",
        id: `discard-${i}`,
        parentId: `other-${i}`,
      });
    rows.push({ type: "message", id: "z", parentId: "a" });
    await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`);

    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    let sawEmptyIncomplete = false;
    do {
      const page = await readNativePage(file, project, cursor, 2, {
        maxReadBytes: 128 * 1024,
      });
      expect(
        Buffer.byteLength(JSON.stringify(page), "utf8"),
      ).toBeLessThanOrEqual(1024 * 1024);
      seen.push(...page.entries.map((entry) => String(entry.id)));
      calls++;
      if (page.incomplete) {
        if (page.entries.length === 0) sawEmptyIncomplete = true;
        expect(page.continuation).toBeDefined();
        expect(page.entries.length > 0 || page.incomplete).toBe(true);
        expect(page.continuation).not.toBe(cursor);
        cursor = page.continuation;
      } else cursor = undefined;
    } while (cursor && calls < 20);

    expect(calls).toBeGreaterThan(10);
    expect(sawEmptyIncomplete).toBe(true);
    expect(cursor).toBeUndefined();
    expect(seen.sort()).toEqual(["a", "z"]);
    expect(new Set(seen).size).toBe(2);
  });
  it("rejects a missing parent at the header", async () => {
    const { dir, file, project } = await fixture();
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: dir })}\n${JSON.stringify({ type: "message", id: "child", parentId: "missing" })}\n`,
    );
    await expect(readNativePage(file, project)).rejects.toThrow(
      "native_parent_missing",
    );
  });
  it("stops at a root without scanning a huge discarded branch", async () => {
    const { dir, file, project } = await fixture();
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: dir })}\n${JSON.stringify({ type: "message", id: "discarded", parentId: null, content: "x".repeat(2 * 1024 * 1024) })}\n${JSON.stringify({ type: "message", id: "root", parentId: null })}\n`,
    );
    const page = await readNativePage(file, project);
    expect(page.entries.map((entry) => entry.id)).toEqual(["root"]);
    expect(page.stats.bytesRead).toBeLessThan(256 * 1024);
  });
  it("keeps escaped-control JSON responses within one MiB", async () => {
    const { dir, file, project } = await fixture();
    const rows: unknown[] = [
      { type: "session", version: 3, id: "native", cwd: dir },
    ];
    let parent: string | null = null;
    for (let i = 0; i < 40; i++) {
      const id = `escaped-${i}`;
      rows.push({
        type: "message",
        id,
        parentId: parent,
        message: { role: "user", content: "\u0000".repeat(64 * 1024) },
      });
      parent = id;
    }
    await writeFile(
      file,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const page = await readNativePage(file, project);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
  it("rejects same-size leaf rewrites using the captured fingerprint", async () => {
    const { file, project } = await fixture();
    const page = await readNativePage(file, project, undefined, 1);
    const original = await readFile(file, "utf8");
    const changed = original.replace('"content":"world"', '"content":"xxxxx"');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(file, changed);
    await expect(
      readNativePage(file, project, page.nextBefore, 1),
    ).rejects.toThrow("reload-required");
  });
  it("bounds mixed production-shaped payloads across a complete active chain", async () => {
    const { dir, file, project } = await fixture();
    const rows: unknown[] = [
      { type: "session", version: 3, id: "native", cwd: dir },
    ];
    let parentId: string | null = null;
    for (let i = 0; i < 5; i++) {
      const id = `bounded-${i}`;
      const payload =
        i === 0
          ? {
              role: "toolResult",
              content: Array.from({ length: 100 }, (_, n) => ({
                type: "text",
                text: `tool-${n}-${"x".repeat(4096)}`,
              })),
            }
          : i === 1
            ? { role: "assistant", content: "small" }
            : { role: "user", content: "small" };
      rows.push({
        type: "message",
        id,
        parentId,
        message: payload,
        ...(i === 2
          ? {
              details: {
                results: Array.from({ length: 80 }, (_, n) => ({
                  message: {
                    role: "assistant",
                    content: [
                      { type: "text", text: `nested-${n}-${"y".repeat(2048)}` },
                    ],
                  },
                })),
                id: 42,
                parentId: 7,
              },
            }
          : {}),
      });
      parentId = id;
    }
    await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`, {
      mode: 0o600,
    });
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    const seen: string[] = [];
    const entriesById = new Map<string, { parentId: string | null }>();
    let cursor: string | undefined;
    let sawTruncated = false;
    do {
      const page = await readNativePage(file, project, cursor, 2);
      expect(
        Buffer.byteLength(JSON.stringify(page), "utf8"),
      ).toBeLessThanOrEqual(1024 * 1024);
      const ids = page.entries.map((entry) => entry.id);
      seen.push(...ids);
      for (const entry of page.entries)
        entriesById.set(entry.id, { parentId: entry.parentId });
      sawTruncated ||=
        page.truncated || page.entries.some((entry) => entry.truncated);
      cursor = page.nextBefore;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(entriesById.get("bounded-0")?.parentId).toBeNull();
    for (let i = 1; i < 5; i++)
      expect(entriesById.get(`bounded-${i}`)?.parentId).toBe(
        `bounded-${i - 1}`,
      );
    expect(sawTruncated).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ).toBe(before);
  });
  it("classifies malformed complete tail records as invalid-record for tail and page", async () => {
    const { dir, file, project } = await fixture();
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: dir })}\n{"type":"message",BROKEN}\n`,
    );
    await expect(readNativeTail(file, project)).rejects.toSatisfy(
      (error: unknown) => safeErrorCode(error) === "invalid-record",
    );
    await expect(readNativePage(file, project)).rejects.toSatisfy(
      (error: unknown) => safeErrorCode(error) === "invalid-record",
    );
  });
  it("accepts empty snapshots and rejects a cursor after truncation", async () => {
    const empty = await fixture();
    await writeFile(
      empty.file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: empty.dir })}\n`,
    );
    expect((await readNativePage(empty.file, empty.project)).entries).toEqual(
      [],
    );

    const snapshot = await fixture();
    const page = await readNativePage(
      snapshot.file,
      snapshot.project,
      undefined,
      1,
    );
    await writeFile(
      snapshot.file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: snapshot.dir })}\n`,
    );
    await expect(
      readNativePage(snapshot.file, snapshot.project, page.nextBefore, 1),
    ).rejects.toThrow("reload-required");
  });
  it("rejects tampered and cross-file cursors", async () => {
    const a = await fixture();
    const page = await readNativePage(a.file, a.project, undefined, 1);
    expect(page.nextBefore).toBeDefined();
    await expect(
      readNativePage(a.file, a.project, `${page.nextBefore}x`, 1),
    ).rejects.toThrow();
    const b = await fixture();
    await expect(
      readNativePage(b.file, b.project, page.nextBefore, 1),
    ).rejects.toThrow();
  });
});
