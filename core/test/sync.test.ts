// server/core/ is the copy Paseo compiles; it must match core/ (run `npm run sync`).
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
