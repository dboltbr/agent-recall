import { join } from "node:path";
import { deliver, type Delivery, type Outcome } from "./deliver.ts";
import { acquireLock, writeHandoff, writeHeartbeat } from "./host.ts";
import { fetchNotes, recordRecallFailure, type FetchedNote } from "./notes.ts";
import { describe, POLL_INTERVAL_MS, pollRef, type PollResult } from "./poll.ts";
import type { ReleaseTracker } from "./release-fetch.ts";
import { describeAction, dueReminder, isRecent, route, type Action } from "./route.ts";
import type { Clock, Exec, Fetch, Harness, HostConfig, Logger, Me, Note } from "./types.ts";

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
  /** Release status (Paseo UI): rides this poller's token, notes and cadence. */
  readonly release?: ReleaseTracker;
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
  readonly handled: readonly Handled[];
}

export interface Watcher {
  /** One poll: heartbeat, ref check, notes fetch on change, calls, due reminders. */
  tick(): Promise<TickReport>;
  /** Ticks now and every 30 s, never overlapping. Returns stop. */
  start(intervalMs?: number): () => Promise<void>;
}

export function createWatcher(options: WatcherOptions): Watcher {
  const { clock, exec, log } = options;
  let etag: string | null = null;
  let notesRef: string | null = null;
  let caughtUp = false;
  let token: { value: string; at: number } | null = null;
  const seen = new Map<string, string>();
  const notes = new Map<string, Note>();

  async function getToken(): Promise<string> {
    const now = clock.now().getTime();
    if (token && now - token.at < TOKEN_TTL_MS) return token.value;
    const result = await exec("gh", ["auth", "token"], { timeoutMs: 10_000 });
    const value = result.stdout.trim();
    if (result.code !== 0 || !value) throw new Error(`gh auth token falhou: ${result.stderr.trim()}`);
    token = { value, at: now };
    return value;
  }

  async function act(action: Action, key: string, note: Note, config: HostConfig, me: Me, auth: string): Promise<Handled | null> {
    if (!(await acquireLock(options.stateDir, action.release, action.lock))) return null;
    log.info(`chamando: ${describeAction(action)}`);
    const { outcome, session } = await deliver({
      action,
      note,
      delivery: options.delivery,
      recordFailure: (failure) =>
        recordRecallFailure({
          exec,
          gitDir: join(options.stateDir, `${options.harness}.git`),
          repository: config.repository,
          notesRef: config.notesRef,
          token: auth,
          key,
          recall: { ...failure, failedAt: clock.now().toISOString(), by: `${me.harness}/${me.host}`, state: note.state },
        }),
      host: me.host,
      log,
    });
    log.info(`${describeAction(action)}: ${outcome}`);
    if (session && !note.drill) {
      const role = action.kind === "recall" ? action.role : action.kind === "remind" ? "remind" : "investigate";
      await writeHandoff(options.stateDir, action.release, action.lock, {
        role,
        session: { harness: me.harness, host: me.host, id: session },
        at: clock.now().toISOString(),
      }).catch((error) => log.warn(`${action.release}: registrar o chamado: ${describe(error)}`));
    }
    return { action, outcome, session };
  }

  async function tick(): Promise<TickReport> {
    const now = clock.now();
    let config: HostConfig;
    try {
      config = await options.loadConfig();
    } catch (error) {
      log.error(describe(error));
      return { poll: "config-error", fetched: false, handled: [] };
    }
    if (config.notesRef !== notesRef) {
      notesRef = config.notesRef;
      etag = null;
      caughtUp = false;
      seen.clear();
      notes.clear();
    }
    const me: Me = { harness: options.harness, host: options.host(config), incidentHost: config.incidentHost };
    let auth: string;
    try {
      auth = await getToken();
    } catch (error) {
      log.error(describe(error));
      return { poll: "token-error", fetched: false, handled: [] };
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
        for (const { key, raw, note } of fetchedNotes) {
          if (!note || seen.get(key) === raw) continue;
          seen.set(key, raw);
          notes.set(key, note);
          if (!isRecent(note, now)) continue;
          for (const action of route(note, me)) {
            const done = await act(action, key, note, config, me, auth);
            if (done) handled.push(done);
          }
        }
      }
    }
    for (const [key, note] of notes) {
      if (!isRecent(note, now)) continue;
      const reminder = dueReminder(note, me, now);
      if (!reminder) continue;
      const done = await act(reminder, key, note, config, me, auth);
      if (done) handled.push(done);
    }
    if (options.release) {
      await options.release
        .tick({ token: auth, notes, notesChanged: fetched })
        .catch((error) => log.warn(`release: ${describe(error)}`));
    }
    return { poll: poll.kind, fetched, handled };
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

  return { tick, start };
}
