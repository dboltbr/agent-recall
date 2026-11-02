import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  badgeState,
  headline,
  parseReleaseArgs,
  primaryRelease,
  queueView,
  releaseChip,
  releaseColumn,
  revertParts,
  statusLabel,
  stepDetail,
  visibleBadge,
} from "../src/ui/view.ts";
import { buildRelease, stepOf } from "../../core/release-status.ts";
import { released, run, watchRun } from "../../core/test/releases.ts";
import { failed, FIXTURE_NOW, fixtureSnapshot, green, inconclusive, reverted, running, waiting } from "./fixture.ts";

test("primaryRelease: ativo primeiro, depois o último veredito", () => {
  assert.equal(primaryRelease(fixtureSnapshot())?.number, 172);
  assert.equal(primaryRelease(fixtureSnapshot([green, reverted]))?.number, 171);
  assert.equal(primaryRelease(fixtureSnapshot([])), null);
  assert.equal(primaryRelease(fixtureSnapshot([waiting, running, green]))?.number, 172, "a run que anda vence a da fila");
  assert.equal(primaryRelease(fixtureSnapshot([waiting, green]))?.number, 173);
  assert.equal(statusLabel(waiting), "na fila");
});

test("headline e statusLabel: etapa em curso enquanto ativo, veredito depois", () => {
  assert.equal(headline(running), "imagens 3/9");
  assert.equal(statusLabel(running), "em andamento");
  assert.equal(headline(failed), "verify-production / check falhou");
  assert.deepEqual(revertParts(reverted), { what: "vigia reverteu no dbolt-deploy · main congelada", notice: "dona ses_culp" });
  assert.equal(revertParts(green), null);
  assert.equal(releaseColumn(failed), "#169 27/10 06:26");
  assert.equal(releaseColumn(green), "#171 27/10 10:00");
});

test("queueView: linha do core e dica quando os ociosos não têm o label", () => {
  const queue = queueView(fixtureSnapshot());
  assert.equal(queue.waiting, 5);
  assert.equal(queue.line, "5 na fila — runner solid-srv ocupado");
  assert.match(queue.hint ?? "", /label solid-srv/);
  assert.deepEqual(queueView(fixtureSnapshot([green])), { waiting: 0, line: null, hint: null });
});

test("badge: runs ativas, 1 para falha ou reversão, some depois de visto", () => {
  const active = badgeState(fixtureSnapshot());
  assert.equal(active.count, 1);
  assert.equal(visibleBadge(active, null), 1);
  assert.equal(visibleBadge(active, active.signature), 0);

  const problem = badgeState(fixtureSnapshot([reverted, failed]));
  assert.equal(problem.count, 1);
  assert.match(problem.signature, /:reverted$/);
  assert.equal(visibleBadge(problem, active.signature), 1);

  assert.equal(badgeState(fixtureSnapshot([failed])).count, 1);
  assert.equal(badgeState(fixtureSnapshot([green, failed])).count, 0);
  assert.equal(badgeState(fixtureSnapshot([inconclusive])).count, 0);
});

test("releaseChip: título curto, contexto completo dentro dos limites do host", () => {
  const chip = releaseChip(fixtureSnapshot(), running, FIXTURE_NOW);
  assert.equal(chip.providerId, "dbolt-release");
  assert.equal(chip.id, "#172");
  assert.equal(chip.title, "27/10 11:24 · imagens 3/9");
  assert.equal(releaseChip(null, failed, FIXTURE_NOW).id, "#169");
  assert.match(chip.text, /^Release #172 27\/10 11:24 do repositório/);
  assert.match(chip.text, /Fila: 5 na fila/);
  assert.match(chip.text, /^- imagens 3\/9: running/m);
  assert.ok(chip.text.length <= 16_000 && chip.title.length <= 200);

  const revertChip = releaseChip(fixtureSnapshot(), reverted, FIXTURE_NOW);
  assert.match(revertChip.text, /Rollback: vigia reverteu no dbolt-deploy no commit e9c4d2a1b · main congelada\./);
  assert.match(revertChip.text, /5xx \(errors5xx\): red/);
  assert.doesNotMatch(revertChip.text, /Fila:/);
});

test("parseReleaseArgs", () => {
  assert.equal(parseReleaseArgs(""), null);
  assert.equal(parseReleaseArgs(" 172 "), 172);
  assert.equal(parseReleaseArgs("release-172"), 172);
  assert.equal(parseReleaseArgs("ontem"), "invalid");
});

test("zod-slim cobre todo builder que o contrato compartilhado usa", async () => {
  const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
  const sources = await Promise.all(
    ["core/release-status.ts", "openchamber/src/ui/feed.ts"].map((path) => readFile(join(root, path), "utf8")),
  );
  const used = new Set(sources.flatMap((source) => [...source.matchAll(/\bz\.([a-zA-Z]+)\(/g)].map((match) => match[1]!)));
  const slim = await import("../scripts/zod-slim.ts");
  for (const builder of used) assert.equal(typeof (slim.z as unknown as Record<string, unknown>)[builder], "function", `z.${builder} falta em zod-slim.ts`);
});

test("headline e stepDetail: com o vigia publicando, a fase e a contagem regressiva", () => {
  const release = buildRelease({
    run: run({ run_number: 172, status: "completed", conclusion: "success" }),
    jobs: released("success", 172).jobs,
    watch: watchRun(172, "running"),
    progress: { phase: "observing", verdict: "pending", windowEndsAt: new Date(FIXTURE_NOW.getTime() + 7 * 60_000).toISOString(), deadline: null, sources: [] },
    note: null,
    commits: null,
    now: FIXTURE_NOW,
  });
  assert.equal(headline(release, FIXTURE_NOW), "observando · faltam 7m");
  assert.equal(stepDetail(release, stepOf(release, "watch"), null, FIXTURE_NOW), "observando · faltam 7m");
  const old = { ...release, progress: null };
  assert.equal(stepDetail(old, stepOf(old, "watch"), null, FIXTURE_NOW), "sinais do blast radius → veredito");
  assert.notEqual(headline(old, FIXTURE_NOW), "observando · faltam 7m");
});

test("stepDetail: vigia terminado mostra o veredito, o inconclusivo com o que faltou", () => {
  assert.equal(stepDetail(green, stepOf(green, "watch")), "vigia sem regressão");
  const held = {
    ...inconclusive,
    signals: [{ source: "deployment", label: "implantação", outcome: "inconclusive", reason: "flux-candidate-convergence" }],
  };
  assert.equal(stepDetail(held, stepOf(held, "watch")), "inconclusivo · faltou implantação (o Flux não aplicou a release)");
  assert.equal(headline(held), "inconclusivo · faltou implantação (o Flux não aplicou a release)");
});
