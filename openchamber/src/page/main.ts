// Full page: the release board, the runner queue, watch reversals and the verdict history.
import { formatAgo, isActive, pillLabel, releaseLabel, stepOf, type Release, type ReleaseSnapshot } from "../../../core/release-status.ts";
import { hostActions } from "../ui/actions.ts";
import { boot, serviceCall, type Host } from "../ui/boot.ts";
import { h, icon, replaceChildren, spinner } from "../ui/dom.ts";
import { startFeed, type FeedState } from "../ui/feed.ts";
import { commitLines, lanes, outcomeBanner, pill, pipeline, releaseHead, runnersList, signalsList, toneText, type Actions } from "../ui/render.ts";
import {
  cancelledCount,
  elapsedLabel,
  headline,
  otherActive,
  primaryRelease,
  queueView,
  recentVerdicts,
  releaseColumn,
  reversals,
  revertParts,
  sessionLabel,
  shortSha,
  signalSummary,
  snapshotError,
  statusLabel,
} from "../ui/view.ts";

function boardCard(snapshot: ReleaseSnapshot, release: Release, now: Date, actions: Actions, pinned: boolean, unpin: () => void, select: (release: Release) => void): HTMLElement {
  const images = stepOf(release, "images");
  const queue = isActive(release) ? queueView(snapshot) : null;
  const laneBox = lanes(release, now);
  return h(
    "div",
    { class: "card rl" },
    pinned ? h("div", { class: "toolbar" }, h("button", { class: "link quiet", onClick: unpin }, "← release atual")) : null,
    releaseHead(release, now),
    ...commitLines(release, now, actions),
    ...otherActive(snapshot, release).map((other) =>
      h(
        "div",
        { class: "rl-commit clickable", title: other.title, onClick: () => select(other) },
        icon("clock", 13),
        h("span", { class: "ellipsis" }, `${releaseLabel(other)} ${statusLabel(other)} · ${other.title || "(sem título)"}`),
      ),
    ),
    pipeline(release, now),
    outcomeBanner(release, actions),
    laneBox && images
      ? h(
          "div",
          { class: "rl-sec" },
          `Imagens ${images.total ? `${images.done ?? 0}/${images.total}` : ""}`,
          h("span", { class: "sp" }),
          queue?.line ? h("span", { class: "tx-warn", style: "text-transform:none;letter-spacing:0;display:inline-flex;gap:5px;align-items:center" }, icon("clock", 11), queue.line) : null,
        )
      : null,
    laneBox,
    release.signals.length > 0 ? h("div", { class: "rl-sec" }, "Sinais do vigia") : null,
    signalsList(release),
    h(
      "div",
      { class: "rl-foot" },
      h("button", { class: "link", onClick: () => actions.openUrl(release.url) }, icon("external", 12), "ver run"),
      h("button", { class: "link quiet", onClick: () => actions.openCommit(release.headSha) }, icon("commit", 12), "ver commit"),
    ),
  );
}

function runnersCard(snapshot: ReleaseSnapshot): HTMLElement {
  const queue = queueView(snapshot);
  return h(
    "div",
    { class: "card" },
    h("h4", null, icon("server", 14), "Fila de runners", h("span", { class: "x" }, queue.waiting > 0 ? `${queue.waiting} ${queue.waiting === 1 ? "job aguardando" : "jobs aguardando"}` : "nenhum job aguardando")),
    runnersList(snapshot),
    queue.hint ? h("div", { class: "rl-banner warn", style: "align-items:flex-start" }, icon("alert", 13), h("span", null, queue.hint)) : null,
  );
}

function reversalsCard(snapshot: ReleaseSnapshot, select: (release: Release) => void): HTMLElement {
  const rows = reversals(snapshot);
  return h(
    "div",
    { class: "card" },
    h("h4", null, icon("undo", 14), "Reversões do vigia", h("span", { class: "x" }, `últimas ${snapshot.releases.length} runs`)),
    rows.length === 0
      ? h("div", { class: "empty" }, "Nenhuma reversão nas runs recentes.")
      : h(
          "div",
          { class: "rq" },
          ...rows.map((release) =>
            h(
              "div",
              { class: "rq-r clickable", style: "align-items:flex-start", onClick: () => select(release) },
              h("span", { class: "n", style: "width:84px" }, releaseColumn(release)),
              h(
                "span",
                { style: "flex:1;min-width:0" },
                h("div", { class: "tx-warn" }, [revertParts(release)?.what, revertParts(release)?.notice].filter(Boolean).join(" · ")),
                h("div", { class: "muted ellipsis", style: "font-size:11.5px" }, [signalSummary(release), release.title].filter(Boolean).join(" · ")),
              ),
            ),
          ),
        ),
  );
}

const COLUMNS: Array<[label: string, className: string]> = [
  ["release", ""],
  ["commit", "grow"],
  ["agente", "c-agent"],
  ["duração", "c-dur"],
  ["veredito do vigia", ""],
  ["sinais", "c-sig"],
  ["", ""],
];

