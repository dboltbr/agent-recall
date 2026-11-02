// Runs the test suite with a private TMPDIR and fails when a test leaves anything in it: test temp
// directories once filled the shared /tmp (tests write multi-megabyte files). The test run has its
// own process group: Ctrl-C or SIGTERM signals the whole group (the runner and every test file
// process). The private TMPDIR is removed in every case, a failed spawn included.
//
// Manual checks: (1) start `node scripts/test.mjs` in the background, wait until it runs, then
// `kill -TERM <pid>`: exit 143, no agent-recall-suite-* left in the system temp directory and no
// `node --test` process left. (2) a copy with `process.execPath` replaced by a missing binary:
// exit 1 with "não consegui rodar os testes" and no agent-recall-suite-* left.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

const dirs = ["core/test/", "opencode/test/", "openchamber/test/", "client/test/", "claude/test/"];
const root = mkdtempSync(join(tmpdir(), "agent-recall-suite-"));
let code = 1;
try {
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...dirs], {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  });
  let signalled = null;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      signalled = signal;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    });
  }
  const status = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (exit, signal) => resolve({ exit, signal }));
  });
  const by = signalled ?? status.signal;
  if (status.error) {
    console.error(`não consegui rodar os testes: ${status.error.message}`);
    code = 1;
  } else if (by) {
    code = 128 + constants.signals[by];
  } else {
    const leftovers = readdirSync(root);
    if (leftovers.length > 0) {
      console.error(`\ntestes deixaram ${leftovers.length} temporário(s) para trás: ${leftovers.slice(0, 10).join(", ")}`);
      code = 1;
    } else {
      code = status.exit ?? 1;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
