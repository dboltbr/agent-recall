import { pollFactory, factoryPrompt, type FactoryRecord } from "./factory-api.ts";
import { join } from "node:path";
import { blockedPrompt, deliver, promptFor, type Delivery, type Failure, type Outcome } from "./deliver.ts";
import { acquireLock, writeHandoff, writeHeartbeat } from "./host.ts";
import { fetchNotes, parseBlockedNote, recordRecallFailure, releaseName, updateNote, type FetchedNote, type RecallFailure, type UpdateResult } from "./notes.ts";
import { describe, POLL_INTERVAL_MS, pollRef, type PollResult } from "./poll.ts";
import type { ReleaseTracker } from "./release-fetch.ts";
import type { Release } from "./release-status.ts";
import {
  ACK_TIMEOUT_MS,
  blockedConfirmation,
  blockedLease,
  blockedLock,
  describeAction,
  expiredSessions,
  expireLease,
  isBlockedRecent,
  isRecent,
  releaseHistory,
  roleOf,
  route,
  routeBlocked,
  shippedSince,
  type Action,
  type BlockedAction,
  type BlockedLease,
  type NoteAction,
} from "./route.ts";
import { formatSession, parseSessionValue, sameSession } from "./trailer.ts";
import type { BlockedNote, Clock, Exec, Fetch, Harness, HostConfig, Logger, Me, Note, SessionRef } from "./types.ts";

const TOKEN_TTL_MS = 10 * 60 * 1000;

/** A note body as a blocked note, or null (JSON from another repository). */
function asBlocked(body: Record<string, unknown>): BlockedNote | null {
  return typeof body["state"] === "string" && typeof body["updatedAt"] === "string" ? (body as unknown as BlockedNote) : null;
}

function isMine(ref: SessionRef, me: Me): boolean {
  return ref.harness === me.harness && ref.host === me.host;
}

export interface WatcherOptions {
  readonly harness: Harness;
  /** Paseo: `$PASEO_HOME/server-id`. OpenCode: config `instance`. */
  readonly host: (config: HostConfig) => string;
  readonly loadConfig: () => Promise<HostConfig>;
  readonly stateDir: string;
  readonly sha: string;
  readonly pid: number;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly exec: Exec;
  readonly delivery: Delivery;
  readonly log: Logger;
  /**
   * Release status: rides this poller's token, notes and cadence. Its history is what closes a
   * blocked release (a later release got the tag); the Paseo UI also renders it.
   */
  readonly release: ReleaseTracker;
  /**
   * The harness confirms delivered blocked calls itself (Claude Code: its inbox follow-up). Without
   * it this watcher does: a prompted session that does not take the note within 2 min gets the
   * fallback copy.
   */
  readonly confirmsCalls?: boolean;
  /**
   * Runs each call (lock, delivery, handoff record) as one unit, or refuses to start it (null): a
   * harness whose process may exit at any moment (Claude Code) admits no new call once it is
   * leaving and waits for the ones it admitted.
   */
  readonly guard?: <T>(call: () => Promise<T>) => Promise<T | null>;
}

export interface Handled {
  readonly action: Action;
  readonly outcome: Outcome;
  /** Session id that received the call; null when it was only recorded or failed. */
  readonly session: string | null;
}

export interface TickReport {
  readonly poll: PollResult["kind"] | "config-error" | "token-error";
  readonly fetched: boolean;
  /** The blocked-release ref, polled in the same tick. */
  readonly blocked: PollResult["kind"] | null;
  readonly blockedFetched: boolean;
  readonly handled: readonly Handled[];
}

export interface Watcher {
  /** One poll: heartbeat, both refs, notes fetch on change, calls the notes ask for, blocked fallbacks. */
  tick(): Promise<TickReport>;
  /** Ticks now and every 30 s, never overlapping. Returns stop. */
  start(intervalMs?: number): () => Promise<void>;
  /** The incident notes read so far, by annotated commit (refreshed when the ref changes). */
  notes(): ReadonlyMap<string, Note>;
  /** The blocked-release notes on the remote, by head commit (replaced when the ref changes). */
  blockedNotes(): ReadonlyMap<string, BlockedNote>;
}

