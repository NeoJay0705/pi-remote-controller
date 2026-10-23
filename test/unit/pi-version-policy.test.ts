import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { startServer } from "../../src/server/main.js";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  appClose: vi.fn(),
  leaseAcquire: vi.fn(),
  ledgerOpen: vi.fn(),
  runtimeShutdown: vi.fn(),
  appConfig: undefined as unknown,
  nativeInspect: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../src/server/app.js", () => ({
  createApp: (config: unknown) => {
    mocks.appConfig = config;
    return { listen: mocks.listen, close: mocks.appClose };
  },
}));
vi.mock("../../src/server/lease.js", () => ({
  WriterLease: { acquire: mocks.leaseAcquire },
}));
vi.mock("../../src/server/store.js", () => ({
  Ledger: { open: mocks.ledgerOpen },
}));
vi.mock("../../src/server/runtime.js", () => ({
  WorkspaceRuntime: class {
    shutdown = mocks.runtimeShutdown;
  },
}));
vi.mock("../../src/server/native-reader.js", () => ({
  inspectNative: mocks.nativeInspect,
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

let root: string;
let previousConfig: string | undefined;
let previousToken: string | undefined;
let previousPath: string | undefined;
let hadConfig = false;
let hadToken = false;
let hadPath = false;
let previousArgv: string[] = [];
let previousExitCode: number | undefined;

async function fixture(
  version?: string,
  configuredPiCli = join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "bin",
    "pi",
  ),
): Promise<{ config: string; piCli: string }> {
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const packageDir = join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const bin = join(root, "bin");
  const extension = join(
    packageDir,
    "examples",
    "extensions",
    "subagent",
    "index.ts",
  );
  await Promise.all([mkdir(project, { recursive: true }), mkdir(sessions)]);
  await mkdir(bin, { recursive: true });
  await mkdir(join(packageDir, "examples", "extensions", "subagent"), {
    recursive: true,
  });
  const piCli = join(packageDir, "bin", "pi");
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await writeFile(piCli, "synthetic pi executable\n");
  await chmod(piCli, 0o755);
  await symlink(piCli, join(bin, "pi"));
  await writeFile(extension, "sentinel extension\n");
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      ...(version === undefined ? {} : { version }),
    }),
  );
  process.env.PATH = bin;
  const config = join(root, `config-${version ?? "no-version"}.json`);
  await writeFile(
    config,
    JSON.stringify({
      port: 4317,
      publicOrigin: "http://127.0.0.1:4317",
      dataDir: join(root, "data"),
      piCli: configuredPiCli,
      projects: [
        { id: "project", name: "Project", cwd: project, sessionDir: sessions },
      ],
      profiles: [
        {
          id: "default",
          name: "Default",
          extensions: [`pi:examples/extensions/subagent/index.ts`],
        },
      ],
    }),
  );
  return { config, piCli };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prw-pi-version-policy-"));
  hadConfig = Object.hasOwn(process.env, "PRW_CONFIG");
  hadToken = Object.hasOwn(process.env, "PRW_OWNER_TOKEN");
  hadPath = Object.hasOwn(process.env, "PATH");
  previousConfig = process.env.PRW_CONFIG;
  previousToken = process.env.PRW_OWNER_TOKEN;
  previousPath = process.env.PATH;
  previousArgv = [...process.argv];
  previousExitCode = process.exitCode;
  mocks.listen.mockReset().mockResolvedValue(undefined);
  mocks.appClose.mockReset().mockResolvedValue(undefined);
  mocks.leaseAcquire.mockReset().mockResolvedValue({ close: vi.fn() });
  mocks.ledgerOpen
    .mockReset()
    .mockResolvedValue({ close: vi.fn(), session: vi.fn() });
  mocks.runtimeShutdown.mockReset().mockResolvedValue(undefined);
  mocks.appConfig = undefined;
  mocks.nativeInspect.mockReset();
  mocks.spawn.mockReset();
});

