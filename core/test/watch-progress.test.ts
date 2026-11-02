import assert from "node:assert/strict";
import { test } from "node:test";
import { liveSources, pipeMeta, signalOutcome, stepDetail } from "../release-copy.ts";
import {
  activityLabel,
  buildRelease,
  buildSnapshot,
  parseWatchProgress,
  pillLabel,
  ReleaseSchema,
  stepOf,
  watchPhaseLabel,
  type GitHubCheckRun,
  type Release,
  type WatchProgress,
} from "../release-status.ts";
import { NOW } from "./fakes.ts";
import { released, run, watchRun } from "./releases.ts";

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

/** A check run as release_watch_check.py publishes it: the snapshot in a fenced JSON block. */
function checkRun(view: Record<string, unknown>, id = 1): GitHubCheckRun {
  const text = "```json\n" + JSON.stringify({ schema: 1, scope: "deployment", outcome: "pending", ...view }) + "\n```";
  return { id, external_id: "40000000172:1", output: { text } };
}

/** Release 172 with its watch run open and the given progress. */
function watching(progress: WatchProgress | null): Release {
  return buildRelease({
    run: run({ run_number: 172, status: "completed", conclusion: "success" }),
    jobs: released("success", 172).jobs,
    watch: watchRun(172, "running"),
    progress,
    note: null,
    commits: null,
    now: NOW,
  });
}

const OBSERVING = parseWatchProgress(
  checkRun({
    phase: "observing",
    verdict: "pending",
    windowEndsAt: later(7).toISOString(),
    deadline: later(20).toISOString(),
    sources: [
      { name: "sentry", outcome: "pending", reason: "sentry-window-open", issues: 1 },
      { name: "deployment", outcome: "green", reason: "deployment-converged" },
      { name: "signal:telemetry/api-issues", outcome: "red", reason: "threshold" },
      { name: "errors5xx", outcome: "not-applicable", reason: "low-traffic" },
    ],
  }),
)!;

test("parseWatchProgress: o retrato do check run, fontes vermelhas primeiro, com rótulo e issues", () => {
  assert.equal(OBSERVING.phase, "observing");
  assert.equal(OBSERVING.verdict, "pending");
  assert.equal(OBSERVING.windowEndsAt, later(7).toISOString());
  assert.deepEqual(OBSERVING.sources, [
    { source: "signal:telemetry/api-issues", label: "sinal telemetry/api-issues", outcome: "red", reason: "threshold" },
    { source: "sentry", label: "Sentry", outcome: "pending", reason: "sentry-window-open · 1 issue nova" },
    { source: "deployment", label: "implantação", outcome: "green", reason: "deployment-converged" },
    { source: "errors5xx", label: "5xx", outcome: "not-applicable", reason: "low-traffic" },
  ]);
});

test("parseWatchProgress: sem bloco, JSON quebrado ou schema desconhecido não é progresso", () => {
  assert.equal(parseWatchProgress({ id: 1, output: { text: null } }), null);
  assert.equal(parseWatchProgress({ id: 1, output: { text: "```json\n{nope\n```" } }), null);
  assert.equal(parseWatchProgress({ id: 1, output: { text: "```json\n" + JSON.stringify({ schema: 2, phase: "done", sources: [] }) + "\n```" } }), null);
  const started = parseWatchProgress(checkRun({ phase: "deploying", sources: [] }))!;
  assert.deepEqual(started, { phase: "deploying", verdict: null, windowEndsAt: null, deadline: null, sources: [] });
});

test("fase do vigia: implantando, observando com contagem regressiva, janela fechada, veredito", () => {
  const deploying = watching(parseWatchProgress(checkRun({ phase: "deploying", sources: [] })));
  assert.equal(watchPhaseLabel(deploying, NOW), "implantando");
  const observing = watching(OBSERVING);
  assert.equal(watchPhaseLabel(observing, NOW), "observando · faltam 7m");
  assert.equal(watchPhaseLabel(observing, NOW, true), "faltam 7m");
  assert.equal(watchPhaseLabel(observing, later(6.5)), "observando · faltam 30s");
  assert.equal(watchPhaseLabel(observing, later(8)), "observando · janela fechada");
  assert.equal(watchPhaseLabel(observing, later(8), true), "observando");
  const red = watching({ ...OBSERVING, phase: "done", verdict: "red" });
  assert.equal(watchPhaseLabel(red, NOW), "veredito vermelho", "o run segue aberto respondendo ao vermelho");
  assert.equal(watchPhaseLabel(red, NOW, true), "vermelho");
  assert.equal(watchPhaseLabel(watching(null), NOW), null, "vigia de antes do check run");
});

test("pílula, atividade e etapa do vigia mostram a fase; sem progresso, o texto de antes", () => {
  const release = watching(OBSERVING);
  assert.equal(release.current, "watch");
  assert.equal(pillLabel(release, NOW), "#172 27/10 11:24 · observando · faltam 7m");
  const snapshot = buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases: [release], runners: [], now: NOW });
  assert.equal(activityLabel(snapshot, release, NOW), "observando · faltam 7m");
  const watch = stepOf(release, "watch");
  assert.equal(stepDetail(release, watch, null, NOW), "observando · faltam 7m");
  assert.equal(pipeMeta(release, watch, NOW), "faltam 7m");
  const old = watching(null);
  assert.equal(pillLabel(old, NOW), "#172 27/10 11:24 · vigia");
  assert.equal(activityLabel(snapshot, old, NOW), "vigia aberto");
  assert.equal(stepDetail(old, stepOf(old, "watch"), null, NOW), "sinais do blast radius → veredito");
});

test("fontes ao vivo só com a release aberta; pendente vira medindo, vermelho vira vermelho", () => {
  assert.equal(liveSources(watching(OBSERVING)).length, 4);
  const ended = buildRelease({
    run: run({ run_number: 172, status: "completed", conclusion: "success" }),
    ...released("success", 172),
    progress: OBSERVING,
    note: null,
    commits: null,
    now: NOW,
  });
  assert.equal(ended.status, "completed");
  assert.deepEqual(liveSources(ended), []);
  assert.equal(watchPhaseLabel(ended, NOW), null);
  const [red, pending] = OBSERVING.sources;
  assert.deepEqual(signalOutcome(red!, true), { label: "vermelho", tone: "bad" });
  assert.deepEqual(signalOutcome(pending!, true), { label: "medindo", tone: "run" });
  assert.deepEqual(signalOutcome(red!), { label: "acima", tone: "bad" }, "o cartão do incidente segue igual");
});

test("cartão salvo antes de `progress` ainda passa no schema", () => {
  const { progress: _dropped, ...card } = watching(OBSERVING);
  assert.equal(ReleaseSchema.parse(card).progress, null);
});
