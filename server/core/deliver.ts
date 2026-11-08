import { describe } from "./poll.ts";
import { formatSession } from "./trailer.ts";
import { noteSignals } from "./release-status.ts";
import { noteOwner, roleOf, type Action, type NoteAction } from "./route.ts";
import type { BlockedNote, Logger, Note, SessionRef } from "./types.ts";

/** Why the watch could not revert, in pt-BR (codes of `scripts/release-incident-note.py`). */
const ROLLBACK_REASONS: Readonly<Record<string, string>> = {
  "dlc-rollback-missing": "sem o artefato dlc-rollback do run da release",
  "dlc-rollback-invalid": "artefato dlc-rollback ilegível",
  "dlc-rollback-range-mismatch": "dlc-rollback de outra faixa",
  "unsafe-migration": "a imagem anterior não aguenta o banco depois da faixa",
  conflict: "o revert conflita com o HEAD",
  "deploy-error": "o dbolt-deploy recusou o revert",
  "push-failed": "o push do revert na main falhou",
  "push-rejected": "o push do revert na main foi recusado 3 vezes",
  "range-too-large": "a faixa é grande demais para reverter",
  "nothing-to-revert": "a faixa não tem commit de flags revertível",
  "already-reverted": "a main já desfez as flags da faixa",
  drill: "ensaio",
};

function reasonText(reason: string | undefined): string {
  if (!reason) return "sem motivo na nota";
  const text = ROLLBACK_REASONS[reason];
  return text ? `${text} (${reason})` : reason;
}

/** `5xx: errors5xx-ratio; Sentry: new-issue`: the red sources of the verdict. */
export function redReasons(note: Note): string {
  const red = noteSignals(note).filter((signal) => signal.outcome === "red");
  return red.length ? red.map((signal) => (signal.reason ? `${signal.label}: ${signal.reason}` : signal.label)).join("; ") : "vigia vermelho";
}

/** Where production stands after the watch's rollback, in one pt-BR sentence. */
export function rollbackLine(release: string, note: Note): string {
  const rollback = note.rollback;
  const commit = typeof rollback?.commit === "string" ? ` (commit ${rollback.commit.slice(0, 12)})` : "";
  switch (rollback?.outcome) {
    case "reverted": {
      const what = rollback.target === "main" ? "reverteu as flags da faixa na main" : `reverteu a ${release} no dbolt-deploy`;
      const applied = rollback.applied
        ? "o Flux aplicou: produção voltou à release anterior"
        : "o Flux NÃO aplicou em 5 min: confira o Flux antes de contar com a release anterior";
      return `o vigia ${what}${commit}; ${applied}.`;
    }
    case "blocked": {
      const findings = rollback.findings?.length ? `, ${rollback.findings.length} achado(s) em findings` : "";
      return `impedido: ${reasonText(rollback.reason)}${findings}. Produção segue na ${release}; o caminho é Fixes-Release.`;
    }
    case "failed": {
      const detail = rollback.detail ? `: ${rollback.detail}` : "";
      return `falhou: ${reasonText(rollback.reason)}${detail}. Produção segue na ${release}.`;
    }
    case "none":
      return `nada revertido: ${reasonText(rollback.reason)}.`;
    case "pending":
      return "pendente: o vigia não gravou o desfecho do rollback; leia a nota antes de agir.";
    default:
      return "a nota não traz rollback.";
  }
}

/** The freeze the note puts on main, or the drill's lack of one. */
function freezeLine(release: string, note: Note): string {
  if (note.drill) return "Ensaio: nada foi revertido nem congelado.";
  return (
    `A main está congelada para código até ficar verde uma release com Fixes-Release: ${release} ` +
    `(com o "ship" do responsável) ou Reverts-Release: ${release}; Break-Glass só por decisão do responsável.`
  );
}

/** The owner: asked to act, with the reason, the rollback and the freeze. */
export function ownerPrompt(release: string, note: Note): string {
  return (
    `Incidente ${release}: carregue a skill dbolt-release-incident. Papel: owner. ` +
    `A sua sessão é a dona da ${release}, vermelha no vigia: investigue e corrija com Fixes-Release ou reverta com Reverts-Release. ` +
    `Motivo: ${redReasons(note)}. Rollback: ${rollbackLine(release, note)} ${freezeLine(release, note)} ` +
    `Nota: ${JSON.stringify(note)}`
  );
}

