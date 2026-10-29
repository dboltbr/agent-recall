// Release timeline card: the row the daemon appends to the timeline of the agent that pushed the
// head commit of a release, re-appended with the same id as the run moves. Pure: the append and
// the fingerprint store are injected. Shared with the client (`shared/release-cards.ts`) for the
// card schema the renderer validates.
import { z } from "zod";
import {
  isActive,
  queueSummary,
  RECENT_VERDICT_MS,
  ReleaseSchema,
  type Release,
  type ReleaseSnapshot,
  type Session,
} from "./release-status.ts";
import type { Harness, Logger } from "./types.ts";

export const RELEASE_CARD_KIND = "release-status";
export const RELEASE_CARD_VERSION = 1;
/** Fingerprints kept in the store (newest releases). */
export const CARD_STORE_LIMIT = 50;

export const ReleaseCardSchema = z.object({
  release: ReleaseSchema,
  /** Title of the pushing agent, when the daemon knows it. */
  pusherTitle: z.string().nullable(),
  /** `6 na fila — runner solid-srv ocupado` while jobs wait. */
  queue: z.string().nullable(),
});
export type ReleaseCard = z.infer<typeof ReleaseCardSchema>;

export interface CardItem {
  readonly type: "plugin";
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly data: ReleaseCard;
}

export function cardId(release: Pick<Release, "number">): string {
  return `release-${release.number}`;
}

/** The card data: skipped jobs and those outside the five steps (`trigger`, `summary`) dropped. */
export function cardFor(release: Release, snapshot: ReleaseSnapshot, pusherTitle: string | null): ReleaseCard {
  return {
    release: { ...release, jobs: release.jobs.filter((job) => job.step !== null && job.state !== "skipped") },
    pusherTitle,
    queue: isActive(release) ? queueSummary(snapshot) : null,
  };
}

/**
 * What decides a re-append. Leaves out what moves every tick without a visible change: the run's
 * `updatedAt` and the duration of running steps (the renderer ticks those from `startedAt`).
 */
export function cardFingerprint(card: ReleaseCard): string {
  const { updatedAt: _updatedAt, ...release } = card.release;
  const steps = release.steps.map((step) => (step.state === "running" ? { ...step, durationMs: null } : step));
  return JSON.stringify({ ...card, release: { ...release, steps } });
}

function time(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Releases with a pusher that still get a card: active, or finished within the sidebar's recent window. */
export function cardTargets(snapshot: ReleaseSnapshot, now: Date): Release[] {
  return snapshot.releases.filter((release) => {
    if (!release.pusher) return false;
    if (isActive(release)) return true;
    const ended = time(release.completedAt);
    return ended !== null && now.getTime() - ended <= RECENT_VERDICT_MS;
  });
}

/**
 * The agent of this harness and host whose timeline gets the card, or null. A pusher of another
 * harness goes through `resolve`: a Paseo agent on the OpenCode provider commits as
 * `opencode/<instance>/<ses_…>` when its shell has no `PASEO_AGENT_ID`.
 */
export async function pusherAgent(
  pusher: Session,
  harness: Harness,
  host: string,
  resolve?: (session: Session) => Promise<string | null>,
): Promise<string | null> {
  if (pusher.harness === harness) return pusher.host === host ? pusher.id : null;
  return (await resolve?.(pusher).catch(() => null)) ?? null;
}

/** Fingerprint per card id, persisted so a plugin reload does not re-append (and reorder) rows. */
export interface CardStore {
  load(): Promise<Record<string, string>>;
  save(fingerprints: Record<string, string>): Promise<void>;
}

export type CardAppend = (agentId: string, item: CardItem) => Promise<void>;

export interface CardPublisherOptions {
  readonly harness: Harness;
  readonly host: string;
  readonly store: CardStore;
  readonly log: Logger;
  readonly now: () => Date;
  /** Title of an agent of this host, or null. */
  readonly title?: (agentId: string) => Promise<string | null>;
  /** The local agent behind a pusher of another harness, or null. */
  readonly resolve?: (session: Session) => Promise<string | null>;
}

export interface CardPublisher {
  /** Appends every card whose fingerprint moved. Without `append` (no daemon API yet) it waits. */
  publish(snapshot: ReleaseSnapshot, append: CardAppend | null): Promise<number>;
}

function prune(fingerprints: Record<string, string>): Record<string, string> {
  const ids = Object.keys(fingerprints).sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)) || b.localeCompare(a));
  return Object.fromEntries(ids.slice(0, CARD_STORE_LIMIT).map((id) => [id, fingerprints[id]!]));
}

export function createCardPublisher(options: CardPublisherOptions): CardPublisher {
  let known: Record<string, string> | null = null;
  let running: Promise<number> | null = null;

  async function publishOnce(snapshot: ReleaseSnapshot, append: CardAppend): Promise<number> {
    known ??= await options.store.load().catch((error) => {
      options.log.warn(`cartões: leitura do estado: ${String(error)}`);
      return {};
    });
    let appended = 0;
    let dirty = false;
    for (const release of cardTargets(snapshot, options.now())) {
      const agentId = await pusherAgent(release.pusher!, options.harness, options.host, options.resolve);
      if (!agentId) continue;
      const title = (await options.title?.(agentId).catch(() => null)) ?? null;
      const card = cardFor(release, snapshot, title);
      const fingerprint = cardFingerprint(card);
      const id = cardId(release);
      if (known[id] === fingerprint) continue;
      // Recorded either way: a failed append (archived agent, older daemon) waits for the next change.
      known[id] = fingerprint;
      dirty = true;
      try {
        await append(agentId, { type: "plugin", id, kind: RELEASE_CARD_KIND, version: RELEASE_CARD_VERSION, data: card });
        appended++;
      } catch (error) {
        options.log.warn(`cartão ${id} → ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (dirty) {
      known = prune(known);
      await options.store.save(known).catch((error) => options.log.warn(`cartões: gravação do estado: ${String(error)}`));
    }
    return appended;
  }

  return {
    async publish(snapshot, append) {
      if (!append) return 0;
      // Serialized: a tick and the first captured daemon API must not append the same card twice.
      while (running) await running.catch(() => 0);
      running = publishOnce(snapshot, append);
      try {
        return await running;
      } finally {
        running = null;
      }
    },
  };
}
