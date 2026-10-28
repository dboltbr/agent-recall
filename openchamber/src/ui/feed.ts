// Page side of the service protocol: long-polls `GET /snapshot` through `host.serviceRequest`
// and hands each new envelope to the surface. No DOM, so it is tested with fakes.
import { z } from "zod";
import { ReleaseSchema, ReleaseSnapshotSchema, type Release } from "../../../core/release-status.ts";

/** What `GET /snapshot` answers; the snapshot is checked against the shared contract. */
export const EnvelopeSchema = z.object({
  seq: z.number(),
  snapshot: ReleaseSnapshotSchema.nullable(),
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  refreshing: z.boolean(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface ServiceCall {
  (request: { method: "GET" | "POST"; path: string; query?: Record<string, string> }): Promise<{ status: number; body: unknown }>;
}

export interface FeedState {
  readonly envelope: Envelope | null;
  /** Why the service cannot be reached (not approved, crashed), in pt-BR. */
  readonly unavailable: string | null;
}

export interface FeedOptions {
  readonly call: ServiceCall;
  readonly onState: (state: FeedState) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Long-poll window asked of the service; it caps it below the host deadline. */
  readonly waitMs?: number;
}

export const LONG_POLL_MS = 15_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function toEnvelope(value: unknown): Envelope | null {
  const parsed = EnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** pt-BR reason for a failed service call (host error codes come on `error.code`). */
export function describeServiceError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "NO_SERVICE":
      return "Serviço local não aprovado ou parado. Aprove a extensão em Configurações → Extensões.";
    case "SERVICE_FAILED":
      return "O serviço local da extensão falhou ao iniciar.";
    case "DISABLED":
      return "Extensão pausada em Configurações → Extensões.";
    case "HOST_TIMEOUT":
    case "REQUEST_FAILED":
      return "O serviço local não respondeu a tempo.";
    default:
      return error instanceof Error ? error.message : "Serviço local indisponível.";
  }
}

/** `GET /release?number=N`: one release, null when the service does not know it. */
export async function fetchRelease(call: ServiceCall, number: number): Promise<Release | null> {
  const response = await call({ method: "GET", path: "/release", query: { number: String(number) } });
  if (response.status === 404) return null;
  if (response.status !== 200) {
    const body = parseBody(response.body) as { error?: string } | null;
    throw new Error(body?.error ?? `Serviço local respondeu ${response.status}.`);
  }
  const parsed = ReleaseSchema.safeParse(parseBody(response.body));
  if (!parsed.success) throw new Error("Resposta inesperada do serviço local.");
  return parsed.data;
}

/** The current envelope; on a cold service, waits up to `waitMs` for the first load. */
export async function fetchCurrent(call: ServiceCall, waitMs = LONG_POLL_MS): Promise<Envelope> {
  const read = async (after: number, wait: number) => {
    const response = await call({ method: "GET", path: "/snapshot", query: { after: String(after), wait: String(wait) } });
    if (response.status !== 200) throw new Error(`Serviço local respondeu ${response.status}.`);
    const envelope = toEnvelope(parseBody(response.body));
    if (!envelope) throw new Error("Resposta inesperada do serviço local.");
    return envelope;
  };
  const envelope = await read(-1, 0);
  return envelope.snapshot || envelope.error ? envelope : read(envelope.seq, waitMs);
}

export interface Feed {
  /** Asks the service to refresh now; the new envelope also arrives through `onState`. */
  refresh(): Promise<void>;
  /** One release by number; null when the service does not know it. */
  release(number: number): Promise<Release | null>;
  stop(): void;
}

export function startFeed(options: FeedOptions): Feed {
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.waitMs ?? LONG_POLL_MS;
  let stopped = false;
  let state: FeedState = { envelope: null, unavailable: null };

  const publish = (next: FeedState) => {
    state = next;
    if (!stopped) options.onState(state);
  };

  const accept = (body: unknown) => {
    const parsed = toEnvelope(parseBody(body));
    if (!parsed) throw new Error("Resposta inesperada do serviço local.");
    if (!state.envelope || parsed.seq !== state.envelope.seq || parsed.refreshing !== state.envelope.refreshing || state.unavailable) {
      publish({ envelope: parsed, unavailable: null });
    }
  };

  void (async () => {
    let backoff = 2_000;
    let first = true;
    while (!stopped) {
      try {
        const after = state.envelope?.seq ?? -1;
        const response = await options.call({
          method: "GET",
          path: "/snapshot",
          query: { after: String(after), wait: String(first ? 0 : waitMs) },
        });
        if (response.status !== 200) throw new Error(`Serviço local respondeu ${response.status}.`);
        accept(response.body);
        first = false;
        backoff = 2_000;
        // An answer without a snapshot yet (service just started): ask again without hammering.
        if (!state.envelope?.snapshot && !stopped) await sleep(500);
      } catch (error) {
        if (stopped) break;
        publish({ envelope: state.envelope, unavailable: describeServiceError(error) });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();

  return {
    async refresh() {
      const response = await options.call({ method: "POST", path: "/refresh" });
      if (response.status !== 200) throw new Error(`Serviço local respondeu ${response.status}.`);
      accept(response.body);
    },
    release: (number) => fetchRelease(options.call, number),
    stop() {
      stopped = true;
    },
  };
}
