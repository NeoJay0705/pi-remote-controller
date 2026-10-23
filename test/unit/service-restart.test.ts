import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
    join(scripts, "service-stop.mjs"),
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
  const run = (
    args: string[] = [],
    failStage?: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync("bash", [join(scripts, "service-restart.sh"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENTS: events,
        FAIL_STAGE: failStage,
        ...extraEnv,
      },
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

it.each([
  ["closed", false, 0, ["build", "start"]],
  ["occupied", true, 1, []],
  ["ss error", "error", 1, []],
])(
  "uses the tracked stop CLI with an absent PID and %s port",
  async (_label, occupied, expectedStatus, expectedEvents) => {
    const fixture = await createFixture();
    const bin = join(fixture.root, "bin");
    const pid = 2_147_483_000;
    try {
      await expect(access(`/proc/${pid}`)).rejects.toThrow();
      await writeFile(
        join(fixture.root, "scripts/service-stop.mjs"),
        await readFile(join(projectRoot, "scripts/service-stop.mjs")),
      );
      await mkdir(bin);
      const fakeSs = join(bin, "ss");
      await writeFile(
        fakeSs,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$FAKE_SS_ARGS"\nif [[ "$FAKE_SS_ERROR" == "1" ]]; then exit 8; fi\nif [[ "$FAKE_SS_OCCUPIED" == "1" ]]; then printf 'LISTEN\\n'; fi\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(fixture.root, ".test-artifacts/live-instance/service.pid.json"),
        JSON.stringify({ pid, starttime: "12345" }),
      );
      const result = fixture.run([], undefined, {
        FAKE_SS_OCCUPIED: occupied === true ? "1" : "0",
        FAKE_SS_ERROR: occupied === "error" ? "1" : "0",
        FAKE_SS_ARGS: join(fixture.root, "ss-args.log"),
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(result.status).toBe(expectedStatus);
      expect(await eventLines(fixture.events)).toEqual(expectedEvents);
      expect(await readFile(join(fixture.root, "ss-args.log"), "utf8")).toBe(
        `-H\n-ltn\nsport\n=\n:4317\n`,
      );
      if (occupied === true) {
        expect(result.stderr).toContain("port 4317 is occupied");
      } else if (occupied === "error") {
        expect(result.stderr).toContain("service:stop:");
        expect(result.stderr).not.toContain("port 4317 is occupied");
      } else {
        expect(result.stdout).toContain("service:stop: already stopped");
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

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