afterEach(async () => {
  if (hadConfig) process.env.PRW_CONFIG = previousConfig;
  else delete process.env.PRW_CONFIG;
  if (hadToken) process.env.PRW_OWNER_TOKEN = previousToken;
  else delete process.env.PRW_OWNER_TOKEN;
  if (hadPath) process.env.PATH = previousPath;
  else delete process.env.PATH;
  process.argv = previousArgv;
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe("Pi package version policy", () => {
  it.each([
    ["1.4.0", "versioned"],
    [undefined, "name-only"],
  ] as const)(
    "allows Controller startup and clean close for %s metadata via PATH (%s)",
    async (version) => {
      const { config, piCli } = await fixture(version, "pi");
      process.env.PRW_CONFIG = config;
      process.env.PRW_OWNER_TOKEN = "x".repeat(32);
      const loaded = await loadConfig();
      expect(loaded.piCli).toBe(piCli);
      expect(loaded.profiles[0]?.extensions).toEqual([
        join(
          root,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "examples",
          "extensions",
          "subagent",
          "index.ts",
        ),
      ]);
      const controller = await startServer();
      expect(mocks.appConfig).toMatchObject({
        piCli: loaded.piCli,
        profiles: loaded.profiles,
      });
      await controller.close();
      expect(mocks.listen).toHaveBeenCalledOnce();
      expect(mocks.appClose).toHaveBeenCalledOnce();
      expect(mocks.leaseAcquire).toHaveBeenCalledOnce();
      expect(mocks.runtimeShutdown).toHaveBeenCalledOnce();
    },
  );

  it("allows absolute CLI and extension Controller startup without package.json", async () => {
    const { config, piCli } = await fixture("1.4.0");
    const pkg = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await rm(join(pkg, "package.json"));
    const parsed = JSON.parse(await readFile(config, "utf8"));
    parsed.profiles[0].extensions = [
      join(pkg, "examples", "extensions", "subagent", "index.ts"),
    ];
    await writeFile(config, JSON.stringify(parsed));
    process.env.PRW_CONFIG = config;
    process.env.PRW_OWNER_TOKEN = "x".repeat(32);
    process.env.PATH = "";
    const leaseClose = vi.fn();
    mocks.leaseAcquire.mockResolvedValue({ close: leaseClose });
    const loaded = await loadConfig();
    expect(loaded.piCli).toBe(piCli);
    const controller = await startServer();
    await controller.close();
    expect(mocks.appClose).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();
  });

  it("retains piCli existence, absolute-path, and regular-file validation", async () => {
    const { config } = await fixture("1.4.0");
    const parsed = JSON.parse(await readFile(config, "utf8"));
    await writeFile(
      config,
      JSON.stringify({ ...parsed, piCli: join(root, "missing-pi") }),
    );
    await expect(loadConfig(config)).rejects.toThrow();
    await writeFile(
      config,
      JSON.stringify({ ...parsed, piCli: "relative-pi" }),
    );
    await expect(loadConfig(config)).rejects.toThrow("invalid_pi_cli");
    const directory = join(root, "pi-directory");
    await mkdir(directory);
    await writeFile(config, JSON.stringify({ ...parsed, piCli: directory }));
    await expect(loadConfig(config)).rejects.toThrow("invalid_pi_cli");
  });

  it("rejects an invalid owner token before acquiring the Controller lease", async () => {
    const { config } = await fixture("1.4.0", "pi");
    process.env.PRW_CONFIG = config;
    process.env.PRW_OWNER_TOKEN = "short";
    await expect(startServer()).rejects.toThrow("owner_token_invalid");
    expect(mocks.leaseAcquire).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("passes the resolved CLI and extension to the source CLI child process", async () => {
    const { config, piCli } = await fixture(undefined, "pi");
    process.env.PRW_CONFIG = config;
    const previousSignalListeners = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const session = {
      projectId: "project",
      profileId: "default",
      nativeFile: join(root, "native.jsonl"),
      nativeId: "native-sentinel",
      desiredOwner: "tui",
    };
    mocks.ledgerOpen.mockResolvedValue({
      close: vi.fn(),
      session: vi.fn(() => session),
    });
    mocks.nativeInspect.mockResolvedValue({
      id: "native-sentinel",
      file: session.nativeFile,
    });
    mocks.leaseAcquire.mockResolvedValue({ close: vi.fn(), fd: 3 });
    const leaseClose = vi.fn();
    const ledgerClose = vi.fn();
    mocks.leaseAcquire.mockResolvedValue({ close: leaseClose, fd: 3 });
    mocks.ledgerOpen.mockResolvedValue({
      close: ledgerClose,
      session: vi.fn(() => session),
    });
    const child = new EventEmitter() as EventEmitter & {
      exitCode: null;
      signalCode: null;
      kill: ReturnType<typeof vi.fn>;
    };
    Object.assign(child, { exitCode: null, signalCode: null, kill: vi.fn() });
    let resolveChildClose!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      resolveChildClose = resolve;
    });
    child.once("close", resolveChildClose);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    process.argv = [process.execPath, "prw", "tui", "--session", "sentinel"];
    await import("../../src/cli/main.js");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    const [executable, args] = mocks.spawn.mock.calls[0] as [string, string[]];
    expect(executable).toBe(process.execPath);
    expect(args[0]).toBe(piCli);
    const extension = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "examples",
      "extensions",
      "subagent",
      "index.ts",
    );
    expect(args[args.indexOf("-e") + 1]).toBe(extension);
    await vi.waitFor(async () => childClosed);
    await vi.waitFor(() => {
      expect(ledgerClose).toHaveBeenCalledOnce();
      expect(leaseClose).toHaveBeenCalledOnce();
    });
    expect(process.listenerCount("SIGINT")).toBe(
      previousSignalListeners.SIGINT,
    );
    expect(process.listenerCount("SIGTERM")).toBe(
      previousSignalListeners.SIGTERM,
    );
  });

  it.each([
    ["1.4.0", "versioned"],
    [undefined, "name-only"],
  ] as const)(
    "lets the CLI pass startup configuration for %s metadata",
    async (version) => {
      const { config } = await fixture(version, "pi");
      process.env.PRW_CONFIG = config;
      process.argv = [
        process.execPath,
        "prw",
        "tui",
        "--session",
        "synthetic-session",
      ];
      mocks.ledgerOpen.mockResolvedValue({
        close: vi.fn(),
        session: vi.fn(() => null),
      });
      const before = {
        SIGINT: process.listenerCount("SIGINT"),
        SIGTERM: process.listenerCount("SIGTERM"),
      };
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      await import("../../src/cli/main.js");
      await vi.waitFor(() =>
        expect(
          stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
        ).toContain("session_not_found"),
      );
      expect(stderr).toHaveBeenCalled();
      expect(
        stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("session_not_found");
      expect(mocks.ledgerOpen).toHaveBeenCalledOnce();
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    },
  );
});
