import { describe } from "./poll.ts";
import { formatSession } from "./trailer.ts";
import type { Action } from "./route.ts";
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

export function promptFor(action: Action, note: Note): string {
  switch (action.kind) {
    case "recall":
      return recallPrompt(action.release, action.role, note);
    case "investigation":
      return recallPrompt(action.release, "investigate", note);
    case "remind":
      return reminderPrompt(action.release, note);
  }
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

/** What gave up, for the note's `recall` field. */
export interface Failure {
  readonly role: string;
  readonly target?: string;
  readonly reason: string;
}

export interface DeliverInput {
  readonly action: Action;
  readonly note: Note;
  readonly delivery: Delivery;
  /** Writes the failure into the note; true when it landed. */
  readonly recordFailure: (failure: Failure) => Promise<boolean>;
  readonly host: string;
  readonly log: Logger;
}

/** Fallback chain: prompt → fork/new agent → failure in the note. Investigation: create → note. */
export async function deliver(input: DeliverInput): Promise<Outcome> {
  const { action, note, delivery, log } = input;
  const text = promptFor(action, note);
  const title = `Incidente ${action.release}${note.drill ? " [ensaio]" : ""}`;
  const failures: string[] = [];
  if (action.kind === "investigation") {
    try {
      const id = await delivery.create(text, title);
      log.info(`${action.release}: sessão de investigação ${id} criada`);
      return "created";
    } catch (error) {
      failures.push(`criar sessão: ${describe(error)}`);
    }
  } else {
    try {
      await delivery.prompt(action.target, text);
      return "prompt";
    } catch (error) {
      failures.push(`prompt: ${describe(error)}`);
    }
    try {
      const id = await delivery.fallback(action.target, text, title);
      log.warn(`${action.release}: ${formatSession(action.target)} recusou o prompt; chamado foi para ${id}`);
      return "fallback";
    } catch (error) {
      failures.push(`fallback: ${describe(error)}`);
    }
  }
  const target = action.kind === "investigation" ? undefined : formatSession(action.target);
  const role = action.kind === "recall" ? action.role : action.kind === "remind" ? "remind" : "investigate";
  const reason = failures.join("; ");
  log.error(`${note.drill ? "[ensaio] " : ""}não consegui chamar ${target ?? "nova sessão de investigação"} para ${action.release} (${role}): ${reason}`);
  try {
    if (await input.recordFailure({ role, target, reason })) return "recorded";
    log.error(`${action.release}: a falha do chamado não entrou na nota`);
  } catch (error) {
    log.error(`${action.release}: gravar a falha na nota: ${describe(error)}`);
  }
  return "failed";
}