/** A blocked call prompted into an existing session, waiting for the note to name it. */
/** What `keepLease` did to a blocked note this tick (see there). */
type LeaseStep = "none" | "wrote" | "stale";

interface Awaiting {
  readonly action: BlockedAction;
  readonly key: string;
  readonly text: string;
  readonly title: string;
  readonly drill: boolean;
  readonly deliveredAt: number;
  readonly recordFailure: (failure: Failure) => Promise<boolean>;
}

export function createWatcher(options: WatcherOptions): Watcher {
  const { clock, exec, log } = options;
  let factoryEtag: string | null = null;
  let factoryUrl: string | null = null;
  const factoryRecords = new Map<string, FactoryRecord>();
  let etag: string | null = null;
  let notesRef: string | null = null;
  let caughtUp = false;
  let token: { value: string; at: number } | null = null;
  const seen = new Map<string, string>();
  const notes = new Map<string, Note>();
  let blockedEtag: string | null = null;
  let blockedRef: string | null = null;
  /** Blocked notes already routed, by key: their body when routed. */
  const blockedSeen = new Map<string, string>();
  let blocked = new Map<string, { raw: string; note: BlockedNote }>();
  const awaiting = new Map<string, Awaiting>();

  async function getToken(): Promise<string> {
    const now = clock.now().getTime();
    if (token && now - token.at < TOKEN_TTL_MS) return token.value;
    const result = await exec("gh", ["auth", "token"], { timeoutMs: 10_000 });
    const value = result.stdout.trim();
    if (result.code !== 0 || !value) throw new Error(`gh auth token falhou: ${result.stderr.trim()}`);
    token = { value, at: now };
    return value;
  }

  interface Call {
    readonly action: Action;
    readonly text: string;
    readonly title: string;
    readonly drill: boolean;
    readonly recordFailure: (failure: Failure) => Promise<boolean>;
  }

  async function call(input: Call, me: Me): Promise<Handled | null> {
    const run = () => deliverOnce(input, me);
    return options.guard ? ((await options.guard(run)) ?? null) : run();
  }

  async function deliverOnce(input: Call, me: Me): Promise<Handled | null> {
    const { action } = input;
    if (!(await acquireLock(options.stateDir, action.release, action.lock))) return null;
    log.info(`chamando: ${describeAction(action)}`);
    const { outcome, session } = await deliver({ ...input, delivery: options.delivery, host: me.host, log });
    log.info(`${describeAction(action)}: ${outcome}`);
    if (session && !input.drill) await recordHandoff(action, me, session);
    return { action, outcome, session };
  }

  function recordHandoff(action: Action, me: Me, session: string): Promise<void> {
    return writeHandoff(options.stateDir, action.release, action.lock, {
      role: roleOf(action),
      session: { harness: me.harness, host: me.host, id: session },
      at: clock.now().toISOString(),
    }).catch((error) => log.warn(`${action.release}: registrar o chamado: ${describe(error)}`));
  }

  /** Writes a failed call into the note of `key` on `ref`, with what that note kind records. */
  function failureRecorder(key: string, ref: string, extra: Pick<RecallFailure, "rollback" | "state">, config: HostConfig, me: Me, auth: string, keepUpdatedAt = false) {
    return (failure: Failure) =>
      recordRecallFailure({
        exec,
        gitDir: join(options.stateDir, `${options.harness}.git`),
        repository: config.repository,
        notesRef: ref,
        token: auth,
        key,
        recall: { ...failure, ...extra, failedAt: clock.now().toISOString(), by: `${me.harness}/${me.host}` },
        keepUpdatedAt,
      });
  }

  function act(action: NoteAction, key: string, note: Note, config: HostConfig, me: Me, auth: string): Promise<Handled | null> {
    return call(
      {
        action,
        text: promptFor(action, note),
        title: `Incidente ${action.release}${note.drill ? " [ensaio]" : ""}`,
        drill: note.drill === true,
        recordFailure: failureRecorder(key, config.notesRef, { rollback: note.rollback?.outcome ?? null }, config, me, auth),
      },
      me,
    );
  }

  async function actBlocked(action: BlockedAction, key: string, note: BlockedNote, config: HostConfig, me: Me, auth: string): Promise<Handled | null> {
    const input: Call = {
      action,
      text: blockedPrompt(action.release, key, note),
      title: `Release barrada ${action.release}${note.drill ? " [ensaio]" : ""}`,
      drill: note.drill === true,
      recordFailure: failureRecorder(key, config.blockedRef, { state: note.state }, config, me, auth, true),
    };
    const done = await call(input, me);
    // Prompted is not taken: the note must name the session (`owner`, `fix.session`) within 2 min.
    if (done?.outcome === "prompt" && !options.confirmsCalls) {
      awaiting.set(`${action.release}/${action.lock}`, { ...input, action, key, deliveredAt: clock.now().getTime() });
    }
    return done;
  }

  /**
   * Prompted blocked calls: confirmed or moot → done; unknown (the release history cannot tell
   * whether a later release shipped) → keep waiting; still open 2 min after the prompt → the
   * fallback copy (new agent, child session), whose failure goes to the blocked note's `recall`.
   * Runs only with the blocked notes matching the remote: a confirmation not yet fetched would
   * look like silence. In memory: a poller that restarts in between drops the follow-up.
   */
  async function followUp(me: Me, releases: readonly Release[] | null, outdated: ReadonlySet<string> = new Set()): Promise<Handled[]> {
    const handled: Handled[] = [];
    const now = clock.now();
    for (const [id, waiting] of awaiting) {
      const { action } = waiting;
      if (outdated.has(waiting.key)) continue;
      const note = blocked.get(waiting.key)?.note ?? null;
      let verdict: ReturnType<typeof blockedConfirmation>;
      try {
        verdict = blockedConfirmation(action.role, action.target, note, note ? shippedSince(note, releases) : null, now, action.candidate);
      } catch (error) {
        log.error(`${action.release}: conferir o chamado: ${describe(error)}`);
        continue;
      }
      if (verdict === "unknown") continue;
      if (verdict !== "open") {
        log.info(`${action.release}: ${verdict === "taken" ? `${formatSession(action.target)} assumiu o chamado` : "chamado da release barrada encerrado"}`);
        awaiting.delete(id);
        continue;
      }
      if (now.getTime() - waiting.deliveredAt < ACK_TIMEOUT_MS) continue;
      awaiting.delete(id);
      const done = await fallBack(waiting, action.target, me);
      if (done) handled.push(done);
    }
    return handled;
  }

  async function fallBack(waiting: Awaiting, target: SessionRef, me: Me): Promise<Handled | null> {
    const run = async (): Promise<Handled> => {
      const { action } = waiting;
      try {
        const session = await options.delivery.fallback(target, waiting.text, waiting.title, action);
        log.warn(`${action.release}: ${formatSession(target)} não assumiu em 2 min; chamado foi para ${session}`);
        if (!waiting.drill) await recordHandoff(action, me, session);
        return { action, outcome: "fallback", session };
      } catch (error) {
        const reason = `prompt: sem confirmação; fallback: ${describe(error)}`;
        log.error(`${waiting.drill ? "[ensaio] " : ""}não consegui chamar ${formatSession(target)} para ${action.release} (${action.role}): ${reason}`);
        try {
          if (await waiting.recordFailure({ role: roleOf(action), target: formatSession(target), reason })) {
            return { action, outcome: "recorded", session: null };
          }
          log.error(`${action.release}: a falha do chamado não entrou na nota`);
        } catch (failure) {
          log.error(`${action.release}: gravar a falha na nota: ${describe(failure)}`);
        }
        return { action, outcome: "failed", session: null };
      }
    };
    return options.guard ? ((await options.guard(run)) ?? null) : run();
  }

  /**
   * Runs each action on its own: one that throws (a lock directory that cannot be made) is logged
   * and does not skip the others. True when none threw, so a blocked note may be marked seen;
   * otherwise the next tick routes it again and the locks keep the calls already made from repeating.
   */
  async function attempt<A extends Action>(actions: readonly A[], run: (action: A) => Promise<Handled | null>, handled: Handled[]): Promise<boolean> {
    let clean = true;
    for (const action of actions) {
      try {
        const done = await run(action);
        if (done) handled.push(done);
      } catch (error) {
        clean = false;
        log.error(`${describeAction(action)}: ${describe(error)}`);
      }
    }
    return clean;
  }

  /** CAS on the blocked note of `key` (`updateNote`). */
  function updateBlocked(key: string, config: HostConfig, auth: string, edit: (body: Record<string, unknown>) => Record<string, unknown> | null): Promise<UpdateResult> {
    return updateNote({
      exec,
      gitDir: join(options.stateDir, `${options.harness}.git`),
      repository: config.repository,
      notesRef: config.blockedRef,
      token: auth,
      key,
      edit,
    });
  }

  /**
   * What the lease of a blocked note asks of this plugin (`blockedLease`): the heartbeat of a holder
   * of this host that is working, the expiry (any plugin), the incident host's agent or the final
   * failure of an orphan. Every write re-decides on the body it replaces. `none`: nothing written,
   * the cached note stands. Otherwise (`wrote`, or `stale` when the write found a remote note that
   * disagrees) the cached note is out of date: routing and the call follow-up wait for the next
   * fetch. `heartbeatOnly`: the release history is unknown on this host, only the heartbeat of a
   * holder of this host is written (another host decides the rest).
   */
  async function keepLease(
    key: string,
    note: BlockedNote,
    config: HostConfig,
    me: Me,
    auth: string,
    now: Date,
    handled: Handled[],
    heartbeatOnly = false,
  ): Promise<LeaseStep> {
    const lease = blockedLease(note, now);
    const release = releaseName(note);
    if (heartbeatOnly && lease.kind !== "held") return "none";
    const step = (result: UpdateResult): LeaseStep => (result === "written" ? "wrote" : "stale");
    switch (lease.kind) {
      case "none":
        return "none";
      case "held": {
        const isWorking = options.delivery.isWorking;
        if (!lease.heartbeatDue || !isMine(lease.holder, me) || !isWorking) return "none";
        let working = false;
        try {
          working = await isWorking(lease.holder);
        } catch (error) {
          log.warn(`${release}: estado de ${formatSession(lease.holder)}: ${describe(error)}`);
        }
        if (!working) return "none";
        const stamp = now.toISOString();
        const result = await updateBlocked(key, config, auth, (body) => {
          const fresh = asBlocked(body);
          const again = fresh ? blockedLease(fresh, now) : null;
          return again?.kind === "held" && again.heartbeatDue && sameSession(again.holder, lease.holder) ? { ...body, heartbeatAt: stamp } : null;
        });
        if (result === "written") log.info(`${release}: heartbeat de ${formatSession(lease.holder)}`);
        return step(result);
      }
      case "expire": {
        let expired: BlockedLease | null = null;
        const result = await updateBlocked(key, config, auth, (body) => {
          const fresh = asBlocked(body);
          expired = fresh ? blockedLease(fresh, now) : null;
          return expired?.kind === "expire" ? expireLease(body, expired.who, expired.reason, now) : null;
        });
        if (result === "written") {
          const done = (expired ?? lease) as Extract<BlockedLease, { kind: "expire" }>;
          log.warn(`${release}: posse expirada (${done.who.join(", ") || "sem sessão"}): ${done.reason}; a nota voltou a red`);
        }
        return step(result);
      }
      case "orphan":
        return orphan(key, note, lease, config, me, auth, now, handled);
    }
  }

  /**
   * Red, and no session of the range left outside `expired`. An incident host claims the note
   * (`incident`, by CAS: one host, once per note) and opens a new agent in its checkout with the
   * blocked prompt; that agent takes the note like any session. Nobody took it in the end (no
   * incident host, its agent expired or never answered, opening failed) → the failure goes to
   * `recall`, once, and nobody else is called.
   */
  async function orphan(
    key: string,
    note: BlockedNote,
    lease: Extract<BlockedLease, { kind: "orphan" }>,
    config: HostConfig,
    me: Me,
    auth: string,
    now: Date,
    handled: Handled[],
  ): Promise<LeaseStep> {
    const release = releaseName(note);
    const by = `${me.harness}/${me.host}`;
    const incident = note.incident && typeof note.incident === "object" ? note.incident : null;
    const step = (result: UpdateResult): LeaseStep => (result === "written" ? "wrote" : "stale");
    const abandon = (reason: string) =>
      updateBlocked(key, config, auth, (body) => {
        const fresh = asBlocked(body);
        if (!fresh || blockedLease(fresh, now).kind !== "orphan" || (fresh.recall as { abandoned?: unknown } | null | undefined)?.abandoned === true) return null;
        const recall: RecallFailure = { failedAt: now.toISOString(), reason, by, role: "blocked", target: "", state: fresh.state, abandoned: true };
        return { ...body, recall, updatedAt: recall.failedAt };
      });
    const abandoned = (value: BlockedNote) => (value.recall as { abandoned?: unknown } | null | undefined)?.abandoned === true;
    const open = options.delivery.open;
    const checkout = config.incidentCheckout;
    if (!incident && !abandoned(note) && config.incidentHost && checkout && open) {
      const claimedAt = now.toISOString();
      const claimed = await updateBlocked(key, config, auth, (body) => {
        const fresh = asBlocked(body);
        return fresh && !fresh.incident && !abandoned(fresh) && blockedLease(fresh, now).kind === "orphan"
          ? { ...body, incident: { by, at: claimedAt } }
          : null;
      });
      if (claimed !== "written") return "stale";
      const run = async (): Promise<void> => {
        const title = `Release barrada ${release} [incidente]${note.drill ? " [ensaio]" : ""}`;
        try {
          const id = await open(checkout, blockedPrompt(release, key, note), title);
          const target: SessionRef = { harness: me.harness, host: me.host, id };
          const action: BlockedAction = { kind: "blocked", release, role: "blocked", target, lock: "incident" };
          log.warn(`${release}: nenhuma sessão da faixa assumiu; agente de incidente ${formatSession(target)} aberto em ${checkout}`);
          handled.push({ action, outcome: "incident", session: id });
          if (!note.drill) await recordHandoff(action, me, id);
          await updateBlocked(key, config, auth, (body) => {
            const current = body["incident"] as { by?: unknown; at?: unknown; session?: unknown } | null | undefined;
            return current?.by === by && current.at === claimedAt && !current.session ? { ...body, incident: { ...current, session: formatSession(target) } } : null;
          }).catch((error) => log.warn(`${release}: gravar o agente de incidente: ${describe(error)}`));
        } catch (error) {
          const reason = `host de incidente ${by}: ${describe(error)}`;
          log.error(`${note.drill ? "[ensaio] " : ""}${release}: não consegui abrir o agente de incidente: ${describe(error)}`);
          await abandon(reason).catch((failure) => log.error(`${release}: gravar a falha na nota: ${describe(failure)}`));
        }
      };
      await (options.guard ? options.guard(run) : run());
      return "wrote";
    }
    if (!lease.stale || abandoned(note)) return "none";
    const reason = incident
      ? `o agente de incidente ${typeof incident.session === "string" ? incident.session : "(não aberto)"} não assumiu`
      : "nenhuma sessão da faixa fora de expired e nenhum host de incidente assumiu";
    const result = await abandon(reason);
    if (result === "written") log.error(`${note.drill ? "[ensaio] " : ""}${release}: ninguém assumiu a release barrada: ${reason}`);
    return step(result);
  }

  /**
   * The session a blocked call goes to: a lane gives way to its root (`Delivery.resolveRoot`),
   * which takes the lane's place. A root already in `expired` is not called again: the lane joins it
   * there (red calls only), so every host walks on to the next session. Null: nobody to call now.
   */
  async function rooted(action: BlockedAction, key: string, note: BlockedNote, config: HostConfig, auth: string, now: Date): Promise<BlockedAction | null> {
    const resolve = options.delivery.resolveRoot;
    if (!resolve) return action;
    const rootOf = async (target: SessionRef): Promise<SessionRef> => {
      try {
        return await resolve(target);
      } catch (error) {
        // Unknown to this harness (or it does not answer): the session stands for itself.
        log.warn(`${action.release}: raiz de ${formatSession(target)}: ${describe(error)}`);
        return target;
      }
    };
    const root = await rootOf(action.target);
    if (sameSession(root, action.target)) return action;
    const rootName = formatSession(root);
    // The root is expired when it is in `expired` itself or stood in for a lane that is: one call
    // per root, however many of its lanes the range holds.
    let rootExpired = expiredSessions(note).has(rootName);
    for (const name of rootExpired ? [] : expiredSessions(note)) {
      const lane = parseSessionValue(name);
      if (!lane || !sameSession({ ...lane, id: root.id }, root)) continue;
      if (sameSession(await rootOf(lane), root)) {
        rootExpired = true;
        break;
      }
    }
    if (rootExpired) {
      if (action.role === "blocked") {
        const lane = formatSession(action.target);
        await updateBlocked(key, config, auth, (body) => {
          const fresh = asBlocked(body);
          // The expired set only grows: what made the root expired still holds on the fresh note.
          if (!fresh || fresh.state !== "red" || fresh.owner || expiredSessions(fresh).has(lane)) return null;
          for (const name of expiredSessions(note)) if (!expiredSessions(fresh).has(name)) return null;
          return expireLease(body, [lane], `raiz ${rootName} expirada`, now);
        });
      }
      return null;
    }
    const owner = parseSessionValue(typeof note.owner === "string" ? note.owner : null);
    if (action.role === "fix" && owner && sameSession(owner, root)) return null;
    log.info(`${action.release}: ${formatSession(action.target)} é lane; chamando a raiz ${rootName}`);
    return { ...action, target: root, candidate: action.target, lock: blockedLock(action.role, root, note) };
  }

  /**
   * Polls and fetches the blocked ref. `fresh` when the cached notes match the remote this tick
   * (304, missing ref, or a change fetched); a missing ref means no blocked release at all.
   */
  async function pollBlocked(config: HostConfig, auth: string): Promise<{ kind: PollResult["kind"]; fetched: boolean; fresh: boolean }> {
    const poll = await pollRef({ fetch: options.fetch, token: auth, repository: config.repository, notesRef: config.blockedRef, etag: blockedEtag });
    if (poll.kind === "error") {
      log.warn(`consulta de ${config.blockedRef}: ${poll.message}`);
      return { kind: poll.kind, fetched: false, fresh: false };
    }
    if (poll.kind === "unchanged") return { kind: poll.kind, fetched: false, fresh: true };
    if (poll.kind === "missing") {
      blockedEtag = null;
      blocked = new Map();
      return { kind: poll.kind, fetched: false, fresh: true };
    }
    let fetched: FetchedNote<BlockedNote>[];
    try {
      fetched = await fetchNotes(
        { exec, gitDir: join(options.stateDir, `${options.harness}.git`), repository: config.repository, notesRef: config.blockedRef, token: auth },
        parseBlockedNote,
      );
    } catch (error) {
      log.warn(describe(error));
      return { kind: poll.kind, fetched: false, fresh: false };
    }
    blockedEtag = poll.etag;
    blocked = new Map();
    for (const { key, raw, note } of fetched) if (note) blocked.set(key, { raw, note });
    return { kind: poll.kind, fetched: true, fresh: true };
  }

  async function processBlocked(config: HostConfig, auth: string, me: Me, now: Date, fetched: boolean, handled: Handled[], canPoll = true) {
    const blockedPoll = canPoll ? await pollBlocked(config, auth) : null;
    // A moved blocked ref refreshes the release history now: it is what closes a blocked call.
    await options.release
      .tick({ token: auth, notes, notesChanged: fetched || blockedPoll?.fetched === true })
      .catch((error) => log.warn(`release: ${describe(error)}`));
    const releases = releaseHistory(options.release.current());
    // Routed only from notes fetched this tick (a cached copy may be stale: someone took it) and a
    // release history refreshed this tick (an older one may miss the release that shipped);
    // otherwise the notes wait for the next tick, unseen.
    // Notes whose cached copy a lease write just made out of date: no routing nor follow-up on them.
    const outdated = new Set<string>();
    for (const [key, { raw, note }] of blockedPoll?.fresh ? blocked : []) {
      let actions: BlockedAction[];
      try {
        const shipped = shippedSince(note, releases);
        const open = shipped === false && isBlockedRecent(note, now);
        // Every tick, not only on change: the lease runs on the clock. Without a release history
        // the holder's heartbeat still goes out (other hosts may have one and would expire it).
        if (open || (shipped === null && isBlockedRecent(note, now))) {
          let step: LeaseStep = "none";
          try {
            step = await keepLease(key, note, config, me, auth, now, handled, shipped === null);
          } catch (error) {
            step = "stale";
            log.warn(`${releaseName(note)}: posse: ${describe(error)}`);
          }
          if (step !== "none") {
            outdated.add(key);
            // Not written: the remote note differs from the cached one; fetch it next tick.
            if (step === "stale") blockedEtag = null;
            continue;
          }
        }
        if (shipped === null) continue;
        if (blockedSeen.get(key) === raw) continue;
        actions = open ? routeBlocked(note, me) : [];
      } catch (error) {
        // A note that cannot be routed (JSON from another repository) never stops the others.
        log.error(`nota barrada ${key.slice(0, 12)}: ${describe(error)}`);
        continue;
      }
      const run = async (action: BlockedAction) => {
        const target = await rooted(action, key, note, config, auth, now);
        return target ? actBlocked(target, key, note, config, me, auth) : null;
      };
      if (await attempt(actions, run, handled)) blockedSeen.set(key, raw);
    }
    if (blockedPoll?.fresh) handled.push(...(await followUp(me, releases, outdated)));
    return blockedPoll;
  }

  async function tick(): Promise<TickReport> {
    const now = clock.now();
    let config: HostConfig;
    try {
      config = await options.loadConfig();
    } catch (error) {
      log.error(describe(error));
      return { poll: "config-error", fetched: false, blocked: null, blockedFetched: false, handled: [] };
    }
    if (config.notesRef !== notesRef) {
      notesRef = config.notesRef;
      etag = null;
      caughtUp = false;
      seen.clear();
      notes.clear();
    }
    if (config.blockedRef !== blockedRef) {
      blockedRef = config.blockedRef;
      blockedEtag = null;
      blockedSeen.clear();
      blocked = new Map();
      awaiting.clear();
    }
    const me: Me = { harness: options.harness, host: options.host(config) };
    if (config.factoryApiUrl) {
      if (factoryUrl !== config.factoryApiUrl) { factoryUrl = config.factoryApiUrl; factoryEtag = null; factoryRecords.clear(); notes.clear(); }
      const handled: Handled[] = [];
      let kind: "changed" | "unchanged" | "error" = "error";
      try {
        const poll = await pollFactory({ fetch: options.fetch, url: config.factoryApiUrl, token: config.factoryToken ?? "", etag: factoryEtag });
        kind = poll.kind;
        if (poll.kind === "changed") {
          factoryEtag = poll.etag;
          factoryRecords.clear();
          notes.clear();
          for (const record of poll.releases) { factoryRecords.set(record.key, record); notes.set(record.range?.to ?? record.key, record); }
        }
        await writeHeartbeat(options.stateDir, options.harness, { pid: options.pid, polledAt: now, sha: options.sha });
        for (const [key, record] of factoryRecords) {
          const verdict = record.verdict as { verdict?: unknown } | null | undefined;
          if (verdict?.verdict !== "red" || !isRecent(record, now)) continue;
          // Reavaliar 304: o dono de rollback pendente é chamado após 10 min, como antes.
          await attempt(route(record, me, now), (action) => call({ action, text: factoryPrompt(action.role, record, config.factoryApiUrl ?? ""), title: `Incidente ${record.release}`, drill: record.drill === true, recordFailure: async () => { log.error(`Recall ${key} falhou; nenhuma git note foi escrita`); return false; } }, me), handled);
        }
      } catch (error) { log.warn(`factory: ${describe(error)}`); }
      // Releases barradas são uma fonte independente da IA-5, preservada até sua migração.
      // Indisponibilidade da API de publicados não desliga os callbacks das barradas.
      try {
        const blockedPoll = await processBlocked(config, await getToken(), me, now, kind === "changed", handled);
        return { poll: kind, fetched: kind === "changed", blocked: blockedPoll?.kind ?? null, blockedFetched: blockedPoll?.fetched === true, handled };
      } catch (error) {
        log.warn(`releases barradas: ${describe(error)}`);
        return { poll: kind, fetched: kind === "changed", blocked: null, blockedFetched: false, handled };
      }
    }
    let auth: string;
    try {
      auth = await getToken();
    } catch (error) {
      log.error(describe(error));
      return { poll: "token-error", fetched: false, blocked: null, blockedFetched: false, handled: [] };
    }
    const poll = await pollRef({ fetch: options.fetch, token: auth, repository: config.repository, notesRef: config.notesRef, etag });
    // A refused credential is not a live plugin: the commit hook must send the agent to install.
    if (poll.kind !== "error" || (poll.status !== 401 && poll.status !== 403)) {
      await writeHeartbeat(options.stateDir, options.harness, { pid: options.pid, polledAt: now, sha: options.sha }).catch(
        (error) => log.error(`heartbeat: ${describe(error)}`),
      );
    }
    const handled: Handled[] = [];
    let fetched = false;
    if (poll.kind === "error") {
      if (poll.status === 401) token = null;
      log.warn(`consulta de ${config.notesRef}: ${poll.message}`);
    } else if (poll.kind === "missing") {
      etag = null;
      caughtUp = true;
      notes.clear();
      seen.clear();
    } else if (poll.kind === "changed") {
      let fetchedNotes: FetchedNote[] | null = null;
      try {
        fetchedNotes = await fetchNotes({
          exec,
          gitDir: join(options.stateDir, `${options.harness}.git`),
          repository: config.repository,
          notesRef: config.notesRef,
          token: auth,
        });
      } catch (error) {
        log.warn(describe(error));
      }
      if (fetchedNotes) {
        fetched = true;
        etag = poll.etag;
        if (!caughtUp) log.info(`recuperação: ${fetchedNotes.length} nota(s), janela de 8 h`);
        caughtUp = true;
        // The fetch is the whole note set: a removed note leaves the map, so it is never routed again.
        const present = new Set(fetchedNotes.map((fetched) => fetched.key));
        for (const key of [...notes.keys()]) if (!present.has(key)) notes.delete(key);
        for (const key of [...seen.keys()]) if (!present.has(key)) seen.delete(key);
        for (const { key, raw, note } of fetchedNotes) {
          if (!note || seen.get(key) === raw) continue;
          seen.set(key, raw);
          notes.set(key, note);
        }
      }
    }
    // Every tick, not only on change: the owner's call waits for the rollback outcome, and a note
    // left `pending` by a watch that died never changes again. The locks keep each call single.
    for (const [key, note] of notes) {
      if (!isRecent(note, now)) continue;
      await attempt(route(note, me, now), (action) => act(action, key, note, config, me, auth), handled);
    }
    const blockedPoll = await processBlocked(config, auth, me, now, fetched, handled, !(poll.kind === "error" && poll.status === 401));
    return { poll: poll.kind, fetched, blocked: blockedPoll?.kind ?? null, blockedFetched: blockedPoll?.fetched === true, handled };
  }

  function start(intervalMs = POLL_INTERVAL_MS): () => Promise<void> {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<unknown> = Promise.resolve();
    const loop = (): void => {
      if (stopped) return;
      running = tick()
        .catch((error) => log.error(`tick: ${describe(error)}`))
        .finally(() => {
          if (!stopped) timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    };
  }

  return {
    tick,
    start,
    notes: () => notes,
    blockedNotes: () => new Map([...blocked].map(([key, entry]) => [key, entry.note])),
  };
}
