import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Monitor } from "./monitor.ts";

/** Long-poll ceiling: below the host's 20 s `serviceRequest` deadline. */
export const MAX_WAIT_MS = 15_000;

export interface HandlerOptions<S, R> {
  readonly token: string;
  readonly monitor: Monitor<S>;
  /** One release by number (`/release 172`), or null when there is no such release. */
  readonly lookup: (release: number) => Promise<R | null>;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

/** HTTP handler of the extension's local service. Every route needs the host's bearer token. */
export function createHandler<S, R>(options: HandlerOptions<S, R>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, options.token)) return send(response, 401, { error: "não autorizado" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });

      if (request.method === "GET" && url.pathname === "/snapshot") {
        options.monitor.touch();
        const after = Number(url.searchParams.get("after") ?? "-1");
        const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
        const envelope = await options.monitor.waitForChange(Number.isFinite(after) ? after : -1, wait);
        return send(response, 200, envelope);
      }

      if (request.method === "POST" && url.pathname === "/refresh") {
        await options.monitor.refresh();
        return send(response, 200, options.monitor.current());
      }

      if (request.method === "GET" && url.pathname === "/release") {
        const number = Number(url.searchParams.get("number"));
        if (!Number.isInteger(number) || number <= 0) return send(response, 400, { error: "número de release inválido" });
        options.monitor.touch();
        const found = await options.lookup(number);
        return found === null ? send(response, 404, { error: `release-${number} não encontrada` }) : send(response, 200, found);
      }

      return send(response, 404, { error: "rota desconhecida" });
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
