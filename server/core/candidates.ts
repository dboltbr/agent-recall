import { z } from 'zod';
import type { Delivery } from './deliver.ts';
import { parseSessionValue } from './trailer.ts';
import type { Fetch, Me } from './types.ts';

const message = z.object({
  kind: z.literal('candidate-result'), key: z.string().min(1), session: z.string(), submittedSha: z.string(),
  result: z.object({ candidateId: z.string(), revisionId: z.string().nullable(), outcome: z.enum(['approved', 'rejected']), baseSha: z.string().nullable(), candidateSha: z.string().nullable(), evidence: z.string(), finishedAt: z.string() }),
});

/** A claim is durable in the factory before the prompt. Ambiguous prompts never fall back. */
export async function pollCandidates(input: { fetch: Fetch; url: string; token: string; me: Me; delivery: Delivery }) {
  if (!input.delivery.promptCandidate) return;
  const base = new URL(input.url);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) || !input.token) throw new Error('Configuração de retorno de candidato inválida');
  async function request(path: string, body?: object) {
    const response = await input.fetch(new URL('/verification/recall' + path, base).href, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Retorno de candidato: HTTP ${response.status}`);
    return response.json();
  }
  const data = z.object({ candidates: z.array(message).max(1000) }).parse(await request(''));
  for (const event of data.candidates) {
    const target = parseSessionValue(event.session);
    if (!target || target.host !== input.me.host || target.harness !== input.me.harness) continue;
    const claim = z.object({ claimed: z.boolean() }).parse(await request('/claim', { key: event.key }));
    if (!claim.claimed) continue;
    const text = `Resultado do candidato ${event.result.candidateId}: ${event.result.outcome === 'approved' ? 'aprovado' : 'recusado'}. SHA enviado ${event.submittedSha}; SHA verificado ${event.result.candidateSha ?? 'não preparado'}; base ${event.result.baseSha ?? 'não preparada'}. Evidência: ${event.result.evidence}. Este retorno é da fila antes da publicação, não é incidente de release; não executar rollback nem congelar produção.`;
    const receipt = await input.delivery.promptCandidate(target, text, event.key);
    if (!receipt) { await request('/queued', { key: event.key }); continue; }
    z.object({ receipt: z.string().min(1) }).parse(await request('/confirm', { key: event.key, receipt }));
  }
}

export async function confirmCandidate(input: { fetch: Fetch; url: string; token: string; key: string; receipt: string }) {
  const base = new URL(input.url);
  if (base.protocol !== 'https:' || base.username || base.password || !input.token) throw new Error('Configuração de confirmação inválida');
  const response = await input.fetch(new URL('/verification/recall/confirm', base).href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.key, receipt: input.receipt }) });
  if (!response.ok) throw new Error(`Confirmação de candidato: HTTP ${response.status}`);
  const body = z.object({ receipt: z.string() }).parse(await response.json());
  if (body.receipt !== input.receipt) throw new Error('Recibo de candidato divergente');
}
