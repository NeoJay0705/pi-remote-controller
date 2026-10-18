import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function testRoot(group: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(group)) {
    throw new Error("test_root_invalid_group");
  }
  const runRoot = process.env.PRW_TEST_RUN_DIR
    ? resolve(process.env.PRW_TEST_RUN_DIR)
    : resolve(
        repoRoot,
        ".test-artifacts",
        "standalone-tests",
        String(process.pid),
      );
  const root = resolve(runRoot, group);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
