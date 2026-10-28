// Copies core/ (minus tests) into server/core/: Paseo compiles only client/, server/ and shared/,
// and resolves symlinks to their real path. Runs as the manifest `build` step on install/update.
// The pure release-status model (and what it imports) also goes to shared/, the only directory
// the Paseo client bundle may import.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED_FROM_CORE = ["release-cards.ts", "release-copy.ts", "release-status.ts", "trailer.ts", "types.ts"];

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
mkdirSync(join(root, "shared"), { recursive: true });
for (const name of SHARED_FROM_CORE) cpSync(join(source, name), join(root, "shared", name));
