import {
  mkdtemp,
  rm,
  writeFile,
  utimes,
  stat,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../../src/shared/contracts.js";
import { inspectNative } from "../../src/server/native-reader.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("native file update time metadata", () => {
  it("projects a fixed, Date-representable mtime from the inspected file descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-list-time-"));
    dirs.push(dir);
    const file = join(dir, "session.jsonl");
    const project: Project = { id: "p", name: "P", cwd: dir, sessionDir: dir };
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "native", cwd: dir })}\n`,
    );
    const fixedTime = new Date("2022-03-04T05:06:07.000Z");
    await utimes(file, fixedTime, fixedTime);
    const content = await readFile(file);
    const mtime = (await stat(file)).mtimeMs;

    const metadata = await inspectNative(file, project);

    expect(metadata.fileUpdatedAt).toBe(fixedTime.getTime());
    expect(Number.isFinite(metadata.fileUpdatedAt)).toBe(true);
    expect(metadata.fileUpdatedAt).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(new Date(metadata.fileUpdatedAt!).getTime())).toBe(
      true,
    );
    expect(await readFile(file)).toEqual(content);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });
});
