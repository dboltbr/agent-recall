// Opening a Paseo agent from the release surfaces. Only screens and panels get
// `navigation.openAgent`; popovers and timeline cards hop through the Releases screen with
// `?open=<agent>&nonce=<ms>`, and the screen opens the agent once per nonce.
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { watchSessionLabel, watchSessions } from "../shared/release-copy.ts";
import type { Release } from "../shared/release-status.ts";
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
 * of this host and exist (`view.agents` only lists agents with a record). `known` adds agents that
 * exist for sure, such as the agent a timeline card lives in.
 */
export function watchLinks(view: ReleaseView | null, release: Release, known: readonly string[] = []): WatchLink[] {
  const host = view?.host ?? null;
  const links: WatchLink[] = [];
  for (const entry of watchSessions(release)) {
    const { session } = entry;
    if (session.harness !== "paseo") continue;
    const local = host !== null && session.host === host;
    const exists = (local && view!.agents.some((agent) => agent.id === session.id)) || known.includes(session.id);
    if (!exists) continue;
    links.push({ agentId: session.id, label: watchSessionLabel(entry, agentTitle(view, session.id)) });
  }
  return links;
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
