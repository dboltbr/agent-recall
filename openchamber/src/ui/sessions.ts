// OpenCode sessions behind the vigia step that this OpenChamber server knows. The panel and the
// page only link a session `host.openSession` can open: one listed by `listSessions` in one of the
// server's projects (needs the `sessions` capability; without it nothing is linked).
import type { GuestProjectsSnapshot, GuestSessionsSnapshot } from "@openchamber/sdk";
import { watchSessionLabel, watchSessions } from "../../../core/release-copy.ts";
import type { Release } from "../../../core/release-status.ts";

/** Session id → title (`""` when untitled) of every session the server lists. */
export type SessionTitles = ReadonlyMap<string, string>;

export interface WatchLink {
  readonly sessionId: string;
  readonly label: string;
}

/** Vigia links this server can open: OpenCode pusher and handoff sessions it lists. */
export function watchLinks(release: Release, titles: SessionTitles): WatchLink[] {
  const links: WatchLink[] = [];
  for (const entry of watchSessions(release)) {
    const { session } = entry;
    if (session.harness !== "opencode" || !titles.has(session.id)) continue;
    links.push({ sessionId: session.id, label: watchSessionLabel(entry, titles.get(session.id) || null) });
  }
  return links;
}

/** OpenCode session ids behind the vigia step, linked or not. */
export function watchSessionIds(release: Release): string[] {
  return watchSessions(release)
    .filter((entry) => entry.session.harness === "opencode")
    .map((entry) => entry.session.id);
}

export interface SessionLister {
  listProjects(): Promise<GuestProjectsSnapshot>;
  listSessions(projectId: string): Promise<GuestSessionsSnapshot>;
}

/** Titles of the sessions of every project; a project that fails to list is skipped. */
export async function loadSessionTitles(lister: SessionLister): Promise<Map<string, string>> {
  const { projects } = await lister.listProjects();
  const listed = await Promise.allSettled(projects.map((project) => lister.listSessions(project.id)));
  const titles = new Map<string, string>();
  for (const result of listed) {
    if (result.status !== "fulfilled") continue;
    for (const session of result.value.sessions) titles.set(session.id, session.title ?? "");
  }
  return titles;
}

export interface SessionIndex {
  titles(): SessionTitles;
  /** Asks for `ids`: reloads when one is unknown, at most once per gap; `onChange` follows a load. */
  want(ids: readonly string[]): void;
}

export function sessionIndex(lister: SessionLister, onChange: () => void, minGapMs = 15_000, clock: () => number = Date.now): SessionIndex {
  let titles: SessionTitles = new Map();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading = false;
  return {
    titles: () => titles,
    want(ids) {
      if (ids.every((id) => titles.has(id)) || loading || clock() - loadedAt < minGapMs) return;
      loading = true;
      void loadSessionTitles(lister)
        .then((next) => {
          titles = next;
          onChange();
        })
        .catch(() => undefined)
        .finally(() => {
          loading = false;
          loadedAt = clock();
        });
    },
  };
}
