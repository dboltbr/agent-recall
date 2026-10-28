// Presentation glue over the shared model in `core/release-status.ts`: the mapping, labels and
// selectors live there; this file only adds what is specific to the OpenChamber surfaces (tones,
// the badge rule, the chip, the strip copy). No DOM, so it is tested with plain `node --test`.
import {
  activeReleases,
  releaseLabel,
  releaseStamp,
  findRelease,
  formatDuration,
  formatShortDuration,
  isActive,
  lastFinished,
  queueGroups,
  queueSummary,
  releaseDurationMs,
  revertSummary,
  stepJobNames,
  stepLabel,
  stepOf,
  trippedSignals,
  VERDICT_LABELS,
  verdictDetail,
  type Job,
  type Release,
  type ReleaseSnapshot,
  type Runner,
  type Session,
  type Step,
} from "../../../core/release-status.ts";

export type Tone = "run" | "ok" | "warn" | "bad" | "mut";

export const PANEL_ID = "dbolt-release";
/** `openSurface` id of the rail panel: the host only accepts `plugin:<panel id>`. */
export const PANEL_SURFACE = `plugin:${PANEL_ID}`;

/**
 * The release every surface leads with: the newest run that is moving (a run waiting on the
 * concurrency group behind it has nothing to show yet), else the newest queued one, else the last
 * verdict, else the newest run.
 */
export function primaryRelease(snapshot: ReleaseSnapshot): Release | null {
  const active = activeReleases(snapshot);
  return active.find((release) => release.status === "running") ?? active[0] ?? lastFinished(snapshot) ?? snapshot.releases[0] ?? null;
}

export function releaseTone(release: Release): Tone {
  switch (release.verdict) {
    case null:
      return "run";
    case "green":
      return "ok";
    case "reverted":
      return "warn";
    case "red":
    case "failed":
      return "bad";
    default:
      return "mut";
  }
}

export function stepTone(step: Step): Tone {
  switch (step.state) {
    case "done":
      return "ok";
    case "running":
      return "run";
    case "failed":
      return "bad";
    default:
      return "mut";
  }
}

export function jobTone(job: Job): Tone {
  switch (job.state) {
    case "success":
      return "ok";
    case "running":
      return "run";
    case "failure":
      return "bad";
    default:
      return "mut";
  }
}

/** Text of the status pill: `em andamento` / `na fila` while active, the verdict after. */
export function statusLabel(release: Release): string {
  if (release.verdict) return VERDICT_LABELS[release.verdict];
  return release.status === "queued" ? "na fila" : "em andamento";
}

/** Fill of the running segment of the step bar, 0..1. */
export function stepFraction(step: Step): number {
  if (step.state !== "running") return step.state === "done" ? 1 : 0;
  return step.total ? Math.max(0.1, (step.done ?? 0) / step.total) : 0.33;
}

