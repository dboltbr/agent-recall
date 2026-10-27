import type { Harness, SessionRef } from "./types.ts";

const HARNESSES: readonly Harness[] = ["paseo", "opencode"];
const VALUE = /^(paseo|opencode)\/([^/\s]+)\/([^/\s]+)$/;
const LINE = /^Agent-Session:[ \t]*(\S+)[ \t]*$/gm;

/** Parses a trailer value (`paseo/<serverId>/<agentId>`); anything else is null. */
export function parseSessionValue(value: string | undefined | null): SessionRef | null {
  const match = VALUE.exec((value ?? "").trim());
  if (!match) return null;
  return { harness: match[1] as Harness, host: match[2]!, id: match[3]! };
}

/** The last `Agent-Session:` trailer of a commit message, if any. */
export function parseAgentSession(message: string): SessionRef | null {
  let found: SessionRef | null = null;
  for (const match of message.matchAll(LINE)) found = parseSessionValue(match[1]) ?? found;
  return found;
}

export function formatSession(ref: SessionRef): string {
  return `${ref.harness}/${ref.host}/${ref.id}`;
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.harness === b.harness && a.host === b.host && a.id === b.id;
}

/** Accepts a note session object; drops anything that is not a well-formed trailer. */
export function toSessionRef(value: unknown): SessionRef | null {
  if (!value || typeof value !== "object") return null;
  const { harness, host, id } = value as Record<string, unknown>;
  if (typeof harness !== "string" || typeof host !== "string" || typeof id !== "string") return null;
  if (!HARNESSES.includes(harness as Harness)) return null;
  return parseSessionValue(`${harness}/${host}/${id}`);
}
