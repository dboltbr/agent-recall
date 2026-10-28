// pt-BR copy and layout numbers of the release surfaces (popover, timeline card, Releases screen),
// derived from the snapshot. Pure and runtime-neutral: the Paseo client (`shared/release-copy.ts`)
// and the OpenChamber extension read the same strings.
import {
  formatAgo,
  formatDuration,
  formatShortDuration,
  HANDOFF_LABELS,
  imageJobs,
  isActive,
  queueGroups,
  revertSummary,
  STEP_LABELS,
  stepJobNames,
  VERDICT_LABELS,
  type HandoffRole,
  type Job,
  type Release,
  type ReleaseSnapshot,
  type Runner,
  type Session,
  type Signal,
  type Step,
} from "./release-status.ts";

export type Tone = "ok" | "bad" | "warn" | "run" | "muted";

export const RELEASE_ACTIONS_URL = (repository: string) => `https://github.com/${repository}/actions/workflows/release.yml`;
export const commitUrl = (repository: string, sha: string) => `https://github.com/${repository}/commit/${sha}`;
export const shortSha = (sha: string) => sha.slice(0, 9);

/** Header badge: `em andamento`, `verde`, `revertido`, … */
export function releaseBadge(release: Release): { label: string; tone: Tone } {
  if (release.status === "queued") return { label: "na fila", tone: "muted" };
  if (isActive(release)) return { label: "em andamento", tone: "run" };
  switch (release.verdict) {
    case "green":
      return { label: VERDICT_LABELS.green, tone: "ok" };
    case "reverted":
      return { label: VERDICT_LABELS.reverted, tone: "warn" };
    case "red":
    case "failed":
      return { label: VERDICT_LABELS[release.verdict], tone: "bad" };
    case null:
      return { label: "concluído", tone: "muted" };
    default:
      return { label: VERDICT_LABELS[release.verdict], tone: "muted" };
  }
}

export function stepTone(state: Step["state"]): Tone {
  if (state === "done") return "ok";
  if (state === "failed") return "bad";
  if (state === "running") return "run";
  return "muted";
}

/** Tone of the watch step once the verdict is in (the vigia node of the pipe). */
export function watchTone(release: Release): Tone | null {
  if (release.verdict === "reverted") return "warn";
  if (release.verdict === "red") return "bad";
  return null;
}

/** `push do agente Paseo “Aviso ao morador: push” · há 36 min`, or null without a trailer. */
export function pusherLine(release: Release, title: string | null, now: Date): string | null {
  const pusher = release.pusher;
  if (!pusher) return null;
  const who =
    pusher.harness === "paseo"
      ? title
        ? `push do agente Paseo “${title}”`
        : `push do agente Paseo ${pusher.id.slice(0, 8)}`
      : title
        ? `push da sessão OpenCode “${title}”`
        : `push da sessão OpenCode · ${pusher.host}`;
  const ago = formatAgo(release.createdAt, now);
  return ago ? `${who} · ${ago}` : who;
}

export type WatchKind = "push" | HandoffRole;

/** A session the vigia step links to, with every reason it is there. */
export interface WatchSession {
  readonly session: Session;
  readonly kinds: readonly WatchKind[];
}

/**
 * Sessions behind the vigia step: the pusher first, then where the incident went (handoffs, in
 * snapshot order). One entry per session; the host decides which ones it can open.
 */
export function watchSessions(release: Release): WatchSession[] {
  const out: { session: Session; kinds: WatchKind[] }[] = [];
  const add = (session: Session, kind: WatchKind) => {
    const known = out.find(
      (entry) => entry.session.harness === session.harness && entry.session.host === session.host && entry.session.id === session.id,
    );
    if (!known) out.push({ session, kinds: [kind] });
    else if (!known.kinds.includes(kind)) known.kinds.push(kind);
  };
  if (release.pusher) add(release.pusher, "push");
  for (const handoff of release.handoffs) add(handoff.session, handoff.role);
  return out;
}

