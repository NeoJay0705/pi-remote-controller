import { realpath, readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { isAbsolute, dirname, relative, resolve } from "node:path";
import type { Profile, Project, WorkspaceConfig } from "../shared/contracts.js";
import { validateListenConfig } from "./network.js";
import { refreshDiscoveredProjects } from "./project-discovery.js";
import {
  findPiPackageRoot,
  resolvePiFromPath,
  resolvePiPackageExtension,
} from "./pi-install.js";

function record(
  value: unknown,
  label: string,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`invalid_${label}`);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`invalid_${label}`);
  return value;
}
function safeId(value: unknown, label: string): string {
  const id = nonempty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    throw new Error(`invalid_${label}`);
  return id;
}
async function canonical(
  value: unknown,
  label: string,
  directory = false,
): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`invalid_${label}`);
  const path = await realpath(value);
  const st = await stat(path);
  if (directory ? !st.isDirectory() : !st.isFile())
    throw new Error(`invalid_${label}`);
  return path;
}
async function dataDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error("invalid_data_dir");
  const path = resolve(value);
  let existingParent = path;
  while (true) {
    try {
      await realpath(existingParent);
      break;
    } catch {
      const next = dirname(existingParent);
      if (next === existingParent) throw new Error("invalid_data_dir");
      existingParent = next;
    }
  }
  const canonicalParent = await realpath(existingParent);
  const resolved = resolve(canonicalParent, relative(existingParent, path));
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("invalid_data_dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (resolved === (await realpath(process.cwd())) || resolved === "/")
    throw new Error("invalid_data_dir");
  return resolved;
}
const THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export async function loadConfig(
  file = process.env.PRW_CONFIG,
): Promise<WorkspaceConfig> {
  if (typeof file !== "string" || !isAbsolute(file))
    throw new Error("config_required");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  record(parsed, "config", [
    "port",
    "publicOrigin",
    "dataDir",
    "piCli",
    "projects",
    "projectDiscovery",
    "profiles",
    "secureCookies",
    "listenHost",
    "allowTailnetHttp",
  ]);
  if (
    (parsed.secureCookies !== undefined &&
      typeof parsed.secureCookies !== "boolean") ||
    (parsed.listenHost !== undefined &&
      typeof parsed.listenHost !== "string") ||
    (parsed.allowTailnetHttp !== undefined &&
      typeof parsed.allowTailnetHttp !== "boolean")
  )
    throw new Error("invalid_config");
  if (
    !Number.isInteger(parsed.port) ||
    (parsed.port as number) < 1 ||
    (parsed.port as number) > 65535
  )
    throw new Error("invalid_port");
  if (typeof parsed.publicOrigin !== "string")
    throw new Error("invalid_origin");
  const url = new URL(parsed.publicOrigin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== parsed.publicOrigin ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (["localhost", "127.0.0.1"].includes(url.hostname) ||
          (parsed.allowTailnetHttp === true &&
            parsed.listenHost === url.hostname))
      ))
  )
    throw new Error("invalid_origin");
  const listenHost = validateListenConfig(
    parsed.listenHost as string | undefined,
    parsed.allowTailnetHttp as boolean | undefined,
    url.origin,
    parsed.port as number,
    networkInterfaces(),
  );
  if (
    !Array.isArray(parsed.projects) ||
    !Array.isArray(parsed.profiles) ||
    parsed.profiles.length === 0
  )
    throw new Error("invalid_config");
  if (parsed.projectDiscovery !== undefined)
    record(parsed.projectDiscovery, "project_discovery", [
      "root",
      "sessionRoot",
    ]);
  const dataDir = await dataDirectory(parsed.dataDir);
  let piCli: string;
  try {
    piCli =
      parsed.piCli === "pi"
        ? await resolvePiFromPath()
        : await canonical(parsed.piCli, "pi_cli");
  } catch {
    throw new Error("invalid_pi_cli");
  }
  let packageRoot: Promise<string> | undefined;
  const resolveExtension = async (value: string): Promise<string> => {
    if (!value.startsWith("pi:")) return canonical(value, "extension_path");
    packageRoot ??= findPiPackageRoot(piCli);
    return resolvePiPackageExtension(await packageRoot, value);
  };
  const projectDiscovery =
    parsed.projectDiscovery === undefined
      ? undefined
      : {
          root: await canonical(
            parsed.projectDiscovery.root,
            "project_discovery_root",
            true,
          ),
          sessionRoot: await canonicalNearestDirectory(
            parsed.projectDiscovery.sessionRoot,
            "project_discovery_session_root",
          ),
        };
  if (
    projectDiscovery &&
    (projectDiscovery.root === "/" || projectDiscovery.sessionRoot === "/")
  )
    throw new Error("invalid_project_discovery_root");
  const projects: Project[] = await Promise.all(
    parsed.projects.map(async (item: unknown) => {
      record(item, "project", ["id", "name", "cwd", "sessionDir"]);
      return {
        id: safeId(item.id, "project"),
        name: nonempty(item.name, "project"),
        cwd: await canonical(item.cwd, "project_cwd", true),
        sessionDir: await canonical(item.sessionDir, "session_dir", true),
      };
    }),
  );
  const profiles: Profile[] = await Promise.all(
    parsed.profiles.map(async (item: unknown) => {
      record(item, "profile", [
        "id",
        "name",
        "provider",
        "model",
        "thinking",
        "extensions",
        "tools",
        "appendSystemPrompts",
      ]);
      const profile: Profile = {
        id: safeId(item.id, "profile"),
        name: nonempty(item.name, "profile"),
      };
      for (const key of ["provider", "model"] as const)
        if (item[key] !== undefined)
          profile[key] = nonempty(item[key], "profile_setting");
      if ((profile.provider === undefined) !== (profile.model === undefined))
        throw new Error("invalid_profile_setting");
      if (item.thinking !== undefined) {
        if (typeof item.thinking !== "string" || !THINKING.has(item.thinking))
          throw new Error("invalid_profile_setting");
        profile.thinking = item.thinking;
      }
      if (item.tools !== undefined) {
        if (
          !Array.isArray(item.tools) ||
          item.tools.some((v: unknown) => typeof v !== "string")
        )
          throw new Error("invalid_profile_setting");
        profile.tools = item.tools;
      }
      if (item.extensions !== undefined) {
        if (
          !Array.isArray(item.extensions) ||
          item.extensions.some((v: unknown) => typeof v !== "string")
        )
          throw new Error("invalid_profile_setting");
        profile.extensions = await Promise.all(
          item.extensions.map((v: unknown) => resolveExtension(v as string)),
        );
      }
      if (item.appendSystemPrompts !== undefined) {
        if (
          !Array.isArray(item.appendSystemPrompts) ||
          item.appendSystemPrompts.some((v: unknown) => typeof v !== "string")
        )
          throw new Error("invalid_profile_setting");
        profile.appendSystemPrompts = await Promise.all(
          item.appendSystemPrompts.map((v: unknown) =>
            canonical(v, "prompt_path"),
          ),
        );
      }
      return profile;
    }),
  );
  if (projects.length === 0 && !projectDiscovery)
    throw new Error("invalid_config");
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    new Set(profiles.map((p) => p.id)).size !== profiles.length
  )
    throw new Error("duplicate_config_id");
  const config: WorkspaceConfig = {
    port: parsed.port as number,
    publicOrigin: url.origin,
    dataDir,
    piCli,
    projects,
    ...(projectDiscovery ? { projectDiscovery } : {}),
    profiles,
    secureCookies: url.protocol === "https:",
    listenHost,
    allowTailnetHttp: parsed.allowTailnetHttp === true,
  };
  await refreshDiscoveredProjects(config);
  return config;
}
async function canonicalNearestDirectory(
  value: unknown,
  label: string,
): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`invalid_${label}`);
  const path = resolve(value);
  let existing = path;
  while (true) {
    try {
      const actual = await realpath(existing);
      if (!(await stat(actual)).isDirectory())
        throw new Error(`invalid_${label}`);
      return resolve(actual, relative(existing, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`invalid_${label}`);
      existing = parent;
    }
  }
}
