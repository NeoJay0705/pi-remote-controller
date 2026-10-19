import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const shellPath = join(projectRoot, "scripts/service-restart.sh");

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "service-restart-"));
  const instance = join(root, ".test-artifacts/live-instance");
  const scripts = join(root, "scripts");
  await mkdir(instance, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "service-restart.sh"),
    await readFile(shellPath),
  );
  await writeFile(
    join(instance, "stop.mjs"),
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.EVENTS, 'stop\\n');\nif (process.env.FAIL_STAGE === 'stop') process.exit(7);\n",
  );
  await writeFile(
    join(instance, "start.mjs"),
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.EVENTS, 'start\\n');\n",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        build:
          "node -e \"require('node:fs').appendFileSync(process.env.EVENTS, 'build\\\\n'); if (process.env.FAIL_STAGE === 'build') process.exit(7)\"",
      },
    }),
  );
  const events = join(root, "events.log");
  const run = (args: string[] = [], failStage?: string) =>
    spawnSync("bash", [join(scripts, "service-restart.sh"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EVENTS: events, FAIL_STAGE: failStage },
    });
  return { root, events, run };
}

async function eventLines(path: string) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

it("runs stop, build, and start in order", async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.run();
    expect(result.status).toBe(0);
    expect(await eventLines(fixture.events)).toEqual([
      "stop",
      "build",
      "start",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it.each([
  ["stop", ["stop"]],
  ["build", ["stop", "build"]],
])("halts after %s failure", async (failure, expectedEvents) => {
  const fixture = await createFixture();
  try {
    const result = fixture.run([], failure);
    expect(result.status).toBe(7);
    expect(result.stderr).toContain(`${failure} failed`);
    expect(await eventLines(fixture.events)).toEqual(expectedEvents);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("rejects extra arguments and a held nonblocking lock", async () => {
  const fixture = await createFixture();
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const argsResult = fixture.run(["--restart-only"]);
    expect(argsResult.status).toBe(2);
    expect(await eventLines(fixture.events)).toEqual([]);

    const lockPath = join(
      fixture.root,
      ".test-artifacts/live-instance/service-restart.lock",
    );
    holder = spawn("/usr/bin/flock", ["-n", lockPath, "sleep", "5"]);
    await delay(100);
    const lockResult = fixture.run();
    expect(lockResult.status).toBe(1);
    expect(lockResult.stderr).toContain("another operation is in progress");
    expect(await eventLines(fixture.events)).toEqual([]);
  } finally {
    holder?.kill("SIGTERM");
    await rm(fixture.root, { recursive: true, force: true });
  }
});