/** `push · “Aviso ao morador”`, `investigação + correção · agente 1a2b3c4d`. */
export function watchSessionLabel(entry: WatchSession, title: string | null): string {
  const kinds = entry.kinds.map((kind) => (kind === "push" ? "push" : HANDOFF_LABELS[kind])).join(" + ");
  const { session } = entry;
  const who = title ? `“${title}”` : session.harness === "paseo" ? `agente ${session.id.slice(0, 8)}` : `sessão ${session.id.slice(0, 12)}`;
  return `${kinds} · ${who}`;
}

/** Step duration: frozen once finished, ticking from `startedAt` while running. */
export function stepDurationMs(step: Step, now: Date): number | null {
  if (step.state === "running" && step.startedAt) {
    const start = Date.parse(step.startedAt);
    return Number.isNaN(start) ? step.durationMs : Math.max(0, now.getTime() - start);
  }
  return step.state === "pending" || step.state === "skipped" ? null : step.durationMs;
}

function jobShortName(name: string): string {
  const at = name.indexOf(" / ");
  return at < 0 ? name : name.slice(at + 3);
}

/** Second line of a step in the vertical list (images draw chips instead). */
export function stepDetail(release: Release, step: Step): string {
  const names = stepJobNames(release, step.id);
  switch (step.id) {
    case "verify":
      return names.length ? names.join(" · ") : "check · qlty · opengrep · secrets";
    case "images":
      return step.state === "skipped" ? "nada a publicar" : "";
    case "deploy":
      if (step.state === "failed" && step.failedJob) return `${step.failedJob} falhou`;
      return names.length ? names.join(" · ") : "produção";
    case "tag":
      return release.tag ?? release.name;
    case "watch":
      if (!isActive(release) && release.verdict === "reverted") return revertSummary(release) ?? "";
      if (!isActive(release) && release.verdict === "green") return "sem regressão";
      return "sinais do blast radius → veredito";
  }
}

/** The small line under each node of the horizontal pipe. */
export function pipeMeta(release: Release, step: Step, now: Date): string {
  const failedRun = !isActive(release) && release.steps.some((other) => other.state === "failed");
  const duration = stepDurationMs(step, now);
  const short = formatShortDuration(duration);
  if (step.state === "failed") return step.failedJob ? `${jobShortName(step.failedJob)} falhou` : "falhou";
  if (failedRun && (step.state === "pending" || step.state === "skipped" || step.state === "cancelled")) return "—";
  switch (step.id) {
    case "images":
      if (step.total === null || step.total === 0) return step.state === "skipped" ? "—" : "";
      return short ? `${step.done ?? 0}/${step.total} · ${short}` : `${step.done ?? 0}/${step.total}`;
    case "tag":
      return release.tag ?? release.name;
    case "watch":
      if (!isActive(release) && release.verdict) return VERDICT_LABELS[release.verdict];
      return step.state === "running" ? short : "";
    default:
      if (step.state === "pending") return "";
      return isActive(release) ? formatDuration(duration) : short;
  }
}

export interface ImageChip {
  readonly name: string;
  readonly state: Job["state"];
}

/** Image chips: published, building and failed ones in job order, then the queue count. */
export function imageChips(release: Release, limit = 4): { chips: ImageChip[]; hidden: number; queued: number } {
  const jobs = imageJobs(release);
  const started = jobs.filter((job) => job.state !== "queued");
  // The newest chips are the interesting ones: keep the building/failed ones, then the latest done.
  const shown = started.length <= limit ? started : started.slice(started.length - limit);
  return {
    chips: shown.map((job) => ({ name: job.image ?? job.name, state: job.state })),
    hidden: started.length - shown.length,
    queued: jobs.length - started.length,
  };
}

export interface Lane {
  readonly name: string;
  readonly state: Job["state"];
  /** Bar position in percent of the images span. */
  readonly left: number;
  readonly width: number;
  readonly label: string;
}

