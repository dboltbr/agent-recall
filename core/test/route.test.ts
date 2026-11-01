import assert from "node:assert/strict";
import { test } from "node:test";
import { notifiedPrompt, ownerPrompt, promptFor, rollbackLine } from "../deliver.ts";
import { ROLLBACK_WAIT_MS, route } from "../route.ts";
import type { Me, Note } from "../types.ts";
import { hoursAgo, NOW, note, session } from "./fakes.ts";

const me: Me = { harness: "paseo", host: "srv_a" };
const B = session("paseo", "srv_a", "agent-b", ["bbbbbbb"]);
const A = session("paseo", "srv_a", "agent-a", ["aaaaaaa"]);
const elsewhere = session("opencode", "archdev", "ses_x", ["ccccccc"]);

test("rota: o dono recebe o pedido de ação, as avisadas só o aviso, cada uma no seu host", () => {
  const incident = note({ release: "release-90", owner: B, notified: [A, elsewhere, A, B] });
  assert.deepEqual(route(incident, me, NOW), [
    { kind: "recall", release: "release-90", role: "owner", target: { harness: "paseo", host: "srv_a", id: "agent-b" }, lock: "agent-b.owner" },
    { kind: "recall", release: "release-90", role: "notified", target: { harness: "paseo", host: "srv_a", id: "agent-a" }, lock: "agent-a.notified" },
  ]);
  assert.deepEqual(
    route(incident, { harness: "opencode", host: "archdev" }, NOW).map((action) => [action.role, action.target.id]),
    [["notified", "ses_x"]],
  );
});

test("rota: nota sem dono ou resolvida não chama ninguém", () => {
  assert.deepEqual(route(note({ release: "release-90", owner: null, notified: [A] }), me, NOW), []);
  assert.deepEqual(route(note({ release: "release-90", notified: [A] }), me, NOW), []);
  assert.deepEqual(route(note({ release: "release-90", owner: B, notified: [A], resolvedBy: "release-91" }), me, NOW), []);
});

test("rota: rollback pendente segura o dono até o desfecho ou 10 min; a avisada não espera", () => {
  const verdictAt = (ms: number) => ({ verdict: "red", sources: {}, at: new Date(NOW.getTime() - ms).toISOString() });
  const pending = (ms: number): Note =>
    note({ release: "release-90", owner: B, notified: [A], rollback: { outcome: "pending" }, verdict: verdictAt(ms) });
  assert.deepEqual(route(pending(60_000), me, NOW).map((action) => action.role), ["notified"]);
  assert.deepEqual(route(pending(ROLLBACK_WAIT_MS), me, NOW).map((action) => action.role), ["owner", "notified"]);
  const blocked = note({ ...pending(60_000), rollback: { outcome: "blocked", reason: "unsafe-migration", findings: [{}] } });
  assert.deepEqual(route(blocked, me, NOW).map((action) => action.role), ["owner", "notified"]);
});

test("prompt do dono: motivo, rollback e congelamento", () => {
  const incident = note({ release: "release-90", owner: B, notified: [A] });
  const text = ownerPrompt("release-90", incident);
  assert.ok(text.startsWith("Incidente release-90: carregue a skill dbolt-release-incident. Papel: owner. "));
  assert.match(text, /investigue e corrija com Fixes-Release ou reverta com Reverts-Release/);
  assert.match(text, /Motivo: 5xx: errors5xx-ratio\. /);
  assert.match(text, /Rollback: o vigia reverteu a release-90 no dbolt-deploy \(commit d3p10y000000\); o Flux aplicou/);
  assert.match(text, /A main está congelada para código até ficar verde uma release com Fixes-Release: release-90/);
  assert.match(text, /Reverts-Release: release-90; Break-Glass só por decisão do responsável\./);
  assert.ok(text.endsWith(`Nota: ${JSON.stringify(incident)}`));
  const action = route(incident, me, NOW)[0]!;
  assert.equal(promptFor(action, incident), text);
});

test("prompt da avisada: aviso sem pedido de ação, com o nome do dono", () => {
  const incident = note({ release: "release-90", owner: B, notified: [A] });
  const text = notifiedPrompt("release-90", incident);
  assert.ok(text.startsWith("Incidente release-90: carregue a skill dbolt-release-incident. Papel: notified. Aviso, sem pedido de ação:"));
  assert.match(text, /Quem age é a dona, paseo\/srv_a\/agent-b;/);
  assert.match(text, /O seu próximo push de código para a main será recusado até a correção verde\./);
  assert.doesNotMatch(text, /investigue e corrija/);
  const drill = notifiedPrompt("release-90", { ...incident, drill: true });
  assert.match(drill, /Ensaio: a main não fica congelada\./);
});

test("rollback em pt-BR: revertido, impedido, falhou, pendente, nada a reverter", () => {
  const line = (rollback: Note["rollback"]) => rollbackLine("release-90", note({ release: "release-90", rollback }));
  assert.equal(
    line({ outcome: "reverted", target: "dbolt-deploy", commit: "abcdef1234567890", applied: false }),
    "o vigia reverteu a release-90 no dbolt-deploy (commit abcdef123456); o Flux NÃO aplicou em 5 min: confira o Flux antes de contar com a release anterior.",
  );
  assert.equal(
    line({ outcome: "reverted", target: "main", commit: "f1a6", applied: true }),
    "o vigia reverteu as flags da faixa na main (commit f1a6); o Flux aplicou: produção voltou à release anterior.",
  );
  assert.equal(
    line({ outcome: "blocked", target: "dbolt-deploy", reason: "unsafe-migration", findings: [{}, {}] }),
    "impedido: a imagem anterior não aguenta o banco depois da faixa (unsafe-migration), 2 achado(s) em findings. Produção segue na release-90; o caminho é Fixes-Release.",
  );
  assert.equal(
    line({ outcome: "failed", target: "dbolt-deploy", reason: "conflict", detail: "CONFLICT pins.yaml" }),
    "falhou: o revert conflita com o HEAD (conflict): CONFLICT pins.yaml. Produção segue na release-90.",
  );
  assert.equal(line({ outcome: "pending" }), "pendente: o vigia não gravou o desfecho do rollback; leia a nota antes de agir.");
  assert.equal(line({ outcome: "none", target: "main", reason: "nothing-to-revert" }), "nada revertido: a faixa não tem commit de flags revertível (nothing-to-revert).");
  assert.equal(line(null), "a nota não traz rollback.");
});

test("ensaio: o dono sabe que nada foi revertido nem congelado", () => {
  const drill = note({ release: "release-90", owner: B, drill: true, rollback: { outcome: "none", reason: "drill" }, updatedAt: hoursAgo(0.1) });
  const text = ownerPrompt("release-90", drill);
  assert.match(text, /Rollback: nada revertido: ensaio \(drill\)\. Ensaio: nada foi revertido nem congelado\./);
  assert.doesNotMatch(text, /congelada/);
});
