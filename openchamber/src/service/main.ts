// Local service of the extension. OpenChamber spawns it on the first `serviceRequest` with only
// PATH/HOME/temp/locale plus OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN.
import { createServer } from "node:http";
import { join } from "node:path";
import { nodeExec } from "../../../core/exec.ts";
import { stateDirectory } from "../../../core/host.ts";
import { fetchNotes } from "../../../core/notes.ts";
import { createReleaseSource } from "../../../core/release-fetch.ts";
import { activeReleases, RELEASE_REPOSITORY } from "../../../core/release-status.ts";
import type { Fetch, Logger, Note } from "../../../core/types.ts";
import { createTokenSource } from "./gh.ts";
import { createLoader } from "./loader.ts";
import { createMonitor } from "./monitor.ts";
import { createHandler } from "./server.ts";

const NOTES_REF = "refs/notes/release-watch";

const write = (level: string) => (message: string) => {
  process.stderr.write(`${new Date().toISOString()} [dbolt-release] ${level}: ${message}\n`);
};
const log: Logger = { info: write("info"), warn: write("warn"), error: write("error") };

export function startService(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env["OPENCHAMBER_SERVICE_PORT"]);
  const token = env["OPENCHAMBER_SERVICE_TOKEN"] ?? "";
  if (!Number.isInteger(port) || port <= 0 || token === "") {
    throw new Error("OPENCHAMBER_SERVICE_PORT e OPENCHAMBER_SERVICE_TOKEN são obrigatórios");
  }
  const tokens = createTokenSource(nodeExec, Date.now);
  // A 401 means the cached `gh auth token` went stale: drop it so the next load asks gh again.
  const fetch: Fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.status === 401) tokens.forget();
    return response;
  };
  const source = createReleaseSource({ fetch, clock: { now: () => new Date() }, log });
  const gitDir = join(stateDirectory(), "openchamber.git");
  const loader = createLoader({
    source,
    token: () => tokens.token(),
    notes: async (githubToken) => {
      const fetched = await fetchNotes({ exec: nodeExec, gitDir, repository: RELEASE_REPOSITORY, notesRef: NOTES_REF, token: githubToken });
      return new Map(fetched.flatMap(({ key, note }): [string, Note][] => (note ? [[key, note]] : [])));
    },
    warn: log.warn,
  });
  const monitor = createMonitor({
    load: () => loader.load(),
    isActive: (snapshot) => activeReleases(snapshot).length > 0,
    now: Date.now,
  });
  const server = createServer(createHandler({ token, monitor, lookup: (number) => loader.lookup(number) }));
  server.listen(port, "127.0.0.1", () => log.info(`ouvindo em 127.0.0.1:${port}`));
  const stop = () => {
    monitor.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { server, monitor };
}

startService();
