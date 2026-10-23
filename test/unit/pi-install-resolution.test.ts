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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

let root: string;
let oldPath: string | undefined;
let hadPath = false;
let oldCwd: string;
let configPath: string;
let configBytes: string;

async function installation(
  name: string,
  metadata: unknown = {
    name: "@earendil-works/pi-coding-agent",
  },
): Promise<{ pkg: string; bin: string; cli: string; extension: string }> {
  const pkg = join(root, name, "package");
  const bin = join(root, name, "bin");
  const cli = join(pkg, "dist", "cli.js");
  const extension = join(pkg, "examples", "extensions", "subagent", "index.ts");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(join(pkg, "examples", "extensions", "subagent"), {
    recursive: true,
  });
  await mkdir(bin, { recursive: true });
  await writeFile(cli, "synthetic cli\n");
  await writeFile(join(pkg, "package.json"), JSON.stringify(metadata));
  await writeFile(extension, `${name}\n`);
  await symlink(cli, join(bin, "pi"));
  await chmod(cli, 0o755);
  return { pkg, bin, cli, extension };
}

async function writeConfig(
  piCli = "pi",
  extension = "pi:examples/extensions/subagent/index.ts",
) {
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project, { recursive: true });
  await mkdir(sessions, { recursive: true });
  configPath = join(root, "config.json");
  configBytes = JSON.stringify({
    port: 4317,
    publicOrigin: "http://127.0.0.1:4317",
    dataDir: join(root, "data"),
    piCli,
    projects: [{ id: "p", name: "P", cwd: project, sessionDir: sessions }],
    profiles: [{ id: "default", name: "Default", extensions: [extension] }],
  });
  await writeFile(configPath, configBytes);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prw-pi-install-"));
  hadPath = Object.hasOwn(process.env, "PATH");
  oldPath = process.env.PATH;
  oldCwd = process.cwd();
  await writeConfig();
});

afterEach(async () => {
  process.chdir(oldCwd);
  if (hadPath) process.env.PATH = oldPath;
  else delete process.env.PATH;
  await rm(root, { recursive: true, force: true });
});

