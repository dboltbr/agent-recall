// DOM pieces shared by the panel, the page and the status strip.
import {
  displayName,
  formatAgo,
  formatDuration,
  imageJobs,
  isActive,
  progress,
  STEP_LABELS,
  stepLabel,
  trippedSignals,
  type Job,
  type Release,
  type ReleaseSnapshot,
  type Step,
} from "../../../core/release-status.ts";
import { h, icon, ring, spinner, type IconName } from "./dom.ts";
import {
  elapsedLabel,
  headline,
  jobTone,
  queueView,
  releaseColumn,
  releaseTone,
  revertParts,
  runnerState,
  sessionLabel,
  shortSha,
  statusLabel,
  stepDetail,
  stepDuration,
  stepFraction,
  stepTone,
  type Tone,
} from "./view.ts";

export interface Actions {
  openUrl(url: string | null | undefined): void;
  openCommit(sha: string): void;
}

const VERDICT_ICON: Record<Tone, IconName | null> = { ok: "check", warn: "undo", bad: "x", mut: "minus", run: null };

export function pill(release: Release): HTMLElement {
  const tone = releaseTone(release);
  const glyph = VERDICT_ICON[tone];
  return h("span", { class: `badge b-${tone}` }, tone === "run" ? spinner(10) : glyph ? icon(glyph, 10, "", 2.6) : null, statusLabel(release));
}

export function segBar(release: Release): HTMLElement {
  const bar = h("span", { class: "seg", title: release.steps.map((step) => `${stepLabel(step)}: ${step.state}`).join(" · ") });
  for (const step of release.steps) {
    const cell = h("i");
    if (step.state === "done" || step.state === "skipped") cell.className = "ok";
    else if (step.state === "failed") cell.className = "bad";
    else if (step.state === "running") {
      cell.className = "cur";
      cell.style.setProperty("--p", `${Math.round(stepFraction(step) * 100)}%`);
    }
    if (step.id === "watch" && release.verdict === "reverted") cell.className = "warn";
    if (step.id === "watch" && release.verdict === "red") cell.className = "bad";
    bar.append(cell);
  }
  return bar;
}

export function releaseRing(release: Release, size: number): SVGSVGElement {
  return ring(progress(release), size, releaseTone(release));
}

export function releaseHead(release: Release, now: Date): HTMLElement {
  return h(
    "div",
    { class: "rl-head" },
    releaseRing(release, 18),
    h("span", { class: "t" }, displayName(release)),
    pill(release),
    h("span", { class: "sp" }),
    h("span", { class: "s" }, elapsedLabel(release, now)),
  );
}

export function commitLines(release: Release, now: Date, actions: Actions): HTMLElement[] {
  const lines = [
    h(
      "div",
      { class: "rl-commit" },
      h("button", { class: "link sha", title: "ver commit", onClick: () => actions.openCommit(release.headSha) }, shortSha(release.headSha)),
      h("span", { class: "ellipsis" }, release.title || "(sem título)"),
    ),
  ];
  const session = release.pusher ?? release.sessions[0] ?? null;
  if (session) {
    lines.push(
      h(
        "div",
        { class: "rl-commit" },
        icon("bot", 13),
        h("span", { class: "ellipsis" }, `push da sessão ${sessionLabel(session)} · ${formatAgo(release.createdAt, now)}`),
      ),
    );
  }
  return lines;
}

function stepIcon(step: Step): Node {
  switch (step.state) {
    case "done":
      return icon("checkCircle", 15, "t-ok");
    case "failed":
      return icon("xCircle", 15, "t-bad");
    case "cancelled":
      return icon("xCircle", 15, "t-mut");
    case "running":
      return spinner(15);
    case "skipped":
      return icon("minus", 15, "t-mut");
    default:
      return h("span", { class: "pend-dot" });
  }
}

function imageChip(job: Job): HTMLElement {
  const name = job.image ?? job.name;
  switch (job.state) {
    case "success":
      return h("span", { class: "chip" }, icon("check", 11, "t-ok", 2.5), name);
    case "failure":
      return h("span", { class: "chip x" }, icon("x", 11, "t-bad", 2.5), name);
    case "cancelled":
      return h("span", { class: "chip q" }, icon("x", 11, "t-mut", 2.5), name);
    case "running":
      return h("span", { class: "chip b" }, spinner(11), name);
    default:
      return h("span", { class: "chip q" }, name);
  }
}

