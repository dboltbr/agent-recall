// Copies core/ (minus tests) into server/core/: Paseo compiles only client/, server/ and shared/,
// and resolves symlinks to their real path. Runs as the manifest `build` step on install/update.
import { cpSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "core");
const target = join(root, "server", "core");
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => {
    const inside = relative(source, path);
    return inside !== "test" && !inside.startsWith(`test${sep}`) && !inside.endsWith(".test.ts");
  },
});
