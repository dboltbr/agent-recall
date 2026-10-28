// Release status in the Paseo daemon: the tracker the watcher ticks (one poller), the view the
// RPCs serve, and the timeline cards appended to the agent that pushed. The daemon API (`paseo`)
// only exists inside handler and hook calls, so the plugin entry hands it over with `attach`.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createCardPublisher, type CardAppend, type CardPublisher, type CardStore } from "./core/release-cards.ts";
import { createReleaseSource, createReleaseTracker, type ReleaseTracker } from "./core/release-fetch.ts";
import type { ReleaseSnapshot } from "./core/release-status.ts";
import { describe } from "./core/poll.ts";
import type { Clock, Fetch, Logger } from "./core/types.ts";
import type { AgentInfo, ReleaseView } from "../shared/rpc.ts";

type PaseoApi = PluginHandlerContext["paseo"];

/** A missing agent record is looked up again after this long (the agent may be new). */
const MISS_RETRY_MS = 5 * 60 * 1000;

export interface AgentDirectoryEntry {
  readonly title: string | null;
  readonly workspaceId: string | null;
}

export interface ReleaseServiceOptions {
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly log: Logger;
  readonly stateDir: string;
  /** The daemon's record of one agent, or null. */
  readonly agent: (id: string) => Promise<AgentDirectoryEntry | null>;
}

export interface ReleaseService {
  readonly tracker: ReleaseTracker;
  /** The daemon's server id, once read: local agents are `paseo/<host>/…`. */
  setHost(host: string): void;
  /** Hands over the daemon API; the first one publishes the cards waiting for it. */
  attach(paseo: PaseoApi): void;
  /** Fresh title from a lifecycle hook (cheaper than re-reading the record). */
  noteAgent(id: string, entry: AgentDirectoryEntry): void;
  view(): Promise<ReleaseView>;
  refresh(): Promise<{ refreshed: boolean; view: ReleaseView }>;
}

function fileStore(path: string): CardStore {
  return {
    async load() {
      const raw = await readFile(path, "utf8").catch(() => null);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    },
    async save(fingerprints) {
      await mkdir(join(path, ".."), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(fingerprints)}\n`, "utf8");
      await rename(tmp, path);
    },
  };
}

export function createReleaseService(options: ReleaseServiceOptions): ReleaseService {
  const { log, clock } = options;
  let host: string | null = null;
  let paseo: PaseoApi | null = null;
  let publisher: CardPublisher | null = null;
  const directory = new Map<string, { entry: AgentDirectoryEntry | null; at: number }>();
  const store = fileStore(join(options.stateDir, "release-cards.json"));

  async function lookup(id: string): Promise<AgentDirectoryEntry | null> {
    const known = directory.get(id);
    const now = clock.now().getTime();
    if (known && (known.entry || now - known.at < MISS_RETRY_MS)) return known.entry;
    const entry = await options.agent(id).catch((error) => {
      log.warn(`registro do agente ${id}: ${describe(error)}`);
      return null;
    });
    directory.set(id, { entry, at: now });
    return entry;
  }

  const append: CardAppend = async (agentId, item) => {
    await paseo!.agents.ref(agentId).timeline.append(item);
  };

  async function publish(snapshot: ReleaseSnapshot | null): Promise<void> {
    if (!snapshot || !publisher) return;
    try {
      const count = await publisher.publish(snapshot, paseo ? append : null);
      if (count) log.info(`release: ${count} cartão(ões) na timeline`);
    } catch (error) {
      log.warn(`cartões: ${describe(error)}`);
    }
  }

  const source = createReleaseSource({ fetch: options.fetch, clock, log });
  const tracker = createReleaseTracker({ source, clock, log, onSnapshot: (next) => publish(next) });

  async function view(): Promise<ReleaseView> {
    const snapshot = tracker.current();
    const ids = new Set<string>();
    for (const release of snapshot?.releases ?? []) {
      for (const session of release.sessions) {
        if (session.harness === "paseo" && session.host === host) ids.add(session.id);
      }
    }
    const agents: AgentInfo[] = await Promise.all(
      [...ids].map(async (id) => {
        const entry = await lookup(id);
        return { id, title: entry?.title ?? null, workspaceId: entry?.workspaceId ?? null };
      }),
    );
    return { host, snapshot, agents };
  }

  return {
    tracker,
    setHost(next) {
      host = next;
      publisher = createCardPublisher({
        harness: "paseo",
        host: next,
        store,
        log,
        now: () => clock.now(),
        title: async (id) => (await lookup(id))?.title ?? null,
      });
      void publish(tracker.current());
    },
    attach(next) {
      if (paseo) return;
      paseo = next;
      void publish(tracker.current());
    },
    noteAgent(id, entry) {
      directory.set(id, { entry, at: clock.now().getTime() });
    },
    view,
    async refresh() {
      const refreshed = await tracker.refresh();
      return { refreshed, view: await view() };
    },
  };
}
