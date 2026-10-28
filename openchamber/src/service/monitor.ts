// Keeps the latest release snapshot fresh on a cadence that follows the release: fast while a run
// is active, slow when idle, paused when nobody has asked for a while. Pages long-poll it.

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const nodeTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MonitorOptions<S> {
  /** Builds a fresh snapshot. May throw; the last good snapshot is kept. */
  readonly load: () => Promise<S>;
  /** True while a release run is in flight: selects the fast cadence. */
  readonly isActive: (snapshot: S) => boolean;
  readonly now: () => number;
  readonly timers?: Timers;
  readonly activeMs?: number;
  readonly idleMs?: number;
  /** After this long without `touch()`, polling stops until the next request. */
  readonly pauseAfterMs?: number;
}

/** What the service hands the page. */
export interface Envelope<S> {
  /** Increments whenever `snapshot` or `error` changes. 0 = nothing loaded yet. */
  readonly seq: number;
  readonly snapshot: S | null;
  /** ISO time of the last successful load. */
  readonly fetchedAt: string | null;
  /** pt-BR reason of the last failed load, cleared by the next success. */
  readonly error: string | null;
  readonly refreshing: boolean;
}

export interface Monitor<S> {
  current(): Envelope<S>;
  /** Marks demand: resumes a paused monitor and refreshes now when the data is stale. */
  touch(): void;
  /** Forces a refresh now (the refresh button). Resolves when it finishes. */
  refresh(): Promise<void>;
  /** Resolves with the envelope once `seq > after`, or with the current one after `waitMs`. */
  waitForChange(after: number, waitMs: number): Promise<Envelope<S>>;
  stop(): void;
}

export const ACTIVE_INTERVAL_MS = 30_000;
export const IDLE_INTERVAL_MS = 300_000;
export const PAUSE_AFTER_MS = 600_000;

export function createMonitor<S>(options: MonitorOptions<S>): Monitor<S> {
  const timers = options.timers ?? nodeTimers;
  const activeMs = options.activeMs ?? ACTIVE_INTERVAL_MS;
  const idleMs = options.idleMs ?? IDLE_INTERVAL_MS;
  const pauseAfterMs = options.pauseAfterMs ?? PAUSE_AFTER_MS;

  let envelope: Envelope<S> = { seq: 0, snapshot: null, fetchedAt: null, error: null, refreshing: false };
  let lastLoadAt = -Infinity;
  let lastTouchAt = -Infinity;
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let stopped = false;
  const waiters = new Set<{ after: number; resolve: (value: Envelope<S>) => void; timer: unknown }>();

  const interval = () => (envelope.snapshot && options.isActive(envelope.snapshot) ? activeMs : idleMs);
  const paused = () => options.now() - lastTouchAt > pauseAfterMs;

  const publish = (next: Envelope<S>) => {
    envelope = next;
    for (const waiter of [...waiters]) {
      if (envelope.seq > waiter.after) {
        timers.clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(envelope);
      }
    }
  };

  const schedule = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (stopped || paused()) return;
    const wait = Math.max(0, lastLoadAt + interval() - options.now());
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, wait);
  };

  const run = (): Promise<void> => {
    if (inflight) return inflight;
    envelope = { ...envelope, refreshing: true };
    inflight = (async () => {
      try {
        const snapshot = await options.load();
        lastLoadAt = options.now();
        const changed = JSON.stringify(snapshot) !== JSON.stringify(envelope.snapshot) || envelope.error !== null;
        const fetchedAt = new Date(lastLoadAt).toISOString();
        publish({
          seq: changed ? envelope.seq + 1 : envelope.seq,
          snapshot,
          fetchedAt,
          error: null,
          refreshing: false,
        });
      } catch (error) {
        // A failure still counts as a load for the cadence: no hot retry loop against GitHub.
        lastLoadAt = options.now();
        const message = error instanceof Error ? error.message : String(error);
        const changed = message !== envelope.error;
        publish({ ...envelope, seq: changed ? envelope.seq + 1 : envelope.seq, error: message, refreshing: false });
      } finally {
        inflight = null;
        schedule();
      }
    })();
    return inflight;
  };

  return {
    current: () => envelope,
    touch() {
      const wasPaused = paused();
      lastTouchAt = options.now();
      if (stopped) return;
      if (options.now() - lastLoadAt >= interval()) void run();
      else if (wasPaused || timer === null) schedule();
    },
    refresh() {
      lastTouchAt = options.now();
      return run();
    },
    waitForChange(after, waitMs) {
      if (envelope.seq > after || waitMs <= 0) return Promise.resolve(envelope);
      return new Promise((resolve) => {
        const waiter = {
          after,
          resolve,
          timer: timers.setTimeout(() => {
            waiters.delete(waiter);
            resolve(envelope);
          }, waitMs),
        };
        waiters.add(waiter);
      });
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      for (const waiter of waiters) {
        timers.clearTimeout(waiter.timer);
        waiter.resolve(envelope);
      }
      waiters.clear();
    },
  };
}
