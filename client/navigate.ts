// Opening a Paseo agent from the release surfaces. Only screens and panels get
// `navigation.openAgent`; popovers and timeline cards hop through the Releases screen with
// `?open=<agent>&nonce=<ms>`, and the screen opens the agent once per nonce.
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { watchSessionLabel, watchSessions } from "../shared/release-copy.ts";
import type { Release, Session } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { agentTitle } from "./data.ts";

export const RELEASES_SCREEN = "releases";
/** A hop older than this is a reload or a history entry, not a click. */
const HOP_TTL_MS = 30_000;

export type OpenAgent = (agentId: string) => void;
type OpenScreen = (input: PluginOpenScreenInput) => void;

export interface WatchLink {
  readonly agentId: string;
  readonly label: string;
}

/**
 * Vigia links this daemon can open: the pusher and the incident's handoffs that are Paseo agents
 * of this host, or OpenCode sessions a Paseo agent of this host runs, and exist (`view.agents` only
 * lists agents with a record). `known` adds agents that exist for sure, such as the agent a
 * timeline card lives in.
 */
export function watchLinks(view: ReleaseView | null, release: Release, known: readonly string[] = []): WatchLink[] {
  const links: WatchLink[] = [];
  for (const entry of watchSessions(release)) {
    const agentId = localAgent(view, entry.session, known);
    if (!agentId || links.some((link) => link.agentId === agentId)) continue;
    links.push({ agentId, label: watchSessionLabel(entry, agentTitle(view, agentId)) });
  }
  return links;
}

/**
 * The Paseo agent of this daemon behind `session`, or null: a `paseo/<host>/…` agent of this host,
 * or the agent on the OpenCode provider running the `opencode/…/<ses_…>` session.
 */
export function localAgent(view: ReleaseView | null, session: Session, known: readonly string[] = []): string | null {
  if (session.harness === "opencode") return view?.agents.find((agent) => agent.openCodeSession === session.id)?.id ?? null;
  if (session.harness !== "paseo") return null;
  const local = !!view?.host && session.host === view.host && view.agents.some((agent) => agent.id === session.id);
  return local || known.includes(session.id) ? session.id : null;
}

/** Sessions that mean `agentId` in the snapshot: its `paseo/<host>/…` ref and the OpenCode session it runs. */
export function sessionsOfAgent(view: ReleaseView, agentId: string): Session[] {
  const refs: Session[] = view.host ? [{ harness: "paseo", host: view.host, id: agentId }] : [];
  const openCode = view.agents.find((agent) => agent.id === agentId)?.openCodeSession;
  if (!openCode) return refs;
  for (const release of view.snapshot?.releases ?? []) {
    const session = release.sessions.find((known) => known.harness === "opencode" && known.id === openCode);
    if (session && !refs.some((known) => known.harness === session.harness && known.host === session.host)) refs.push(session);
  }
  return refs;
}

/** Opens `agentId` through the Releases screen (for surfaces without `navigation`). */
export function hopToAgent(openScreen: OpenScreen, agentId: string): void {
  openScreen({ screenId: RELEASES_SCREEN, params: { open: agentId, nonce: String(Date.now()) } });
}

const consumed = new Set<string>();

/** The agent a fresh hop asks the screen to open, once per nonce; null otherwise. */
export function takeHop(params: Readonly<Record<string, string>>, now = Date.now()): string | null {
  const agentId = params["open"];
  const nonce = params["nonce"];
  if (!agentId || !nonce || consumed.has(nonce)) return null;
  consumed.add(nonce);
  const at = Number(nonce);
  return Number.isFinite(at) && now - at <= HOP_TTL_MS ? agentId : null;
}

let clientOpenScreen: OpenScreen | null = null;

/** The client's `openScreen`, for the timeline card (its props carry no navigation). */
export function setClientOpenScreen(openScreen: OpenScreen): () => void {
  clientOpenScreen = openScreen;
  return () => {
    if (clientOpenScreen === openScreen) clientOpenScreen = null;
  };
}

export function clientHop(): OpenAgent | null {
  const openScreen = clientOpenScreen;
  return openScreen ? (agentId) => hopToAgent(openScreen, agentId) : null;
}
