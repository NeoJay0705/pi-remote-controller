import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { WorkspaceConfig } from "../shared/contracts.js";
import {
  isStaticProject,
  piSessionDirectory,
  projectForCwd,
  refreshDiscoveredProjects,
} from "./project-discovery.js";

const MAX_ENTRIES = 10000;
let writeQueue: Promise<void> = Promise.resolve();

function discoveryConfig(config: WorkspaceConfig) {
  if (!config.projectDiscovery)
    throw new Error("project_discovery_unavailable");
  return config.projectDiscovery;
}
function validateRelativePath(rel: unknown, allowRoot: boolean): string[] {
  if (typeof rel !== "string") throw new Error("invalid_directory_path");
  if (rel === "" && allowRoot) return [];
  const segments = rel.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  )
    throw new Error("invalid_directory_path");
  return segments;
}
export async function resolveUnderRoot(
  root: string,
  rel: unknown,
): Promise<string> {
  const segments = validateRelativePath(rel, true);
  try {
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) throw new Error("invalid_directory_path");
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new Error("invalid_directory_path");
    }
    const actual = await realpath(current);
    if (actual !== current) throw new Error("invalid_directory_path");
    return current;
  } catch {
    throw new Error("invalid_directory_path");
  }
}
export async function readPickedPaths(
  config: WorkspaceConfig,
): Promise<string[]> {
  discoveryConfig(config);
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(config.dataDir, "picked-projects.json"), "utf8"),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { paths?: unknown }).paths) ||
      (parsed as { paths: unknown[] }).paths.some(
        (path) => typeof path !== "string",
      )
    )
      return [];
    return [...new Set((parsed as { paths: string[] }).paths)];
  } catch {
    return [];
  }
}
async function persistPath(
  config: WorkspaceConfig,
  path: string,
): Promise<void> {
  const task = writeQueue.then(async () => {
    const paths = await readPickedPaths(config);
    if (paths.includes(path)) return;
    paths.push(path);
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const file = join(config.dataDir, "picked-projects.json");
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, paths })}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
  });
  writeQueue = task.catch(() => undefined);
  await task;
}
function checkSessionDirectory(config: WorkspaceConfig, cwd: string): void {
  const { sessionRoot } = discoveryConfig(config);
  if (
    Buffer.byteLength(basename(piSessionDirectory(sessionRoot, cwd)), "utf8") >
    255
  )
    throw new Error("invalid_directory_path");
}
export async function listDirectories(
  config: WorkspaceConfig,
  rel: unknown,
): Promise<{ path: string; entries: string[] }> {
  const { root } = discoveryConfig(config);
  const directory = await resolveUnderRoot(root, rel);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error("invalid_directory_path");
  }
  if (entries.length > MAX_ENTRIES)
    throw new Error("project_discovery_too_large");
  const names: string[] = [];
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      entry.name.includes("\\") ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    try {
      const child = join(directory, entry.name);
      if (
        (await lstat(child)).isDirectory() &&
        !(await lstat(child)).isSymbolicLink()
      )
        names.push(entry.name);
    } catch {
      // Entries that disappear or become inaccessible during listing are omitted.
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return { path: typeof rel === "string" ? rel : "", entries: names };
}
export async function createDirectory(
  config: WorkspaceConfig,
  parentRel: unknown,
  name: unknown,
): Promise<{ path: string }> {
  const { root } = discoveryConfig(config);
  if (
    typeof name !== "string" ||
    !name ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    Buffer.byteLength(name, "utf8") > 255
  )
    throw new Error("invalid_directory_path");
  const parent = await resolveUnderRoot(root, parentRel);
  const cwd = join(parent, name);
  checkSessionDirectory(config, cwd);
  try {
    await mkdir(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("directory_exists");
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new Error("invalid_directory_path");
    throw new Error("directory_create_failed");
  }
  return { path: relative(root, cwd).split(sep).join("/") };
}
export async function selectProject(
  config: WorkspaceConfig,
  rel: unknown,
): Promise<{ id: string; name: string }> {
  const { root } = discoveryConfig(config);
  const segments = validateRelativePath(rel, false);
  const path = segments.join("/");
  const cwd = await resolveUnderRoot(root, path);
  checkSessionDirectory(config, cwd);
  const project = projectForCwd(config, cwd);
  if (isStaticProject(config, project))
    return { id: project.id, name: project.name };
  await persistPath(config, path);
  const projects = await refreshDiscoveredProjects(config);
  const selected = projects.find((known) => known.cwd === cwd);
  if (!selected) throw new Error("project_discovery_unavailable");
  return { id: selected.id, name: selected.name };
}
