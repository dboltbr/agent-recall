// server/core/ is the copy Paseo compiles; it must match core/ (run `npm run sync`). shared/ holds
// the copies of the pure release-status model the client bundle imports.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sources = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

test("server/core/ is an exact copy of core/", () => {
  const core = join(root, "core");
  const copy = join(root, "server", "core");
  assert.deepEqual(sources(copy), sources(core));
  for (const name of sources(core)) {
    assert.equal(readFileSync(join(copy, name), "utf8"), readFileSync(join(core, name), "utf8"), `${name} drifted`);
  }
});

test("shared/ carries exact copies of the release-status model and its imports", () => {
  // Read the list from the script without running it (running it would rewrite the copies).
  const script = readFileSync(join(root, "scripts", "sync-core.mjs"), "utf8");
  const list = /SHARED_FROM_CORE = \[([^\]]*)\]/.exec(script)?.[1] ?? "";
  const names = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(names.includes("release-status.ts"));
  for (const name of names) {
    assert.equal(
      readFileSync(join(root, "shared", name), "utf8"),
      readFileSync(join(root, "core", name), "utf8"),
      `shared/${name} drifted`,
    );
  }
});
