import type { Release } from "../../../core/release-status.ts";
import type { Host } from "./boot.ts";
import type { Actions, Watch } from "./render.ts";
import { sessionIndex, watchLinks, watchSessionIds } from "./sessions.ts";

export function hostActions(host: Host, repository: () => string): Actions {
  const openUrl = (url: string | null | undefined) => {
    if (url) void host.openUrl(url).catch(() => undefined);
  };
  return {
    openUrl,
    // The host's Diff view when the dbolt checkout is the open project; GitHub otherwise.
    openCommit(sha) {
      void host.openCommit(sha).catch(() => openUrl(`https://github.com/${repository()}/commit/${sha}`));
    },
    // Opens the chat and closes the page. A refusal leaves the id one click from the clipboard.
    openSession(sessionId) {
      void host.openSession(sessionId).catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        const why = code === "NOT_GRANTED" ? "aprove a permissão sessions da extensão" : error instanceof Error ? error.message : "falha do host";
        void host.toast({ kind: "error", message: `Não abri a sessão ${sessionId}: ${why}.`, copy: { text: sessionId } }).catch(() => undefined);
      });
    },
  };
}

/**
 * Vigia links of a release: the OpenCode sessions this server lists. Asking for an unknown
 * session reloads the list (throttled) and calls `onChange` so the frame redraws.
 */
export function hostWatch(host: Host, actions: Actions, onChange: () => void): (release: Release) => Watch | null {
  const index = sessionIndex(host, onChange);
  return (release) => {
    index.want(watchSessionIds(release));
    const links = watchLinks(release, index.titles());
    return links.length > 0 ? { links, open: actions.openSession } : null;
  };
}

export const SEEN_KEY = "badge-seen";

export async function readSeen(host: Host): Promise<string | null> {
  try {
    const value = await host.storage.get(SEEN_KEY);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