function verdictTable(snapshot: ReleaseSnapshot, now: Date, actions: Actions, select: (release: Release) => void, showCancelled: boolean, toggleCancelled: () => void): HTMLElement {
  const finished = snapshot.releases.filter((release) => !isActive(release));
  const cancelled = cancelledCount(snapshot);
  const rows = showCancelled ? finished : recentVerdicts(snapshot, null);
  return h(
    "div",
    { class: "card ctab" },
    h("h4", null, icon("history", 14), "Vereditos do vigia", h("span", { class: "x" }, showCancelled ? `últimas ${finished.length} runs concluídas` : `${rows.length} com veredito · ${finished.length} concluídas`)),
    rows.length === 0
      ? h("div", { class: "empty" }, "Nenhum veredito entre as runs recentes.")
      : h(
          "table",
          { class: "htab" },
          h("thead", null, h("tr", null, ...COLUMNS.map(([label, className]) => h("th", { class: className }, label)))),
          h(
            "tbody",
            null,
            ...rows.map((release) => {
              const session = release.pusher ?? release.sessions[0] ?? null;
              const linkUrl = release.verdict === "failed" && release.failedJob?.url ? release.failedJob.url : release.url;
              const row = h(
                "tr",
                { class: release.verdict === "cancelled" ? "clickable dim" : "clickable", title: "mostrar no quadro", onClick: () => select(release) },
                h("td", { class: "mono" }, releaseColumn(release)),
                h("td", { class: "grow", title: release.title }, h("span", { class: "sha" }, shortSha(release.headSha)), " ", h("span", { class: "muted" }, release.title)),
                h("td", { class: "muted c-agent" }, session ? sessionLabel(session) : "—"),
                h("td", { class: "muted c-dur" }, elapsedLabel(release, now)),
                h("td", null, pill(release)),
                h("td", { class: `${toneText(release)} c-sig`, title: signalSummary(release) }, headline(release)),
                h(
                  "td",
                  { class: "lk" },
                  h(
                    "button",
                    {
                      class: "link",
                      onClick: (event) => {
                        event.stopPropagation();
                        actions.openUrl(linkUrl);
                      },
                    },
                    release.verdict === "failed" ? "ver log" : "ver run",
                  ),
                ),
              );
              return row;
            }),
          ),
        ),
    cancelled > 0
      ? h(
          "div",
          { class: "tfoot" },
          h("button", { class: "link quiet", onClick: toggleCancelled }, showCancelled ? `ocultar ${cancelled} canceladas` : `mostrar ${cancelled} ${cancelled === 1 ? "run cancelada" : "runs canceladas"} por push mais novo`),
        )
      : null,
  );
}

function mount(host: Host, root: HTMLElement): void {
  let state: FeedState = { envelope: null, unavailable: null };
  let pinned: Release | null = null;
  let refreshing = false;
  let showCancelled = false;
  const actions = hostActions(host, () => state.envelope?.snapshot?.repository ?? "dboltbr/dbolt");
  const feed = startFeed({ call: serviceCall(host), onState: (next) => ((state = next), render()) });

  const select = (release: Release | null) => {
    pinned = release;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const doRefresh = async () => {
    refreshing = true;
    render();
    try {
      await feed.refresh();
    } catch (error) {
      void host.toast({ kind: "error", message: error instanceof Error ? error.message : "Falha ao atualizar." }).catch(() => undefined);
    } finally {
      refreshing = false;
      render();
    }
  };

  function render() {
    const envelope = state.envelope;
    const snapshot = envelope?.snapshot ?? null;
    const error = snapshotError(envelope);
    const now = new Date();
    const header = h(
      "div",
      { class: "page-h" },
      h("span", { class: "title" }, "Releases"),
      h("span", { class: "sub" }, `${snapshot?.repository ?? "dboltbr/dbolt"} · release workflow em push na main`),
      h("span", { class: "sp" }),
      h(
        "span",
        { class: `fresh${error || state.unavailable ? " err" : ""}`, style: "margin:0" },
        envelope?.refreshing || refreshing ? spinner(11) : null,
        state.unavailable ?? (error ? `Última atualização falhou: ${error}` : snapshot ? `atualizado ${formatAgo(snapshot.fetchedAt, now)}` : ""),
      ),
      h("button", { class: "iconbtn", title: "atualizar agora", onClick: () => void doRefresh() }, icon("refresh", 15)),
      h(
        "button",
        { class: "iconbtn", title: "abrir o workflow no GitHub", onClick: () => actions.openUrl(`https://github.com/${snapshot?.repository ?? "dboltbr/dbolt"}/actions/workflows/release.yml`) },
        icon("external", 15),
      ),
    );
    if (!snapshot) {
      replaceChildren(root, h("div", { class: "page" }, header, state.unavailable ? h("div", { class: "rl-banner warn" }, icon("alert", 14), state.unavailable) : h("div", { class: "loading" }, spinner(14), "carregando releases…")));
      return;
    }
    if (pinned) pinned = snapshot.releases.find((release) => release.runId === pinned!.runId) ?? pinned;
    const primary = primaryRelease(snapshot);
    const release = pinned ?? primary;
    replaceChildren(
      root,
      h(
        "div",
        { class: "page" },
        header,
        h(
          "div",
          { class: "cols" },
          h("div", { class: "main" }, release ? boardCard(snapshot, release, now, actions, pinned !== null && pinned.runId !== primary?.runId, () => select(null), select) : h("div", { class: "card empty" }, "Nenhuma run do workflow release ainda.")),
          h("div", { class: "side" }, runnersCard(snapshot), reversalsCard(snapshot, select)),
        ),
        verdictTable(snapshot, now, actions, select, showCancelled, () => ((showCancelled = !showCancelled), render())),
      ),
    );
    document.title = release ? `Releases · ${pillLabel(release)}` : "Releases";
  }

  render();
  setInterval(render, 30_000);
}

boot((host, _ctx, root) => mount(host, root));
