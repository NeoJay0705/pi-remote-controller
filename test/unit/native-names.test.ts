import { mkdtemp, rm, appendFile, writeFile, readFile } from "node:fs/promises";
import {
  appendFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../../src/shared/contracts.js";
import { readNativeName } from "../../src/server/native-reader.js";
import { createNative, listNative } from "../../src/server/native-sessions.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-names-"));
  dirs.push(root);
  const project: Project = {
    id: "p",
    name: "P",
    cwd: root,
    sessionDir: join(root, "sessions"),
  };
  return { root, project };
}

describe("native session name metadata", () => {
  it("uses the latest full-file session_info and treats an empty latest name as a clear", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "初始名稱");
    await appendFile(
      created.file,
      `${JSON.stringify({ type: "message", id: "branch", parentId: null })}\n${JSON.stringify({ type: "session_info", id: "rename-1", parentId: "not-current", name: "最新名稱" })}\n`,
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "named",
      name: "最新名稱",
    });
    await appendFile(
      created.file,
      `${JSON.stringify({ type: "session_info", id: "clear", parentId: null, name: "  " })}\n`,
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "unnamed",
    });
    await appendFile(
      created.file,
      `${JSON.stringify({ type: "session_info", id: "clear-missing", parentId: null })}\n`,
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "unnamed",
    });
  });
  it("uses the latest full-file name across a valid sibling branch", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "rootName");
    const lines = (await readFile(created.file, "utf8")).trimEnd().split("\n");
    const rootEntry = JSON.parse(lines[1]!) as { id: string };
    const activeNameId = "active-name-entry";
    await appendFile(
      created.file,
      `${JSON.stringify({ type: "session_info", id: activeNameId, parentId: rootEntry.id, name: "activeName" })}\n${JSON.stringify({ type: "session_info", id: "other-name-entry", parentId: rootEntry.id, name: "otherName" })}\n${JSON.stringify({ type: "message", id: "active-user-leaf", parentId: activeNameId, message: { role: "user", content: "active branch leaf" } })}\n`,
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "named",
      name: "otherName",
    });
  });
  it("ignores a partial tail and reports real per-file/shared byte exhaustion as incomplete", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "保留名稱");
    await appendFile(
      created.file,
      '{"type":"session_info","id":"partial","name":"stale"',
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "named",
      name: "保留名稱",
    });
    const constrained = await readNativeName(created.file, project, {
      sharedBudget: {
        bytes: 0,
        maxBytes: 32,
        deadline: Date.now() + 1000,
        now: Date.now,
        exhausted: false,
      },
    });
    expect(constrained).toEqual({ status: "incomplete" });
    const timed = await readNativeName(created.file, project, {
      sharedBudget: {
        bytes: 0,
        maxBytes: 8 * 1024 * 1024,
        deadline: Date.now() - 1,
        now: Date.now,
        exhausted: false,
      },
    });
    expect(timed).toEqual({ status: "incomplete" });
  });
  it("counts the full 2 MiB file scan and shared list budget without exceeding either limit", async () => {
    const { project } = await fixture();
    const first = await createNative(project, "far-away");
    const second = await createNative(project, "second");
    const payload = "x".repeat(2 * 1024 * 1024);
    await appendFile(
      first.file,
      `${JSON.stringify({ type: "message", id: "large", parentId: null, content: payload })}\n`,
    );
    const fixedClock = () => 100;
    const perFileBudget = {
      bytes: 0,
      maxBytes: 2 * 1024 * 1024,
      deadline: 100 + 5000,
      now: fixedClock,
      exhausted: false,
    };
    expect(
      await readNativeName(first.file, project, {
        sharedBudget: perFileBudget,
      }),
    ).toEqual({ status: "incomplete" });
    expect(perFileBudget.bytes).toBeGreaterThan(2 * 1024 * 1024 - 64 * 1024);
    expect(perFileBudget.bytes).toBeLessThanOrEqual(perFileBudget.maxBytes);

    const sharedFirst = await createNative(project, "shared-one");
    const sharedSecond = await createNative(project, "shared-two");
    const measure = {
      bytes: 0,
      maxBytes: 2 * 1024 * 1024,
      deadline: 100 + 5000,
      now: fixedClock,
      exhausted: false,
    };
    expect(
      await readNativeName(sharedFirst.file, project, {
        sharedBudget: measure,
      }),
    ).toEqual({ status: "named", name: "shared-one" });
    const firstCost = measure.bytes;
    const secondMeasure = {
      bytes: 0,
      maxBytes: 2 * 1024 * 1024,
      deadline: 100 + 5000,
      now: fixedClock,
      exhausted: false,
    };
    expect(
      await readNativeName(sharedSecond.file, project, {
        sharedBudget: secondMeasure,
      }),
    ).toEqual({ status: "named", name: "shared-two" });
    const shared = {
      bytes: 0,
      maxBytes: firstCost + 1,
      deadline: 100 + 5000,
      now: fixedClock,
      exhausted: false,
    };
    const firstInfo = await readNativeName(sharedFirst.file, project, {
      sharedBudget: shared,
    });
    expect(firstInfo).toEqual({ status: "named", name: "shared-one" });
    expect(shared.bytes).toBeGreaterThan(0);
    expect(shared.bytes).toBe(firstCost);
    const secondInfo = await readNativeName(sharedSecond.file, project, {
      sharedBudget: shared,
    });
    expect(secondInfo).toEqual({ status: "incomplete" });
    expect(shared.bytes).toBeLessThanOrEqual(shared.maxBytes);
    const listed = await listNative(project, { maxBytes: 180 });
    expect(listed).toHaveLength(4);
    expect(listed.map((candidate) => candidate.file)).toContain(second.file);
    expect(
      listed.every((candidate) => candidate.nameInfo?.status === "incomplete"),
    ).toBe(true);
  });
  it("returns error for invalid, oversized, and truncated name records and accepts CRLF", async () => {
    const { project } = await fixture();
    const created = await createNative(project);
    await appendFile(
      created.file,
      `${JSON.stringify({ type: "session_info", id: "crlf", parentId: null, name: "  CRLF 名稱  " })}\r\n`,
    );
    expect(await readNativeName(created.file, project)).toEqual({
      status: "named",
      name: "CRLF 名稱",
    });
    for (const name of [42, "雪".repeat(1366)]) {
      await writeFile(
        created.file,
        `${JSON.stringify({ type: "session", version: 3, id: created.id, cwd: project.cwd })}\n${JSON.stringify({ type: "session_info", id: "bad", parentId: null, name })}\n`,
      );
      expect(await readNativeName(created.file, project)).toMatchObject({
        status: "error",
        code: "invalid-record",
      });
    }
    await writeFile(
      created.file,
      `${JSON.stringify({ type: "session", version: 3, id: created.id, cwd: project.cwd })}\n{"type":"session_info","id":"cut","name":"${"x".repeat(20_000)}"}\n`,
    );
    expect(await readNativeName(created.file, project)).toMatchObject({
      status: "error",
      code: "invalid-record",
    });
  });
  it("counts time that expires after a scan starts and rejects a truncate race", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "stale");
    let calls = 0;
    const now = () => {
      calls++;
      return calls < 7 ? 100 : 1000;
    };
    expect(await readNativeName(created.file, project, { now })).toEqual({
      status: "incomplete",
    });
    expect(calls).toBeGreaterThan(3);

    let truncateCalls = 0;
    let truncated = false;
    const duringScan = () => {
      truncateCalls++;
      if (truncateCalls === 5) {
        truncateSync(created.file, 0);
        truncated = true;
      }
      return Date.now();
    };
    expect(
      await readNativeName(created.file, project, { now: duringScan }),
    ).toEqual({ status: "incomplete" });
    expect(truncated).toBe(true);
  });
  it("returns incomplete when the scanned path is replaced during the scan", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "before-replace");
    const replacement = `${JSON.stringify({ type: "session", version: 3, id: created.id, cwd: project.cwd })}\n${JSON.stringify({ type: "session_info", id: "new", parentId: null, name: "after-replace" })}\n`;
    const nextFile = `${created.file}.replacement`;
    let calls = 0;
    let replaced = false;
    const now = () => {
      calls++;
      if (calls === 5) {
        writeFileSync(nextFile, replacement);
        renameSync(nextFile, created.file);
        replaced = true;
      }
      return Date.now();
    };
    expect(await readNativeName(created.file, project, { now })).toEqual({
      status: "incomplete",
    });
    expect(replaced).toBe(true);
  });
  it("returns incomplete when the file is appended during the scan", async () => {
    const { project } = await fixture();
    const created = await createNative(project, "穩定名稱");
    let calls = 0;
    let appended = false;
    const now = () => {
      calls++;
      if (calls === 5) {
        appendFileSync(
          created.file,
          `${JSON.stringify({ type: "session_info", id: "race", parentId: null, name: "競態名稱" })}\n`,
        );
        appended = true;
      }
      return Date.now();
    };
    const result = await readNativeName(created.file, project, { now });
    expect(appended).toBe(true);
    expect(result.status).toBe("incomplete");
  });
});
