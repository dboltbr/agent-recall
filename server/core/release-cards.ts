// Release timeline card: the row the daemon appends to the timeline of the agent that pushed the
// head commit of a release, re-appended with the same id as the run moves (the app replaces a
// plugin row of the same id in place). Consecutive superseded releases of one agent fold into the
// newest card: the older ones are re-appended as `foldedInto` and render nothing. Pure: the append
// and the fingerprint store are injected. Shared with the client (`shared/release-cards.ts`) for
// the card schema the renderer validates.
import { z } from "zod";
import {
  isActive,
  isSuperseded,
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
  /** Older superseded releases of the same agent, oldest first, listed in this card's group line. */
  folded: z.array(ReleaseSchema).optional(),
  /** Number of the newer card whose group line lists this release: this one renders nothing. */
  foldedInto: z.number().int().optional(),
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

/** Where a card sits in a fold of superseded releases (none: a card of its own). */
export interface CardFold {
  readonly folded?: readonly Release[];
  readonly foldedInto?: number;
}

/**
 * Folds each streak of consecutive superseded releases (cancelled by a newer push, or no-op) of
 * one agent into its newest one, by release number. Anything else (active, published, failed)
 * breaks the streak. Pass the releases of a single agent.
 */
export function foldSuperseded(releases: readonly Release[]): Map<number, CardFold> {
  const folds = new Map<number, CardFold>();
  let streak: Release[] = [];
  const close = () => {
    const head = streak.at(-1);
    if (head && streak.length > 1) {
      const older = streak.slice(0, -1);
      folds.set(head.number, { folded: older });
      for (const release of older) folds.set(release.number, { foldedInto: head.number });
    }
    streak = [];
  };
  for (const release of [...releases].sort((a, b) => a.number - b.number)) {
    if (isSuperseded(release)) streak.push(release);
    else close();
  }
  close();
  return folds;
}

/**
 * The card data: skipped jobs and those outside the five steps (`trigger`, `summary`) dropped.
 * Folded releases go without jobs (a superseded run has no image chips to show; keeps the row
 * small with a long streak).
 */
export function cardFor(release: Release, snapshot: ReleaseSnapshot, pusherTitle: string | null, fold: CardFold = {}): ReleaseCard {
  const card: ReleaseCard = {
    release: { ...release, jobs: release.jobs.filter((job) => job.step !== null && job.state !== "skipped") },
    pusherTitle,
    queue: isActive(release) ? queueSummary(snapshot) : null,
  };
  if (fold.folded?.length) card.folded = fold.folded.map((older) => ({ ...older, jobs: [] }));
  if (fold.foldedInto !== undefined) card.foldedInto = fold.foldedInto;
  return card;
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
    // Folds run over every release of the agent in the snapshot, not only the recent ones: a
    // streak must not shrink (and orphan a hidden card) when its oldest member leaves the window.
    const owners = new Map<number, string>();
    for (const release of snapshot.releases) {
      if (!release.pusher) continue;
      const agentId = await pusherAgent(release.pusher, options.harness, options.host, options.resolve);
      if (agentId) owners.set(release.number, agentId);
    }
    const folds = new Map<number, CardFold>();
    for (const agentId of new Set(owners.values())) {
      const mine = snapshot.releases.filter((release) => owners.get(release.number) === agentId);
      for (const [number, fold] of foldSuperseded(mine)) folds.set(number, fold);
    }
    // Recent cards, plus older superseded ones already appended: those only change to fold away.
    const targets = new Set(cardTargets(snapshot, options.now()));
    const due = snapshot.releases.filter(
      (release) => targets.has(release) || (isSuperseded(release) && known![cardId(release)] !== undefined),
    );
    for (const release of due) {
      const agentId = owners.get(release.number);
      if (!agentId) continue;
      const id = cardId(release);
      const fold = folds.get(release.number);
      // A card that would only render nothing is not worth a new row.
      if (fold?.foldedInto !== undefined && known[id] === undefined) continue;
      const title = (await options.title?.(agentId).catch(() => null)) ?? null;
      const card = cardFor(release, snapshot, title, fold);
      const fingerprint = cardFingerprint(card);
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
