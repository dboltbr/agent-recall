import { describe } from "./poll.ts";
import { formatSession } from "./trailer.ts";
import type { Release } from "./release-status.ts";
import { roleOf, type Action, type NoteAction } from "./route.ts";
import type { Logger, Note, Role, SessionRef } from "./types.ts";

/** The contract prompt. The dbolt procedure lives in the skill, not here. */
export function recallPrompt(release: string, role: Role, note: Note): string {
  return `Incidente ${release}: carregue a skill dbolt-release-incident. Papel: ${role}. Nota: ${JSON.stringify(note)}`;
}

export function reminderPrompt(release: string, note: Note): string {
  return (
    `Lembrete: o fix-forward da ${release} passou de 30 min sem fix.readyAt; pela skill ` +
    `dbolt-release-incident (Prazos) o owner reverte agora e segue corrigindo. ` +
    recallPrompt(release, "investigate", note)
  );
}

export function promptFor(action: NoteAction, note: Note): string {
  switch (action.kind) {
    case "recall":
      return recallPrompt(action.release, action.role, note);
    case "investigation":
      return recallPrompt(action.release, "investigate", note);
    case "remind":
      return reminderPrompt(action.release, note);
  }
}

/** A release that failed before the tag has no note: the prompt carries the run itself. */
export function blockedPrompt(release: Release): string {
  const snapshot = {
    number: release.number,
    url: release.url,
    headSha: release.headSha,
    title: release.title,
    failedJob: release.failedJob,
    sessions: release.sessions.map((session) => `${session.harness}/${session.host}/${session.id}`),
  };
  return `Release barrada ${release.name}: carregue a skill dbolt-release-incident. Papel: blocked. Release: ${JSON.stringify(snapshot)}`;
}

/** What a harness can do. Each step throws when it was refused. */
export interface Delivery {
  /** Prompt the existing session. */
  prompt(target: SessionRef, text: string): Promise<void>;
  /** Fork (OpenCode) or new agent in the session's workspace (Paseo), then prompt it. */
  fallback(target: SessionRef, text: string, title: string): Promise<string>;
  /** New investigation session in a checkout of the repository. */
  create(text: string, title: string): Promise<string>;
}

export type Outcome = "prompt" | "fallback" | "created" | "recorded" | "failed";

/** How a call ended, and the session id that received it (null when nobody did). */
export interface Delivered {
  readonly outcome: Outcome;
  readonly session: string | null;
}

/** What gave up, for the note's `recall` field. */
export interface Failure {
  readonly role: string;
  readonly target?: string;
  readonly reason: string;
}

export interface DeliverInput {
  readonly action: Action;
  /** The prompt (`promptFor` or `blockedPrompt`). */
  readonly text: string;
  /** Title of a fallback or new session. */
  readonly title: string;
  /** A drill: logs say so. */
  readonly drill?: boolean;
  readonly delivery: Delivery;
  /** Writes the failure into the note; true when it landed. Null: there is no note, only the log. */
  readonly recordFailure: ((failure: Failure) => Promise<boolean>) | null;
  readonly host: string;
  readonly log: Logger;
}

/** Fallback chain: prompt → fork/new agent → failure in the note. Investigation: create → note. */
export async function deliver(input: DeliverInput): Promise<Delivered> {
  const { action, text, title, delivery, log } = input;
  const failures: string[] = [];
  if (action.kind === "investigation") {
    try {
      const id = await delivery.create(text, title);
      log.info(`${action.release}: sessão de investigação ${id} criada`);
      return { outcome: "created", session: id };
    } catch (error) {
      failures.push(`criar sessão: ${describe(error)}`);
    }
  } else {
    try {
      await delivery.prompt(action.target, text);
      return { outcome: "prompt", session: action.target.id };
    } catch (error) {
      failures.push(`prompt: ${describe(error)}`);
    }
    try {
      const id = await delivery.fallback(action.target, text, title);
      log.warn(`${action.release}: ${formatSession(action.target)} recusou o prompt; chamado foi para ${id}`);
      return { outcome: "fallback", session: id };
    } catch (error) {
      failures.push(`fallback: ${describe(error)}`);
    }
  }
  const target = action.kind === "investigation" ? undefined : formatSession(action.target);
  const role = roleOf(action);
  const reason = failures.join("; ");
  log.error(`${input.drill ? "[ensaio] " : ""}não consegui chamar ${target ?? "nova sessão de investigação"} para ${action.release} (${role}): ${reason}`);
  if (!input.recordFailure) return { outcome: "failed", session: null };
  try {
    if (await input.recordFailure({ role, target, reason })) return { outcome: "recorded", session: null };
    log.error(`${action.release}: a falha do chamado não entrou na nota`);
  } catch (error) {
    log.error(`${action.release}: gravar a falha na nota: ${describe(error)}`);
  }
  return { outcome: "failed", session: null };
}
