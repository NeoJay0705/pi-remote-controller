import { createHash } from "node:crypto";
import { realpath, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Project, WorkspaceConfig } from "../shared/contracts.js";

const INITIAL_STATIC = new WeakMap<WorkspaceConfig, Set<string>>();
const MAX_ENTRIES = 10000;
export function piSessionDirectory(sessionRoot: string, cwd: string): string {
  const encoded = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(sessionRoot, encoded);
}
export async function refreshDiscoveredProjects(
  config: WorkspaceConfig,
): Promise<Project[]> {
  const discovery = config.projectDiscovery;
  if (!discovery) return config.projects;
  if (!INITIAL_STATIC.has(config))
    INITIAL_STATIC.set(config, new Set(config.projects.map((p) => p.id)));
  let root: string;
  try {
    root = await realpath(discovery.root);
    if (root !== discovery.root)
      throw new Error("project_discovery_unavailable");
  } catch {
    throw new Error("project_discovery_unavailable");
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error("project_discovery_unavailable");
  }
  if (entries.length > MAX_ENTRIES)
    throw new Error("project_discovery_too_large");
  const staticIds = INITIAL_STATIC.get(config)!;
  const found: Project[] = [];
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    const cwd = join(root, entry.name);
    let actual: string;
    try {
      actual = await realpath(cwd);
    } catch {
      continue;
    }
    if (actual !== cwd || relative(root, actual).startsWith(`..${sep}`))
      continue;
    const staticProject = config.projects.find(
      (p) => staticIds.has(p.id) && p.cwd === cwd,
    );
    const id = `repo-${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;
    if (staticProject) {
      found.push(staticProject);
      continue;
    }
    const collision = config.projects.find((p) => p.id === id && p.cwd !== cwd);
    if (collision) throw new Error("project_discovery_collision");
    const known = config.projects.find((p) => p.id === id);
    const project = known ?? {
      id,
      name: basename(cwd),
      cwd,
      sessionDir: piSessionDirectory(discovery.sessionRoot, cwd),
    };
    found.push(project);
  }
  for (const project of found) {
    if (!config.projects.some((known) => known.id === project.id))
      config.projects.push(project);
  }
  const statics = config.projects.filter((p) => staticIds.has(p.id));
  const unique = (projects: Project[]) =>
    projects.filter(
      (p, index, all) =>
        all.findIndex((candidate) => candidate.id === p.id) === index,
    );
  const dynamic = unique(found.filter((p) => !staticIds.has(p.id))).sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return [...unique(statics), ...dynamic];
}