/** Image lanes of the Releases screen: one bar per build-push job on the images time axis. */
export function imageLanes(release: Release, now: Date): Lane[] {
  const jobs = imageJobs(release);
  const span = (job: Job): [number, number] | null => {
    if (job.state === "queued" || !job.startedAt) return null;
    const start = Date.parse(job.startedAt);
    const end = job.completedAt ? Date.parse(job.completedAt) : now.getTime();
    return Number.isNaN(start) ? null : [start, Math.max(start, end)];
  };
  const spans = jobs.map(span).filter((value): value is [number, number] => value !== null);
  const from = spans.length ? Math.min(...spans.map(([start]) => start)) : now.getTime();
  // The axis runs to now only while an image is still building or waiting; once all ended it
  // stops at the last one, so finished lanes keep their proportions.
  const open = jobs.some((job) => job.state === "queued" || job.state === "running");
  const to = Math.max(open ? now.getTime() : from, ...spans.map(([, end]) => end), from + 60_000);
  const total = to - from;
  const latestStart = spans.length ? Math.max(...spans.map(([start]) => start)) : from;
  const queuedLeft = Math.min(88, ((latestStart - from) / total) * 100);
  return jobs.map((job) => {
    const range = span(job);
    if (!range) return { name: job.image ?? job.name, state: job.state, left: queuedLeft, width: 12, label: "na fila" };
    const left = ((range[0] - from) / total) * 100;
    const width = Math.max(2, ((range[1] - range[0]) / total) * 100);
    return {
      name: job.image ?? job.name,
      state: job.state,
      left,
      width: Math.min(width, 100 - left),
      label: job.state === "failure" ? "falhou" : formatDuration(range[1] - range[0]),
    };
  });
}

export interface RunnerRow {
  readonly name: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: Tone;
}

/** One row per self-hosted runner: the release job it runs, and ocupado/ocioso/offline. */
export function runnerRows(runners: readonly Runner[]): RunnerRow[] {
  return runners.map((runner) => ({
    name: runner.name,
    detail: runner.job ? jobShortName(runner.job) : runner.busy ? "outro job" : "",
    status: !runner.online ? "offline" : runner.busy ? "ocupado" : "ocioso",
    tone: !runner.online ? "bad" : runner.busy ? "warn" : "muted",
  }));
}

/** `6 jobs aguardando`, or null with an empty queue. */
export function waitingLabel(snapshot: ReleaseSnapshot): string | null {
  const count = snapshot.queued.length;
  return count === 0 ? null : count === 1 ? "1 job aguardando" : `${count} jobs aguardando`;
}

/** Why the queue does not drain: the waiting jobs need a busy label the idle runners lack. */
export function queueHint(snapshot: ReleaseSnapshot): string | null {
  const top = queueGroups(snapshot)[0];
  if (!top || !top.runners.length || top.runners.some((runner) => runner.online && !runner.busy)) return null;
  const idle = snapshot.runners.some((runner) => runner.online && !runner.busy && !runner.labels.includes(top.label));
  if (!idle) return null;
  const jobs = top.count === 1 ? "O job restante exige" : `Os ${top.count} jobs restantes exigem`;
  return `${jobs} o label ${top.label}; os runners ociosos não pegam esses jobs.`;
}

/** Releases of the verdict table: finished ones with a word from the vigia (or a failure). */
export function verdictRows(snapshot: ReleaseSnapshot, limit = 5): Release[] {
  return snapshot.releases
    .filter((release) => !isActive(release) && release.verdict !== null && release.verdict !== "none" && release.verdict !== "cancelled")
    .slice(0, limit);
}

/** Reverted releases of the loaded history, newest first. */
export function revertRows(snapshot: ReleaseSnapshot): Release[] {
  return snapshot.releases.filter((release) => release.verdict === "reverted");
}

