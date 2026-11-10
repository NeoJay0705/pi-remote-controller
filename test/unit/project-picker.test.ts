import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import {
  createDirectory,
  listDirectories,
  resolveUnderRoot,
  selectProject,
} from "../../src/server/project-picker.js";
import {
  piSessionDirectory,
  refreshDiscoveredProjects,
} from "../../src/server/project-discovery.js";
import { listNative, createNative } from "../../src/server/native-sessions.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const base = await mkdtemp(join(testRoot("project-picker"), "case-"));
  dirs.push(base);
  const root = join(base, "repos");
  const sessions = join(base, "pi", "sessions");
  await mkdir(root);
  await mkdir(sessions, { recursive: true });
  const config: WorkspaceConfig = {
    port: 1,
    publicOrigin: "http://127.0.0.1",
    dataDir: join(base, "data"),
    piCli: process.execPath,
    projects: [],
    profiles: [{ id: "f", name: "F" }],
    projectDiscovery: { root, sessionRoot: sessions },
  };
  return { base, root, sessions, config };
}
const idFor = (cwd: string) =>
  `repo-${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;

describe("nested project picker server", () => {
  it("validates relative paths and rejects symlink segments and root escapes", async () => {
    const { root, base, config } = await fixture();
    await mkdir(join(root, "safe"));
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(root, "link"));
    for (const path of [
      "..",
      "../outside",
      "/etc",
      ".hidden",
      "safe/../outside",
      "bad\\name",
      "link",
    ])
      await expect(resolveUnderRoot(root, path)).rejects.toThrow(
        "invalid_directory_path",
      );
    await expect(resolveUnderRoot(root, "missing")).rejects.toThrow(
      "invalid_directory_path",
    );
    await expect(selectProject(config, "")).rejects.toThrow(
      "invalid_directory_path",
    );
  });
  it("lists only real visible directories and supports nested on-demand browsing", async () => {
    const { root, base, config } = await fixture();
    await mkdir(join(root, "zeta", "nested"), { recursive: true });
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file"), "x");
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(root, "linked"));
    await symlink(join(root, "alpha"), join(root, "linkdir"));
    await expect(listDirectories(config, "")).resolves.toEqual({
      path: "",
      entries: ["alpha", "zeta"],
    });
    await expect(listDirectories(config, "zeta")).resolves.toEqual({
      path: "zeta",
      entries: ["nested"],
    });
  });
  it("creates a directory without git metadata and rejects invalid or existing names", async () => {
    const { root, config } = await fixture();
    await expect(createDirectory(config, "", "new-project")).resolves.toEqual({
      path: "new-project",
    });
    await expect(
      readFile(join(root, "new-project", ".git")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of [
      "",
      ".hidden",
      "a/b",
      "a\\b",
      "nul\0byte",
      "x".repeat(256),
    ])
      await expect(createDirectory(config, "", name)).rejects.toThrow(
        "invalid_directory_path",
      );
    await expect(createDirectory(config, "", "new-project")).rejects.toThrow(
      "directory_exists",
    );
  });
  it("enforces the 255-byte session-directory basename limit including UTF-8 names before creation", async () => {
    const { root, sessions, config } = await fixture();
    const prefixBytes =
      Buffer.byteLength(basename(piSessionDirectory(sessions, root)), "utf8") +
      1;
    const remaining = 255 - prefixBytes;
    const name =
      "é".repeat(Math.floor(remaining / 2)) + (remaining % 2 ? "x" : "");
    expect(
      Buffer.byteLength(
        basename(piSessionDirectory(sessions, join(root, name))),
        "utf8",
      ),
    ).toBe(255);
    const created = await createDirectory(config, "", name);
    expect(created.path).toBe(name);
    const overName = `${name}x`;
    await expect(createDirectory(config, "", overName)).rejects.toThrow(
      "invalid_directory_path",
    );
    await expect(readFile(join(root, overName))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("persists selected projects and reloads them with their Pi session directory and existing session", async () => {
    const { base, root, sessions, config } = await fixture();
    await mkdir(join(root, "container", "nested"), { recursive: true });
    const selected = await selectProject(config, "container/nested");
    const project = config.projects.find((item) => item.id === selected.id)!;
    const native = await createNative(project);
    const configFile = join(base, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        port: 1,
        publicOrigin: config.publicOrigin,
        dataDir: config.dataDir,
        piCli: process.execPath,
        projects: [],
        projectDiscovery: config.projectDiscovery,
        profiles: config.profiles,
      }),
    );
    const restarted = await loadConfig(configFile);
    const reloaded = restarted.projects.find(
      (item) => item.cwd === join(root, "container", "nested"),
    )!;
    expect(reloaded.id).toBe(selected.id);
    expect(reloaded.sessionDir).toBe(
      piSessionDirectory(sessions, reloaded.cwd),
    );
    expect(await listNative(reloaded)).toContainEqual(
      expect.objectContaining({ file: native.file }),
    );
    expect(
      JSON.parse(
        await readFile(join(config.dataDir, "picked-projects.json"), "utf8"),
      ),
    ).toEqual({ version: 1, paths: ["container/nested"] });
  });
  it("silently skips deleted picked paths and treats corrupt persistence as empty", async () => {
    const { root, config } = await fixture();
    await mkdir(join(root, "gone"));
    await selectProject(config, "gone");
    await rm(join(root, "gone"), { recursive: true });
    await expect(refreshDiscoveredProjects(config)).resolves.toEqual([]);
    await writeFile(join(config.dataDir, "picked-projects.json"), "not json");
    const fresh = { ...config, projects: [] };
    await expect(refreshDiscoveredProjects(fresh)).resolves.toEqual([]);
  });
  it("returns the existing id for first-level projects and preserves static projects", async () => {
    const { root, config } = await fixture();
    await mkdir(join(root, "first"));
    const [discovered] = await refreshDiscoveredProjects(config);
    expect(await selectProject(config, "first")).toEqual({
      id: discovered!.id,
      name: "first",
    });
    const staticCwd = join(root, "static");
    await mkdir(staticCwd);
    const staticProject = {
      id: "static-id",
      name: "Static name",
      cwd: staticCwd,
      sessionDir: join(root, "static-sessions"),
    };
    const staticConfig = { ...config, projects: [staticProject] };
    expect(await selectProject(staticConfig, "static")).toEqual({
      id: "static-id",
      name: "Static name",
    });
    expect(
      JSON.parse(
        await readFile(join(config.dataDir, "picked-projects.json"), "utf8"),
      ),
    ).toEqual({ version: 1, paths: ["first"] });
  });
  it("detects a project id collision before writing persistence", async () => {
    const { root, config } = await fixture();
    await mkdir(join(root, "nested"), { recursive: true });
    const cwd = join(root, "nested");
    config.projects.push({
      id: idFor(cwd),
      name: "collision",
      cwd: join(root, "elsewhere"),
      sessionDir: join(root, "sessions"),
    });
    await expect(selectProject(config, "nested")).rejects.toThrow(
      "project_discovery_collision",
    );
    await expect(
      readFile(join(config.dataDir, "picked-projects.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serves all picker APIs with auth, expected statuses, and normalized invalid paths", async () => {
    const { base, root, config } = await fixture();
    const ledger = await Ledger.open(join(base, "ledger"));
    const runtime = new WorkspaceRuntime(config, ledger);
    const token = "picker-owner-token-123456789012345";
    const app = createApp(config, ledger, runtime, token);
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/directories" }))
          .statusCode,
      ).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const headers = {
        cookie,
        origin: config.publicOrigin,
        "content-type": "application/json",
      };
      const browse = await app.inject({
        method: "GET",
        url: "/api/v1/directories",
        headers,
      });
      expect(browse.statusCode).toBe(200);
      expect(browse.json()).toEqual({ path: "", entries: [] });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/directories",
        headers,
        payload: { parent: "", name: "api-folder" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ path: "api-folder" });
      const selected = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { path: "api-folder" },
      });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toEqual({
        id: idFor(join(root, "api-folder")),
        name: "api-folder",
      });
      const exists = await app.inject({
        method: "POST",
        url: "/api/v1/directories",
        headers,
        payload: { parent: "", name: "api-folder" },
      });
      expect(exists.statusCode).toBe(409);
      expect(exists.json().error.code).toBe("directory_exists");
      for (const path of ["../outside", "missing"]) {
        const invalid = await app.inject({
          method: "GET",
          url: `/api/v1/directories?path=${encodeURIComponent(path)}`,
          headers,
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.code).toBe("invalid_directory_path");
      }
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
});
