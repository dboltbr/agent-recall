import { parseNote } from "./notes.ts";
import type { Fetch, Note } from "./types.ts";

export interface FactoryRecord extends Note {
  readonly key: string;
  readonly frozen: boolean;
  readonly state: string;
}
export type FactoryPoll =
  | { kind: "unchanged" }
  | { kind: "changed"; etag: string | null; releases: FactoryRecord[] };

/** Deadline único para headers e corpo. Sem fallback para git notes nem redirect com segredo. */
export async function pollFactory(input: { fetch: Fetch; url: string; token: string; etag: string | null }): Promise<FactoryPoll> {
  const url = new URL(input.url);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("URL da API factory inválida");
  if (!input.token) throw new Error("Token do recall da factory ausente");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let onAbort: (() => void) | undefined;
  try {
    const work = async (): Promise<FactoryPoll> => {
      const response = await input.fetch(url.href, { redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${input.token}`, Accept: "application/json", ...(input.etag ? { "If-None-Match": input.etag } : {}) } });
      if (response.status === 304) return { kind: "unchanged" };
      if (response.status !== 200) throw new Error(`API factory respondeu HTTP ${response.status}`);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw new Error("API factory sem corpo");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new Error("API factory excedeu limite de 2 MB"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || !("releases" in body) || !Array.isArray(body.releases) || body.releases.length > 1000) throw new Error("Resposta do recall da factory inválida");
      const releases: FactoryRecord[] = body.releases.map((value: unknown) => {
        const note = parseNote(JSON.stringify(value));
        if (!note || !value || typeof value !== "object" || !("key" in value) || typeof value.key !== "string" || !("frozen" in value) || typeof value.frozen !== "boolean" || !("state" in value) || typeof value.state !== "string") throw new Error("Release da API factory inválida");
        return { ...note, key: value.key, frozen: value.frozen, state: value.state };
      });
      return { kind: "changed", etag: response.headers.get("etag"), releases };
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Consulta à factory excedeu deadline de 10 s"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export function factoryPrompt(role: "owner" | "notified", note: FactoryRecord, url: string): string {
  const verdict = note.verdict as { sources?: unknown } | undefined;
  return `Incidente ${note.release}. Papel: ${role}. ${role === "owner" ? "Investigue a faixa e proponha a correção." : "Aviso, sem pedido de ação; a sessão dona investiga."} Dono: ${JSON.stringify(note.owner ?? null)}. Fontes: ${JSON.stringify(verdict?.sources ?? {})}. Rollback: ${JSON.stringify(note.rollback ?? null)}. Main congelada: ${note.frozen ? "sim" : "não"}. ${note.drill ? "Ensaio/dry-run: nenhuma escrita externa foi autorizada." : "Qualquer ação externa exige autorização da responsável."} Estado atual e evidências: consulte a API factory ${url}; git notes não é autoridade. Faixa: ${JSON.stringify(note.range ?? null)}.`;
}
