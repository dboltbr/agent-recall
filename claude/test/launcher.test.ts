import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempState } from "../../core/test/fakes.ts";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "watch.sh");

/** A `node` that answers the launcher's version probe with `major`, and records how it was run. */
async function fakeNode(dir: string, major: number, out: string) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "node");
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = -e ]; then [ ${major} -ge 20 ]; exit $?; fi\nprintf '%s\\n' "$1" "$PATH" >"${out}"\n`,
  );
  await chmod(path, 0o755);
}

test("launcher: PATH de hook curto ganha os lugares de instalação, node velho fica de fora, bundle .mjs", async () => {
  const home = await tempState();
  const out = join(home, "ran");
  const old = join(home, "old-bin");
  await fakeNode(old, 18, join(home, "wrong"));
  await fakeNode(join(home, ".local", "share", "mise", "shims"), 22, out);
  // Only the tools the launcher itself uses, like the short PATH Claude Desktop hands to hooks.
  const tools = join(home, "tools");
  await mkdir(tools);
  for (const tool of ["dirname", "sed", "mkdir", "date"]) {
    const found = ["/usr/bin", "/bin"].map((dir) => join(dir, tool));
    for (const candidate of found) {
      try {
        await symlink(candidate, join(tools, tool));
        break;
      } catch {
        // Next candidate.
      }
    }
  }
  await new Promise<void>((resolve, reject) =>
    execFile("/bin/sh", [launcher], { env: { HOME: home, PATH: `${old}:${tools}`, CLAUDE_PID: "1" }, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(error);
      assert.equal(stdout, "", "nada no stdout");
      resolve();
    }),
  );
  const [script, path] = (await readFile(out, "utf8")).trim().split("\n");
  assert.match(script!, /\/dist\/watch\.mjs$/);
  const dirs = path!.split(":");
  assert.equal(dirs[0], old, "o PATH do Claude Code vem primeiro");
  for (const wanted of [join(home, ".local", "bin"), join(home, ".local", "share", "mise", "shims"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    assert.ok(dirs.includes(wanted), `${wanted} no PATH do filho`);
  }
  assert.equal(await readFile(join(home, "wrong"), "utf8").catch(() => null), null, "node 18 não roda o vigia");
});