function imageChips(release: Release): HTMLElement | null {
  const jobs = imageJobs(release);
  if (jobs.length === 0) return null;
  const started = jobs.filter((job) => job.state !== "queued");
  const queued = jobs.filter((job) => job.state === "queued");
  const box = h("div", { class: "rl-imgs" }, ...started.map(imageChip));
  if (queued.length > 0) box.append(h("span", { class: "chip q", title: queued.map((job) => job.image ?? job.name).join(", ") }, `+${queued.length} na fila`));
  return box;
}

export function stepsList(snapshot: ReleaseSnapshot, release: Release, now: Date): HTMLElement {
  const list = h("div", { class: "rl-steps" });
  const queue = queueView(snapshot);
  for (const step of release.steps) {
    const detail = h("div", { class: "sd" });
    const text = stepDetail(release, step);
    if (step.id === "tag") detail.append(h("span", { class: "mono" }, text));
    else if (text) detail.append(text);
    if (step.id === "images" && step.state !== "pending" && step.state !== "skipped") {
      const chips = imageChips(release);
      if (chips) detail.append(chips);
      if (step.state === "running" && queue.line) detail.append(h("div", { class: "note tx-warn" }, icon("clock", 12), queue.line));
    }
    if (step.failedJob) detail.append(h("div", { class: "note tx-bad" }, icon("x", 12), `${step.failedJob} falhou`));
    const name = h("div", { class: "sn" }, STEP_LABELS[step.id]);
    if (step.total !== null && step.total > 0) name.append(" ", h("span", { class: "n" }, `${step.done ?? 0}/${step.total}`));
    list.append(
      h(
        "div",
        { class: `rl-step ${step.state}` },
        h("span", { class: "si" }, stepIcon(step)),
        h("div", null, name, detail.childNodes.length > 0 ? detail : null),
        h("span", { class: "st" }, stepDuration(step, now)),
      ),
    );
  }
  return list;
}

export function outcomeBanner(release: Release, actions: Actions): HTMLElement | null {
  if (release.verdict === "reverted") {
    const parts = revertParts(release);
    const revertCommit = release.revert?.commit ?? null;
    return h(
      "div",
      { class: "rl-banner warn" },
      icon("undo", 14),
      h("span", null, parts ? [parts.what, parts.notice].filter(Boolean).join(" · ") : headline(release)),
      revertCommit ? h("button", { class: "link", onClick: () => actions.openCommit(revertCommit) }, "ver reversão") : null,
    );
  }
  if (release.verdict === "failed") {
    const url = release.failedJob?.url ?? release.url;
    return h("div", { class: "rl-banner bad" }, icon("xCircle", 14), h("span", null, headline(release)), h("button", { class: "link", onClick: () => actions.openUrl(url) }, "ver log"));
  }
  if (release.verdict === "red") {
    return h("div", { class: "rl-banner bad" }, icon("alert", 14), h("span", null, `${headline(release)} · investigação em andamento`));
  }
  return null;
}

export function signalsList(release: Release): HTMLElement | null {
  if (release.signals.length === 0) return null;
  const tripped = new Set(trippedSignals(release));
  return h(
    "div",
    null,
    ...release.signals.map((signal) =>
      h(
        "div",
        { class: "sig" },
        tripped.has(signal) ? icon("alert", 13, "t-warn") : icon("check", 13, signal.outcome === "green" ? "t-ok" : "t-mut", 2.5),
        h("span", { class: "ellipsis", title: signal.reason ?? "" }, h("b", null, signal.label), signal.reason ? ` · ${signal.reason}` : ""),
        h("span", null, signal.outcome),
      ),
    ),
  );
}

export function runnersList(snapshot: ReleaseSnapshot): HTMLElement {
  if (snapshot.runners.length === 0) return h("div", { class: "empty" }, "Sem acesso à lista de runners.");
  return h(
    "div",
    { class: "rq" },
    ...snapshot.runners.map((runner) => {
      const state = runnerState(runner);
      return h(
        "div",
        { class: "rq-r", title: runner.job ?? runner.labels.join(", ") },
        icon("server", 13),
        h("span", { class: "n" }, runner.name),
        runner.job ? h("span", { class: "muted ellipsis" }, runner.job) : null,
        h("span", { class: `badge b b-${state.tone}` }, state.label),
      );
    }),
  );
}

