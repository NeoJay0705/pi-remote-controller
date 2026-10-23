import { access, realpath, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function controlled(code: string): Error {
  return new Error(code);
}

export async function resolvePiFromPath(): Promise<string> {
  const pathValue = process.env.PATH;
  const cwd = process.cwd();
  if (pathValue === undefined) throw controlled("invalid_pi_cli");
  for (const entry of pathValue.split(delimiter)) {
    const candidate = resolve(cwd, entry || ".", "pi");
    try {
      await access(candidate, constants.X_OK);
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(code ?? "")) continue;
      throw controlled("invalid_pi_cli");
    }
  }
  throw controlled("invalid_pi_cli");
}

export async function findPiPackageRoot(piCli: string): Promise<string> {
  let dir = dirname(piCli);
  while (true) {
    const packageFile = resolve(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(packageFile, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "name" in parsed &&
        (parsed as { name?: unknown }).name === PACKAGE_NAME
      )
        return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw controlled("pi_package_metadata_missing");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw controlled("pi_package_metadata_missing");
}

export async function resolvePiPackageExtension(
  root: string,
  reference: string,
): Promise<string> {
  try {
    const suffix = reference.slice("pi:".length);
    if (
      !suffix ||
      suffix.includes("\0") ||
      suffix.includes("\\") ||
      isAbsolute(suffix) ||
      suffix.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error();
    const candidate = resolve(root, ...suffix.split("/"));
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(candidate);
    const info = await stat(canonicalPath);
    const rel = relative(canonicalRoot, canonicalPath);
    if (
      !info.isFile() ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    )
      throw new Error();
    return canonicalPath;
  } catch {
    throw controlled("invalid_extension_path");
  }
}