export function currentStep(release: Release): Step | null {
  return release.current ? stepOf(release, release.current) : null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

/** Header duration: `36m`, `1h 05m`. */
export function elapsedLabel(release: Release, now: Date): string {
  return formatShortDuration(releaseDurationMs(release, now));
}

/** A running step's duration counts up to now; the snapshot's figure is as of its fetch. */
export function stepDuration(step: Step, now: Date): string {
  if (step.state === "running" && step.startedAt) return formatDuration(Math.max(0, now.getTime() - Date.parse(step.startedAt)));
  return formatDuration(step.durationMs);
}

/** Second line of each step in the rail panel. */
export function stepDetail(release: Release, step: Step): string {
  switch (step.id) {
    case "verify":
    case "deploy":
      return stepJobNames(release, step.id).join(" · ");
    case "images":
      return "";
    case "tag":
      return release.tag ?? release.name;
    case "watch":
      return "sinais do blast radius → veredito";
  }
}

/** Status-strip and history copy: the running step while active, the verdict detail after. */
export function headline(release: Release): string {
  if (isActive(release)) {
    const step = currentStep(release);
    return step ? stepLabel(step) : statusLabel(release);
  }
  return verdictDetail(release) || statusLabel(release);
}

/** `revertSummary` split for two-line layouts: `vigia reverteu 3 commits` / `agente avisado`. */
export function revertParts(release: Release): { what: string; notice: string } | null {
  const summary = revertSummary(release);
  if (!summary) return null;
  const at = summary.lastIndexOf(" · ");
  return at < 0 ? { what: summary, notice: "" } : { what: summary.slice(0, at), notice: summary.slice(at + 3) };
}

/** Tripped signals with their reasons, for one-line summaries. */
export function signalSummary(release: Release): string {
  return trippedSignals(release)
    .slice(0, 2)
    .map((signal) => (signal.reason ? `${signal.label} ${signal.reason}` : signal.label))
    .join(" · ");
}

export interface QueueView {
  readonly waiting: number;
  /** Core's `6 na fila — runner solid-srv ocupado`, or null when nothing waits. */
  readonly line: string | null;
  /** Why idle runners do not help, when some are idle but lack the label the queue needs. */
  readonly hint: string | null;
}

export function queueView(snapshot: ReleaseSnapshot): QueueView {
  const groups = queueGroups(snapshot);
  const waiting = groups.reduce((sum, group) => sum + group.count, 0);
  const top = groups[0];
  let hint: string | null = null;
  if (top && top.label !== "?" && top.runners.length > 0 && top.runners.every((runner) => runner.busy || !runner.online)) {
    const idle = snapshot.runners.filter((runner) => runner.online && !runner.busy && !runner.labels.includes(top.label));
    if (idle.length > 0) {
      hint = `${top.count === 1 ? "O job na fila exige" : `Os ${top.count} jobs na fila exigem`} o label ${top.label}; os runners ociosos não pegam esses jobs.`;
    }
  }
  return { waiting, line: queueSummary(snapshot), hint };
}

export function runnerState(runner: Runner): { label: string; tone: Tone } {
  if (!runner.online) return { label: "offline", tone: "bad" };
  return runner.busy ? { label: "ocupado", tone: "warn" } : { label: "ocioso", tone: "mut" };
}

export function sessionLabel(session: Session): string {
  return `${session.harness === "opencode" ? "OpenCode" : "Paseo"} · ${session.host}`;
}

/** Release column of tables: `#171 27/10 11:24`, the same name as every other surface. */
export function releaseColumn(release: Release): string {
  return releaseLabel(release);
}

/** Runs the watch judged (published or tried to): cancelled and no-op runs are noise here. */
export function recentVerdicts(snapshot: ReleaseSnapshot, except: Release | null): Release[] {
  return snapshot.releases.filter(
    (release) => !isActive(release) && release.verdict !== "cancelled" && release.verdict !== "none" && release.runId !== except?.runId,
  );
}

/** Cancelled runs among the recent ones (superseded by a newer push). */
export function cancelledCount(snapshot: ReleaseSnapshot): number {
  return snapshot.releases.filter((release) => release.verdict === "cancelled").length;
}

/** Other runs in flight besides the one in focus, e.g. the next push waiting on the group. */
export function otherActive(snapshot: ReleaseSnapshot, release: Release): Release[] {
  return activeReleases(snapshot).filter((other) => other.runId !== release.runId);
}

/** Watch reversals among the recent runs. */
export function reversals(snapshot: ReleaseSnapshot): Release[] {
  return snapshot.releases.filter((release) => release.verdict === "reverted");
}

/** Last error of the service or of the GitHub reads, pt-BR. */
export function snapshotError(envelope: { error: string | null; snapshot: ReleaseSnapshot | null } | null): string | null {
  return envelope?.error ?? envelope?.snapshot?.error ?? null;
}

const PROBLEM = new Set(["failed", "reverted", "red"]);

export interface BadgeState {
  readonly count: number;
  /** Changes whenever there is something new to look at; stored as "seen" when the panel opens. */
  readonly signature: string;
}

/**
 * Rail badge: the number of active runs, or 1 when the last verdict failed, went red or was
 * reverted. The host badge is number-only, so a problem is a 1.
 */
export function badgeState(snapshot: ReleaseSnapshot): BadgeState {
  const active = activeReleases(snapshot);
  const last = lastFinished(snapshot);
  const problem = last && last.verdict && PROBLEM.has(last.verdict) ? last : null;
  const signature = [...active.map((release) => `a${release.runId}`), problem ? `p${problem.runId}:${problem.verdict}` : ""]
    .filter(Boolean)
    .join(",");
  return { count: active.length > 0 ? active.length : problem ? 1 : 0, signature };
}

/** Badge to show given what the user already saw in the panel. */
export function visibleBadge(state: BadgeState, seen: string | null): number {
  if (state.count === 0 || state.signature === "") return 0;
  return state.signature === seen ? 0 : state.count;
}

export interface Chip {
  readonly providerId: string;
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly data: { readonly number: number; readonly runId: number };
}

/**
 * Composer chip for `/release`: the host draws `id` then `title`, so together they read as the
 * release name plus the headline (`#182` + `28/10 14:49 · imagens 3/9`); the full status goes to
 * the model as `text`.
 */
export function releaseChip(snapshot: ReleaseSnapshot | null, release: Release, now: Date): Chip {
  const queue = snapshot && isActive(release) ? queueView(snapshot) : null;
  const stamp = releaseStamp(release.startedAt ?? release.createdAt);
  const title = (stamp ? `${stamp} · ${headline(release)}` : headline(release)).slice(0, 200);
  const lines: string[] = [
    `Release ${releaseLabel(release)} do repositório ${snapshot?.repository ?? "dboltbr/dbolt"} (workflow release, run ${release.runId}, tentativa ${release.attempt}).`,
    `Commit ${shortSha(release.headSha)}: ${release.title || "(sem título)"}.`,
    `Status: ${statusLabel(release)}${release.conclusion ? ` (conclusão ${release.conclusion})` : ""}; duração ${elapsedLabel(release, now) || "?"}.`,
  ];
  if (!isActive(release)) lines.push(`Veredito do vigia: ${verdictDetail(release)}.`);
  lines.push(
    "Etapas:",
    ...release.steps.map((step) => {
      const duration = stepDuration(step, now);
      const failed = step.failedJob ? `, falhou em ${step.failedJob}` : "";
      return `- ${stepLabel(step)}: ${step.state}${duration ? ` (${duration})` : ""}${failed}`;
    }),
  );
  if (queue?.line) lines.push(`Fila: ${queue.line}.`);
  if (queue?.hint) lines.push(queue.hint);
  if (release.failedJob) lines.push(`Job que falhou: ${release.failedJob.name}${release.failedJob.url ? ` (${release.failedJob.url})` : ""}.`);
  if (release.revert) lines.push(`Reversão do vigia: ${release.revert.commits.join(", ") || "faixa"}${release.revert.commit ? ` no commit ${shortSha(release.revert.commit)}` : ""}.`);
  if (release.signals.length > 0) {
    lines.push("Sinais do vigia:");
    for (const signal of release.signals) lines.push(`- ${signal.label} (${signal.source}): ${signal.outcome}${signal.reason ? `, ${signal.reason}` : ""}`);
  }
  if (release.sessions.length > 0) lines.push(`Sessões de agente: ${release.sessions.map((s) => `${s.harness}/${s.host}/${s.id}`).join(", ")}.`);
  lines.push(`Run: ${release.url}`);
  return {
    providerId: PANEL_ID,
    id: `#${release.number}`,
    title,
    url: release.url,
    text: lines.join("\n").slice(0, 16_000),
    data: { number: release.number, runId: release.runId },
  };
}

/** `/release`, `/release 172` or `/release release-172` → the number, or null for "current". */
export function parseReleaseArgs(args: string): number | null | "invalid" {
  const trimmed = args.trim();
  if (trimmed === "") return null;
  const match = /^(?:release-)?(\d{1,7})$/i.exec(trimmed);
  return match ? Number(match[1]) : "invalid";
}

export { findRelease };
