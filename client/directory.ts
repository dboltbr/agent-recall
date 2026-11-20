// Shared live directory of Paseo agents and workspaces on the plugin's host, fed by owned SDK
// subscriptions (`agents.list({ subscribe: {} })` and `workspaces.list({ subscribe: {} })`).
// Used by composer pills and workspace header buttons so both stay in sync without polling.
import type { PluginClientContext } from "@getpaseo/plugin/client";

export interface DirectoryAgent {
  readonly id: string;
  readonly workspaceId: string;
  readonly archived: boolean;
}

export interface DirectoryWorkspace {
  readonly id: string;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly archived: boolean;
}

export interface DirectorySnapshot {
  readonly agents: ReadonlyMap<string, DirectoryAgent>;
  readonly workspaces: ReadonlyMap<string, DirectoryWorkspace>;
}

const agents = new Map<string, DirectoryAgent>();
const workspaces = new Map<string, DirectoryWorkspace>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function directorySnapshot(): DirectorySnapshot {
  return { agents, workspaces };
}

export function subscribeDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when `remoteUrl` is absent (unknown) or points at `repository` (`dboltbr/dbolt`). */
export function matchesRepository(remoteUrl: string | null | undefined, repository: string): boolean {
  if (!remoteUrl) return true;
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[/:]${escaped}(?:\\.git)?/?$`, "i").test(remoteUrl.trim());
}

function upsertAgent(raw: {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}): void {
  const workspaceId = raw.workspaceId?.trim();
  if (!workspaceId) {
    agents.delete(raw.id);
    return;
  }
  agents.set(raw.id, { id: raw.id, workspaceId, archived: Boolean(raw.archivedAt) });
}

function upsertWorkspace(raw: {
  id: string;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null; remoteUrl?: string | null } | null;
}): void {
  workspaces.set(raw.id, {
    id: raw.id,
    branch: raw.gitRuntime?.currentBranch ?? null,
    remoteUrl: raw.gitRuntime?.remoteUrl ?? null,
    archived: Boolean(raw.archivingAt),
  });
}

/** Starts the owned agent & workspace list subscriptions; returns cleanup. */
export function startDirectory(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const releases: Array<() => void> = [];
  agents.clear();
  workspaces.clear();

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ entries, subscription }) => {
      if (lifetime.signal.aborted) {
        void subscription.release();
        return;
      }
      releases.push(() => void subscription.release());
      agents.clear();
      for (const entry of entries) upsertAgent(entry.agent);
      notify();
      subscription.subscribe({
        snapshot: (next) => {
          agents.clear();
          for (const entry of next.entries) upsertAgent(entry.agent);
          notify();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "upsert") upsertAgent(payload.agent);
          else agents.delete(payload.agentId);
          notify();
        },
      });
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) {
        console.warn(`agent-recall: observação de agentes falhou: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries, subscription }) => {
      if (lifetime.signal.aborted) {
        void subscription.release();
        return;
      }
      releases.push(() => void subscription.release());
      workspaces.clear();
      for (const workspace of entries) upsertWorkspace(workspace);
      notify();
      subscription.subscribe({
        snapshot: (next) => {
          workspaces.clear();
          for (const workspace of next.entries) upsertWorkspace(workspace);
          notify();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const payload = message.payload;
          if (payload.kind === "upsert") upsertWorkspace(payload.workspace);
          else workspaces.delete(payload.id);
          notify();
        },
      });
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) {
        console.warn(`agent-recall: observação de workspaces falhou: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  return () => {
    lifetime.abort();
    for (const release of releases) release();
    releases.length = 0;
    agents.clear();
    workspaces.clear();
    listeners.clear();
  };
}
