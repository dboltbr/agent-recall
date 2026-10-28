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
  visibleBadge,
} from "../src/ui/view.ts";
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
  assert.deepEqual(revertParts(reverted), { what: "vigia reverteu 3 commits", notice: "agente avisado" });
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
  assert.match(revertChip.text, /Reversão do vigia: 41d0c8e5b, a19f2c3d4, 77b0e1f2a/);
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
