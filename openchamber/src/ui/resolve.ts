// `/release [n]` → composer chip. Pure over injected reads, so it is tested without a host.
import { findRelease, type Release } from "../../../core/release-status.ts";
import type { Envelope } from "./feed.ts";
import { parseReleaseArgs, primaryRelease, releaseChip, type Chip } from "./view.ts";

export interface ResolveDeps {
  readonly current: () => Promise<Envelope>;
  readonly release: (number: number) => Promise<Release | null>;
  readonly now: () => Date;
}

export async function resolveChip(args: string, deps: ResolveDeps): Promise<Chip> {
  const wanted = parseReleaseArgs(args);
  if (wanted === "invalid") throw new Error("Use /release ou /release 172.");
  const envelope = await deps.current();
  const snapshot = envelope.snapshot;
  if (!snapshot && wanted === null) throw new Error(envelope.error ?? "Status do release ainda indisponível.");
  let release = wanted === null ? (snapshot ? primaryRelease(snapshot) : null) : (snapshot ? findRelease(snapshot, wanted) : null);
  if (!release && wanted !== null) release = await deps.release(wanted);
  if (!release) throw new Error(wanted === null ? "Nenhuma run do workflow release encontrada." : `release-${wanted} não encontrada.`);
  return releaseChip(snapshot, release, deps.now());
}
