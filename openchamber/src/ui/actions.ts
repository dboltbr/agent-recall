import type { Host } from "./boot.ts";
import type { Actions } from "./render.ts";

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