describe("Pi installation resolution", () => {
  it("selects PATH order, follows symlinks to their package, and fixes returned config", async () => {
    const a = await installation("A", {
      name: "@earendil-works/pi-coding-agent",
      version: "anything",
    });
    const b = await installation("B", {
      name: "@earendil-works/pi-coding-agent",
      version: 99,
    });
    process.env.PATH = `${a.bin}:${b.bin}`;
    const first = await loadConfig(configPath);
    expect(first.piCli).toBe(a.cli);
    expect(first.profiles[0]?.extensions).toEqual([a.extension]);
    process.env.PATH = `${b.bin}:${a.bin}`;
    expect(first.piCli).toBe(a.cli);
    expect(first.profiles[0]?.extensions).toEqual([a.extension]);
    const second = await loadConfig(configPath);
    expect(second.piCli).toBe(b.cli);
    expect(second.profiles[0]?.extensions).toEqual([b.extension]);
    expect(await readFile(configPath, "utf8")).toBe(configBytes);
    process.env.PATH = `${a.bin}:${b.bin}`;
    expect(first.piCli).toBe(a.cli);
    expect(first.profiles[0]?.extensions).toEqual([a.extension]);
    await rm(a.pkg, { recursive: true });
    const afterDanglingA = await loadConfig(configPath);
    expect(afterDanglingA.piCli).toBe(b.cli);
    expect(afterDanglingA.profiles[0]?.extensions).toEqual([b.extension]);
    expect(await readFile(configPath, "utf8")).toBe(configBytes);
  });

  it("does not fall through to a later Pi when the selected package lacks its extension", async () => {
    const a = await installation("A");
    const b = await installation("B");
    await rm(a.extension);
    process.env.PATH = `${a.bin}:${b.bin}`;
    await expect(loadConfig(configPath)).rejects.toThrow(
      "invalid_extension_path",
    );
  });

  it("skips leading directory and non-executable candidates for a later valid Pi", async () => {
    const pi = await installation("later-valid");
    const bad = join(root, "bad-candidates");
    const executable = join(root, "non-executable-candidates");
    await mkdir(join(bad, "pi"), { recursive: true });
    await mkdir(executable, { recursive: true });
    await writeFile(join(executable, "pi"), "not executable");
    await chmod(join(executable, "pi"), 0o644);
    process.env.PATH = `${bad}:${executable}:${pi.bin}`;
    const loaded = await loadConfig(configPath);
    expect(loaded.piCli).toBe(pi.cli);
    expect(loaded.profiles[0]?.extensions).toEqual([pi.extension]);
  });

  it("fails for unset PATH, absent candidates, directories, and non-executable files", async () => {
    const bin = join(root, "candidates");
    await mkdir(bin);
    await mkdir(join(bin, "pi"));
    process.env.PATH = bin;
    await expect(loadConfig(configPath)).rejects.toThrow("invalid_pi_cli");
    await rm(join(bin, "pi"), { recursive: true });
    await writeFile(join(bin, "pi"), "not executable");
    await chmod(join(bin, "pi"), 0o644);
    await expect(loadConfig(configPath)).rejects.toThrow("invalid_pi_cli");
    await rm(join(bin, "pi"));
    await symlink(join(bin, "missing-target"), join(bin, "pi"));
    await expect(loadConfig(configPath)).rejects.toThrow("invalid_pi_cli");
    delete process.env.PATH;
    await expect(loadConfig(configPath)).rejects.toThrow("invalid_pi_cli");
  });

  it("resolves empty and relative PATH entries from the working directory", async () => {
    const pi = await installation("cwd-install");
    process.chdir(join(root, "cwd-install"));
    await symlink(pi.cli, join(process.cwd(), "pi"));
    process.env.PATH = "";
    const emptyPath = await loadConfig(configPath);
    expect(emptyPath.piCli).toBe(pi.cli);
    expect(emptyPath.profiles[0]?.extensions).toEqual([pi.extension]);
    await rm(join(process.cwd(), "pi"));
    process.env.PATH = "bin";
    const relativePath = await loadConfig(configPath);
    expect(relativePath.piCli).toBe(pi.cli);
    expect(relativePath.profiles[0]?.extensions).toEqual([pi.extension]);
  });

  it("errors for malformed or mismatched package metadata", async () => {
    const pi = await installation("metadata");
    process.env.PATH = pi.bin;
    await writeFile(join(pi.pkg, "package.json"), "{");
    await expect(loadConfig(configPath)).rejects.toThrow(
      "pi_package_metadata_missing",
    );
    await writeFile(
      join(pi.pkg, "package.json"),
      JSON.stringify({ name: "other" }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      "pi_package_metadata_missing",
    );
  });

  it.each([
    "pi:",
    "pi:a//b",
    "pi:examples/extensions/subagent",
    "pi:../outside.ts",
    "pi:./inside.ts",
    "pi:/absolute.ts",
    "pi:a\\b.ts",
    "pi:bad\u0000name",
    "pi:missing.ts",
    "relative-extension.ts",
  ])(
    "rejects unsafe, missing, or non-alias relative extension %s",
    async (extension) => {
      const pi = await installation("unsafe");
      process.env.PATH = pi.bin;
      await writeConfig("pi", extension);
      await expect(loadConfig(configPath)).rejects.toThrow(
        "invalid_extension_path",
      );
    },
  );

  it("rejects extension symlinks escaping the selected package", async () => {
    const pi = await installation("escape");
    const outside = join(root, "outside.ts");
    await writeFile(outside, "outside");
    await symlink(outside, join(pi.pkg, "escape.ts"));
    process.env.PATH = pi.bin;
    await writeConfig("pi", "pi:escape.ts");
    await expect(loadConfig(configPath)).rejects.toThrow(
      "invalid_extension_path",
    );
  });

  it("keeps absolute CLI and extension compatibility without package.json", async () => {
    const pi = await installation("absolute");
    await rm(join(pi.pkg, "package.json"));
    process.env.PATH = "";
    const absoluteConfig = join(root, "absolute-config.json");
    const bytes = JSON.parse(configBytes);
    bytes.piCli = pi.cli;
    bytes.profiles[0].extensions = [pi.extension];
    await writeFile(absoluteConfig, JSON.stringify(bytes));
    const resolved = await loadConfig(absoluteConfig);
    expect(resolved.piCli).toBe(pi.cli);
    expect(resolved.profiles[0]?.extensions).toEqual([pi.extension]);
    await writeConfig("relative-pi", pi.extension);
    await expect(loadConfig(configPath)).rejects.toThrow("invalid_pi_cli");
    await writeConfig(pi.cli, "relative-extension.ts");
    await expect(loadConfig(configPath)).rejects.toThrow(
      "invalid_extension_path",
    );
    const directory = join(root, "absolute-directory-extension");
    await mkdir(directory);
    await writeConfig(pi.cli, directory);
    await expect(loadConfig(configPath)).rejects.toThrow(
      "invalid_extension_path",
    );
  });
});
