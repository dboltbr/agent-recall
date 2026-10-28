// The one client-side view of the release snapshot: a store the client entry starts with
// `client.rpc`, polled while the app is open (15 s with a run in flight, 60 s idle), read by every
// surface through `useReleaseState`. One loop per app feeds the pills, the footer, the popovers and
// the screen, so they never disagree. The daemon serves its cached snapshot; GitHub is not called
// from here.
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { releaseRefresh, releaseSnapshot, type ReleaseView } from "../shared/rpc.ts";
import { isActive } from "../shared/release-status.ts";

/** A daemon RPC that does not answer in this long is reported as failed. */
export const RPC_TIMEOUT_MS = 20_000;
export const ACTIVE_POLL_MS = 15_000;
export const IDLE_POLL_MS = 60_000;

export interface ReleaseState {
  readonly view: ReleaseView | null;
  /** pt-BR reason the last read failed (the view, if any, is the last good one). */
  readonly error: string | null;
  /** First read still in flight. */
  readonly loading: boolean;
  /** "Atualizar" in flight. */
  readonly refreshing: boolean;
  /** When the client last got an answer from the daemon. */
  readonly receivedAt: number | null;
}

type Rpc = PluginCommandCapabilities["rpc"];

const INITIAL: ReleaseState = { view: null, error: null, loading: true, refreshing: false, receivedAt: null };

let state: ReleaseState = INITIAL;
let rpc: Rpc | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<ReleaseState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "erro desconhecido";
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("o daemon não respondeu em 20 s")), RPC_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(deadline);
        resolve(value);
      },
      (error) => {
        clearTimeout(deadline);
        reject(error);
      },
    );
  });
}

function anyActive(view: ReleaseView | null): boolean {
  return view?.snapshot?.releases.some(isActive) ?? false;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!rpc) return;
  timer = setTimeout(() => void load(), anyActive(state.view) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

async function load(): Promise<void> {
  if (!rpc) return;
  if (inFlight) return inFlight;
  const call = rpc;
  inFlight = (async () => {
    try {
      const view = await withTimeout(call(releaseSnapshot, {}));
      set({ view, error: null, loading: false, receivedAt: Date.now() });
    } catch (error) {
      set({ error: `Não foi possível ler o status dos releases: ${describe(error)}`, loading: false });
    } finally {
      inFlight = null;
      schedule();
    }
  })();
  return inFlight;
}

/** Starts the poll loop (client entry); the returned stop ends it. */
export function startReleaseStore(next: Rpc): () => void {
  rpc = next;
  state = INITIAL;
  void load();
  return () => {
    rpc = null;
    if (timer) clearTimeout(timer);
    timer = null;
    listeners.clear();
  };
}

/** "Atualizar": asks the daemon to re-read GitHub now (throttled there), then shows the result. */
export async function refreshReleases(): Promise<{ ok: boolean; error: string | null }> {
  if (!rpc) return { ok: false, error: "Plugin descarregado." };
  set({ refreshing: true });
  try {
    const result = await withTimeout(rpc(releaseRefresh, {}));
    set({ view: result.view, error: null, loading: false, refreshing: false, receivedAt: Date.now() });
    schedule();
    return { ok: true, error: null };
  } catch (error) {
    const message = `Não foi possível atualizar: ${describe(error)}`;
    set({ refreshing: false, error: message });
    return { ok: false, error: message };
  }
}

/** Retry after a failed read (error states). */
export function retryReleases(): void {
  set({ loading: state.view === null });
  void load();
}

export function subscribeReleases(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function releaseState(): ReleaseState {
  return state;
}

export function useReleaseState(): ReleaseState {
  return useSyncExternalStore(subscribeReleases, releaseState, releaseState);
}

/** A clock that re-renders every `everyMs` (running step durations, "há N min"). */
export function useNow(everyMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Title of a local Paseo agent from the view, when the daemon knows it. */
export function agentTitle(view: ReleaseView | null, id: string): string | null {
  return view?.agents.find((agent) => agent.id === id)?.title ?? null;
}
