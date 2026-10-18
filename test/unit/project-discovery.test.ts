import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  refreshDiscoveredProjects,
  piSessionDirectory,
} from "../../src/server/project-discovery.js";
import { createNative, listNative } from "../../src/server/native-sessions.js";
import { createApp } from "../../src/server/app.js";
import { Ledger } from "../../src/server/store.js";
import { WorkspaceRuntime } from "../../src/server/runtime.js";
import type { WorkspaceConfig } from "../../src/shared/contracts.js";
import { testRoot } from "../helpers/environment.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const base = await mkdtemp(join(testRoot("project-discovery"), "case-"));
  dirs.push(base);
  const root = join(base, "repos"),
    sessions = join(base, "pi", "sessions");
  await mkdir(root);
  await mkdir(sessions, { recursive: true });
  const config: WorkspaceConfig = {
    port: 1,
    publicOrigin: "http://127.0.0.1",
    dataDir: join(base, "data"),
    piCli: "unused",
    projects: [],
    profiles: [{ id: "f", name: "F" }],
    projectDiscovery: { root, sessionRoot: sessions },
  };
  return { base, root, sessions, config };
}
describe("repo-root project discovery", () => {
  it("uses Pi's literal cwd encoding for private session directories", () => {
    expect(piSessionDirectory("/sessions", "/workspace/a:b")).toBe(
      "/sessions/--workspace-a-b--",
    );
  });
  it("lists only direct real directories, retains known records, and refreshes additions/removals", async () => {
    const { root, sessions, config } = await fixture();
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "alpha", "nested"));
    await symlink(join(root, "alpha"), join(root, "linked"));
    const first = await refreshDiscoveredProjects(config);
    expect(first.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(
      first.every((p) => p.sessionDir === piSessionDirectory(sessions, p.cwd)),
    ).toBe(true);
    const ids = new Map(first.map((p) => [p.cwd, p.id]));
    await mkdir(join(root, "gamma"));
    expect(
      (await refreshDiscoveredProjects(config)).map((p) => p.name).sort(),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(config.projects.map((p) => p.name).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    await rm(join(root, "beta"), { recursive: true });
    expect(
      (await refreshDiscoveredProjects(config)).map((p) => p.name).sort(),
    ).toEqual(["alpha", "gamma"]);
    expect(config.projects.some((p) => p.name === "beta")).toBe(true);
    await expect(
      refreshDiscoveredProjects(config).then(
        (ps) => ps.find((p) => p.cwd === join(root, "alpha"))?.id,
      ),
    ).resolves.toBe(ids.get(join(root, "alpha")));
  });
  it("fails safely if the configured discovery root is replaced by a symlink", async () => {
    const { base, root, config } = await fixture();
    await refreshDiscoveredProjects(config);
    const outside = join(base, "outside");
    await mkdir(join(outside, "escaped"), { recursive: true });
    await rm(root, { recursive: true });
    await symlink(outside, root);
    await expect(refreshDiscoveredProjects(config)).rejects.toThrow(
      "project_discovery_unavailable",
    );
    expect(config.projects).toEqual([]);
  });
  it("preserves a configured static project alongside discovered repositories", async () => {
    const { root, config } = await fixture();
    const cwd = join(root, "fixed");
    await mkdir(cwd);
    config.projects.push({
      id: "legacy-id",
      name: "Fixed workspace",
      cwd,
      sessionDir: join(root, "fixed-sessions"),
    });
    const projects = await refreshDiscoveredProjects(config);
    expect(projects).toEqual([
      expect.objectContaining({ id: "legacy-id", name: "Fixed workspace" }),
    ]);
  });
  it("keeps static projects first in config order before alphabetized discoveries", async () => {
    const { root, config } = await fixture();
    const staticCwd = join(root, "fixed");
    await mkdir(staticCwd);
    await mkdir(join(root, "Alpha repo"));
    await mkdir(join(root, "Zeta repo"));
    config.projects.push({
      id: "legacy-id",
      name: "Zulu workspace",
      cwd: staticCwd,
      sessionDir: join(root, "fixed-sessions"),
    });
    const projects = await refreshDiscoveredProjects(config);
    expect(projects.map((project) => project.name)).toEqual([
      "Zulu workspace",
      "Alpha repo",
      "Zeta repo",
    ]);
    expect(projects[0]).toEqual(
      expect.objectContaining({ id: "legacy-id", name: "Zulu workspace" }),
    );
  });
  it("serves project and native-session GETs without spawning Pi or creating session directories", async () => {
    const { root, base, config } = await fixture();
    const cwd = join(root, "repo");
    await mkdir(cwd);
    const project = (await refreshDiscoveredProjects(config))[0]!;
    const ledger = await Ledger.open(join(base, "data"));
    const runtime = new WorkspaceRuntime(config, ledger);
    const token = "discovery-test-owner-token-123456789012";
    const app = createApp(config, ledger, runtime, token);
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          origin: config.publicOrigin,
          "content-type": "application/json",
        },
        payload: { token },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const projects = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { cookie },
      });
      expect(projects.statusCode).toBe(200);
      expect(projects.json()).toContainEqual({ id: project.id, name: "repo" });
      const native = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/native-sessions`,
        headers: { cookie },
      });
      expect(native.statusCode).toBe(200);
      expect(native.json()).toEqual([]);
      const { access } = await import("node:fs/promises");
      await expect(access(project.sessionDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await app.close();
      await runtime.shutdown();
      ledger.close();
    }
  });
  it("does not create discovered session directories on GET-style reads; createNative creates only on request", async () => {
    const { root, config } = await fixture();
    const cwd = join(root, "repo");
    await mkdir(cwd);
    const project = (await refreshDiscoveredProjects(config))[0]!;
    expect(await listNative(project)).toEqual([]);
    const { access } = await import("node:fs/promises");
    await expect(access(project.sessionDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const native = await createNative(project);
    expect(native.file.startsWith(project.sessionDir)).toBe(true);
    await access(project.sessionDir);
  });
});