/** `5xx · errors5xx-ratio` for one tripped signal. */
export function signalText(signal: Signal): string {
  return signal.reason ? `${signal.label} · ${signal.reason}` : signal.label;
}

export function signalOutcome(signal: Signal): { label: string; tone: Tone } {
  if (signal.outcome === "red") return { label: "acima", tone: "bad" };
  if (signal.outcome === "green") return { label: "ok", tone: "ok" };
  if (signal.outcome === "not-applicable") return { label: "n/a", tone: "muted" };
  return { label: signal.outcome === "pending" ? "pendente" : signal.outcome, tone: "muted" };
}

/** The "sinais" cell of the verdict table: what the vigia saw, in the verdict's tone. */
export function verdictSignals(release: Release): { text: string; tone: Tone } {
  switch (release.verdict) {
    case "reverted":
      return { text: revertSummary(release) ?? "vigia reverteu", tone: "warn" };
    case "failed":
      return { text: release.failedJob ? `${release.failedJob.name} falhou` : "o run falhou", tone: "bad" };
    case "red": {
      const tripped = release.signals.filter((signal) => signal.outcome === "red").map(signalText);
      return { text: tripped.length ? tripped.join(" · ") : "vigia vermelho", tone: "bad" };
    }
    case "green": {
      const judged = release.signals.filter((signal) => signal.outcome === "green" || signal.outcome === "red");
      const ok = judged.filter((signal) => signal.outcome === "green").length;
      return { text: judged.length ? `${ok}/${judged.length} sinais ok` : "sem regressão", tone: "muted" };
    }
    case "inconclusive": {
      const reasons = release.signals.map((signal) => signal.reason).filter((reason): reason is string => !!reason);
      return { text: reasons.length ? [...new Set(reasons)].join(" · ") : "sem veredito", tone: "muted" };
    }
    default:
      return { text: "", tone: "muted" };
  }
}

/** The finished card's banner: tone, text and which link it carries. */
export function verdictBanner(release: Release): { tone: Tone; text: string; link: "log" | "signals" | null } | null {
  if (isActive(release)) return null;
  switch (release.verdict) {
    case "green":
      return { tone: "ok", text: "vigia: sem regressão", link: "signals" };
    case "reverted":
      return { tone: "warn", text: revertSummary(release) ?? "vigia reverteu", link: "signals" };
    case "red": {
      const tripped = release.signals.filter((signal) => signal.outcome === "red").map((signal) => signal.label);
      return { tone: "bad", text: tripped.length ? `vigia vermelho · ${tripped.join(", ")}` : "vigia vermelho", link: "signals" };
    }
    case "failed":
      return { tone: "bad", text: release.failedJob ? `${release.failedJob.name} falhou` : "o run falhou", link: "log" };
    case "inconclusive":
      return { tone: "muted", text: "vigia sem veredito", link: "signals" };
    case "cancelled":
      return { tone: "muted", text: "cancelado (substituído por um push mais novo)", link: null };
    default:
      return null;
  }
}

/** The watch job's page: where its signals are logged. */
export function watchUrl(release: Release): string | null {
  return release.jobs.find((job) => job.step === "watch" && job.url)?.url ?? null;
}

/** Steps in pipe order with their label (the five of STEP_IDS). */
export function stepLabelOf(step: Step): string {
  return STEP_LABELS[step.id];
}

/** Age line of the snapshot: `atualizado há 2 min`, with the refresh failure when there is one. */
export function freshness(snapshot: ReleaseSnapshot, now: Date): { text: string; stale: boolean } {
  const ago = formatAgo(snapshot.fetchedAt, now);
  const age = Date.parse(snapshot.fetchedAt);
  const stale = snapshot.error !== null || (!Number.isNaN(age) && now.getTime() - age > 10 * 60_000);
  if (snapshot.error) return { text: `GitHub indisponível (${snapshot.error}) · dados de ${ago}`, stale };
  return { text: ago === "agora" ? "atualizado agora" : `atualizado ${ago}`, stale };
}
