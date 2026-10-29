import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFor } from "../../shared/release-cards.ts";
import { buildRelease, buildSnapshot, type Release } from "../../shared/release-status.ts";
import { NOW } from "../../core/test/fakes.ts";
import { finished, job, midImages, minutesAgo, run, RUNNERS } from "../../core/test/releases.ts";
import { cardView, releaseOpen } from "../card-view.ts";

function release(number: number, conclusion: string | null, jobs = finished("success")): Release {
  return buildRelease({
    run: run({
      run_number: number,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
      updated_at: minutesAgo(1),
    }),
    jobs: conclusion ? jobs : midImages(),
    note: null,
    commits: null,
    now: NOW,
  });
}

const snap = (...releases: Release[]) =>
  buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });

test("releaseOpen: ativo aberto, terminal (qualquer veredito) recolhido, escolha do usuário vence", () => {
  const live = release(250, null);
  assert.equal(releaseOpen(live, null), true);
  assert.equal(releaseOpen(release(249, "success"), null), false);
  assert.equal(releaseOpen(release(248, "failure"), null), false, "falha também recolhe; a linha mostra o vermelho");
  assert.equal(releaseOpen(release(247, "cancelled", finished("cancelled")), null), false);
  assert.equal(releaseOpen(release(249, "success"), true), true);
  assert.equal(releaseOpen(live, false), false);
});

test("cardView: dobrado some, cabeça do grupo lista do mais velho ao próprio", () => {
  const cancelled = (number: number) => release(number, "cancelled", finished("cancelled"));
  const noop = release(248, "success", [job("trigger", "success", [3, 2.9])]);
  const head = cancelled(249);
  const s = snap(cancelled(246), cancelled(247), noop, head);
  assert.deepEqual(cardView(cardFor(cancelled(246), s, null, { foldedInto: 249 })), { kind: "hidden" });
  const group = cardView(cardFor(head, s, null, { folded: [cancelled(246), cancelled(247), noop] }));
  assert.equal(group.kind, "group");
  assert.deepEqual(group.kind === "group" ? group.releases.map((r) => r.number) : [], [246, 247, 248, 249]);
  assert.deepEqual(cardView(cardFor(head, s, null)), { kind: "release" });
});