export function verdictRows(releases: readonly Release[], onSelect: (release: Release) => void): HTMLElement {
  if (releases.length === 0) return h("div", { class: "empty" }, "Nenhum veredito entre as runs recentes.");
  return h(
    "div",
    { class: "rq" },
    ...releases.map((release) =>
      h(
        "div",
        { class: "rq-r clickable", title: release.title, onClick: () => onSelect(release) },
        h("span", { class: "n", style: "width:86px" }, releaseColumn(release)),
        h("span", { class: `ellipsis ${toneText(release)}`, style: "flex:1" }, headline(release)),
        pill(release),
      ),
    ),
  );
}

/** Text tone of a verdict line. */
export function toneText(release: Release): string {
  const tone = releaseTone(release);
  return tone === "warn" ? "tx-warn" : tone === "bad" ? "tx-bad" : "muted";
}

export function pipeline(release: Release, now: Date): HTMLElement {
  const pipe = h("div", { class: "pipe" });
  for (const step of release.steps) {
    const tone = stepTone(step);
    const cls = tone === "ok" ? "ok" : tone === "run" ? "cur" : tone === "bad" ? "bad" : "pend";
    const glyph = tone === "ok" ? icon("check", 10, "", 3) : tone === "bad" ? icon("x", 10, "", 3) : h("span", { class: "dot" });
    const meta: string[] = [];
    if (step.total !== null && step.total > 0) meta.push(`${step.done ?? 0}/${step.total}`);
    const duration = step.state === "pending" ? "" : stepDuration(step, now);
    if (duration) meta.push(duration);
    if (step.state === "skipped") meta.push("pulada");
    if (step.id === "tag" && meta.length === 0) meta.push(release.tag ?? release.name);
    pipe.append(
      h(
        "div",
        { class: `pn ${cls}` },
        h("span", { class: "pd" }, glyph),
        h("div", { class: "pl" }, STEP_LABELS[step.id]),
        h("div", { class: "pm" }, meta.join(" · ")),
      ),
    );
  }
  return pipe;
}

/** Gantt-like lanes of the image builds. */
export function lanes(release: Release, now: Date): HTMLElement | null {
  const jobs = imageJobs(release);
  if (jobs.length === 0) return null;
  const startOf = (job: Job) => (job.state === "queued" || !job.startedAt ? null : Date.parse(job.startedAt));
  const starts = jobs.map(startOf).filter((ms): ms is number => ms !== null);
  const origin = starts.length > 0 ? Math.min(...starts) : now.getTime();
  const endOf = (job: Job) => (job.completedAt ? Date.parse(job.completedAt) : now.getTime());
  // The span ends with the last image (or now while one still runs): the release staying active
  // through deploy and the watch must not shrink finished lanes to slivers.
  const span = Math.max(60_000, Math.max(...jobs.map(endOf)) - origin);
  const queuedLeft = Math.min(92, ((now.getTime() - origin) / span) * 100);
  return h(
    "div",
    { class: "lanes" },
    ...jobs.map((job) => {
      const start = startOf(job);
      const bar = h("b");
      let label = "";
      let glyph: Node;
      if (start === null) {
        bar.className = "q";
        bar.style.left = `${Math.max(0, queuedLeft - 8)}%`;
        bar.style.width = "8%";
        label = "na fila";
        glyph = h("span", { class: "pend-dot", style: "width:8px;height:8px" });
      } else {
        const tone = jobTone(job);
        const end = endOf(job);
        bar.className = tone === "ok" ? "ok" : tone === "bad" ? "bad" : tone === "run" ? "run" : "q";
        bar.style.left = `${((start - origin) / span) * 100}%`;
        bar.style.width = `${Math.max(1, ((end - start) / span) * 100)}%`;
        label = formatDuration(end - start);
        glyph = tone === "ok" ? icon("check", 11, "t-ok", 2.6) : tone === "bad" ? icon("x", 11, "t-bad", 2.6) : tone === "run" ? spinner(11) : icon("x", 11, "t-mut", 2.6);
      }
      const name = job.image ?? job.name;
      return h(
        "div",
        { class: "lane", title: job.runner ? `${name} · ${job.runner}` : name },
        h("span", { class: "ln" }, glyph, h("span", null, name)),
        h("span", { class: "lt" }, bar),
        h("span", { class: "ld" }, label),
      );
    }),
  );
}
