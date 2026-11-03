import { pollFactory, factoryPrompt, type FactoryRecord } from "./factory-api.ts";
import { join } from "node:path";
import { blockedPrompt, deliver, promptFor, type Delivery, type Failure, type Outcome } from "./deliver.ts";
import { acquireLock, writeHandoff, writeHeartbeat } from "./host.ts";
import { fetchNotes, parseBlockedNote, recordRecallFailure, type FetchedNote, type RecallFailure } from "./notes.ts";
import { describe, POLL_INTERVAL_MS, pollRef, type PollResult } from "./poll.ts";
import type { ReleaseTracker } from "./release-fetch.ts";
import type { Release } from "./release-status.ts";
import {
  ACK_TIMEOUT_MS,
  blockedConfirmation,
  describeAction,
  isRecent,
  releaseHistory,
  roleOf,
  route,
  routeBlocked,
  shippedSince,
  type Action,
  type BlockedAction,
  type NoteAction,
} from "./route.ts";
import { formatSession } from "./trailer.ts";
import type { BlockedNote, Clock, Exec, Fetch, Harness, HostConfig, Logger, Me, Note, SessionRef } from "./types.ts";

const TOKEN_TTL_MS = 10 * 60 * 1000;

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
  function failureRecorder(key: string, ref: string, extra: Pick<RecallFailure, "rollback" | "state">, config: HostConfig, me: Me, auth: string) {
    return (failure: Failure) =>
      recordRecallFailure({
        exec,
        gitDir: join(options.stateDir, `${options.harness}.git`),
        repository: config.repository,
        notesRef: ref,
        token: auth,
        key,
        recall: { ...failure, ...extra, failedAt: clock.now().toISOString(), by: `${me.harness}/${me.host}` },
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
      recordFailure: failureRecorder(key, config.blockedRef, { state: note.state }, config, me, auth),
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
  async function followUp(me: Me, releases: readonly Release[] | null): Promise<Handled[]> {
    const handled: Handled[] = [];
    const now = clock.now();
    for (const [id, waiting] of awaiting) {
      const { action } = waiting;
      const note = blocked.get(waiting.key)?.note ?? null;
      let verdict: ReturnType<typeof blockedConfirmation>;
      try {
        verdict = blockedConfirmation(action.role, action.target, note, note ? shippedSince(note, releases) : null, now);
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
    for (const [key, { raw, note }] of blockedPoll?.fresh ? blocked : []) {
      if (blockedSeen.get(key) === raw) continue;
      let actions: BlockedAction[];
      try {
        const shipped = shippedSince(note, releases);
        if (shipped === null) continue;
        actions = shipped || !isRecent(note, now) ? [] : routeBlocked(note, me);
      } catch (error) {
        // A note that cannot be routed (JSON from another repository) never stops the others.
        log.error(`nota barrada ${key.slice(0, 12)}: ${describe(error)}`);
        continue;
      }
      if (await attempt(actions, (action) => actBlocked(action, key, note, config, me, auth), handled)) blockedSeen.set(key, raw);
    }
    if (blockedPoll?.fresh) handled.push(...(await followUp(me, releases)));
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