/** A notified session: told, never asked to act, with the owner's name. */
export function notifiedPrompt(release: string, note: Note): string {
  const owner = noteOwner(note);
  const push = note.drill
    ? "Ensaio: a main não fica congelada."
    : "O seu próximo push de código para a main será recusado até a correção verde.";
  return (
    `Incidente ${release}: carregue a skill dbolt-release-incident. Papel: notified. ` +
    `Aviso, sem pedido de ação: um commit seu está na faixa da ${release}, vermelha no vigia (motivo: ${redReasons(note)}). ` +
    `Quem age é a dona, ${owner ? formatSession(owner) : "sem dono"}; investigar, corrigir e reverter cabem a ela. ` +
    `${push} Nota: ${JSON.stringify(note)}`
  );
}

export function promptFor(action: NoteAction, note: Note): string {
  return action.role === "owner" ? ownerPrompt(action.release, note) : notifiedPrompt(action.release, note);
}

/**
 * Every call of a blocked-release note: the skill decides between investigating and fixing from
 * the note state. `key` is the run's head commit the note sits on.
 */
export function blockedPrompt(release: string, key: string, note: BlockedNote): string {
  const essentials = {
    number: Number(release.replace(/^release-/, "")),
    url: note.run?.url ?? null,
    headSha: key,
    failedJob: note.run?.failedJob ?? null,
    state: note.state,
  };
  return `Release barrada ${release}: carregue a skill dbolt-release-incident. Papel: blocked. Release: ${JSON.stringify(essentials)}`;
}

/**
 * What a harness can do. Each step throws when it was refused. `action` is the call being made,
 * for a harness that hands the call over asynchronously and confirms it later (Claude Code).
 */
export interface Delivery {
  /** Prompt the existing session. */
  prompt(target: SessionRef, text: string, action: Action): Promise<void>;
  /** Fork (OpenCode, Claude Code) or new agent in the session's workspace (Paseo), then prompt it. */
  fallback(target: SessionRef, text: string, title: string, action: Action): Promise<string>;
  /**
   * The session a lane stands in for: its parent, up to the root (Paseo `paseo.parent-agent-id`,
   * OpenCode `parentID`). Absent: the harness has no lanes, every session is its own root.
   */
  resolveRoot?(target: SessionRef): Promise<SessionRef>;
  /**
   * The session is working: in a turn, or active in the last 10 min (Paseo `running`, OpenCode
   * busy, the Claude Code transcript). Absent or false: no heartbeat, the lease runs out.
   */
  isWorking?(target: SessionRef): Promise<boolean>;
  /** A new session in `directory`, prompted with `text`: the incident host's agent. Returns its id. */
  open?(directory: string, text: string, title: string): Promise<string>;
}

/** `incident`: a new agent the incident host opened. */
export type Outcome = "prompt" | "fallback" | "incident" | "recorded" | "failed";

/** How a call ended, and the session id that received it (null when nobody did). */
export interface Delivered {
  readonly outcome: Outcome;
  readonly session: string | null;
}

/** What gave up, for the note's `recall` field. */
export interface Failure {
  readonly role: string;
  readonly target: string;
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
  /** Writes the failure into the note; true when it landed. */
  readonly recordFailure: (failure: Failure) => Promise<boolean>;
  readonly host: string;
  readonly log: Logger;
}

/** Fallback chain: prompt → fork/new agent → failure in the note. */
export async function deliver(input: DeliverInput): Promise<Delivered> {
  const { action, text, title, delivery, log } = input;
  const failures: string[] = [];
  try {
    await delivery.prompt(action.target, text, action);
    return { outcome: "prompt", session: action.target.id };
  } catch (error) {
    failures.push(`prompt: ${describe(error)}`);
  }
  try {
    const id = await delivery.fallback(action.target, text, title, action);
    log.warn(`${action.release}: ${formatSession(action.target)} recusou o prompt; chamado foi para ${id}`);
    return { outcome: "fallback", session: id };
  } catch (error) {
    failures.push(`fallback: ${describe(error)}`);
  }
  const target = formatSession(action.target);
  const role = roleOf(action);
  const reason = failures.join("; ");
  log.error(`${input.drill ? "[ensaio] " : ""}não consegui chamar ${target} para ${action.release} (${role}): ${reason}`);
  try {
    if (await input.recordFailure({ role, target, reason })) return { outcome: "recorded", session: null };
    log.error(`${action.release}: a falha do chamado não entrou na nota`);
  } catch (error) {
    log.error(`${action.release}: gravar a falha na nota: ${describe(error)}`);
  }
  return { outcome: "failed", session: null };
}
