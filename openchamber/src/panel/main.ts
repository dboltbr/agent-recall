// Rail panel: the release in focus step by step, the runner queue and recent verdicts.
import { isGuestAttachItem, type GuestItem } from "@openchamber/sdk";
import { findRelease, formatAgo, releaseLabel, type Release, type ReleaseSnapshot } from "../../../core/release-status.ts";
import { SEEN_KEY, hostActions } from "../ui/actions.ts";
import { boot, serviceCall, type Host } from "../ui/boot.ts";
import { h, icon, replaceChildren, spinner } from "../ui/dom.ts";
import { startFeed, type FeedState } from "../ui/feed.ts";
import { commitLines, outcomeBanner, releaseHead, runnersList, signalsList, stepsList, verdictRows, type Actions } from "../ui/render.ts";
import { badgeState, cancelledCount, otherActive, primaryRelease, queueView, recentVerdicts, snapshotError, statusLabel } from "../ui/view.ts";

function chipNumber(item: GuestItem | null): number | null {
  if (!item || !isGuestAttachItem(item)) return null;
  const data = item.data as { number?: unknown } | undefined;
  return typeof data?.number === "number" ? data.number : null;
}

export function releaseView(snapshot: ReleaseSnapshot, release: Release, now: Date, actions: Actions, select: (release: Release | null) => void, pinned: boolean): HTMLElement {
  const queue = queueView(snapshot);
  const history = recentVerdicts(snapshot, release).slice(0, 5);
  const others = otherActive(snapshot, release);
  const cancelled = cancelledCount(snapshot);
  return h(
    "div",
    { class: "rl" },
    pinned ? h("div", { class: "toolbar" }, h("button", { class: "link quiet", onClick: () => select(null) }, "← release atual")) : null,
    releaseHead(release, now),
    ...commitLines(release, now, actions),
    ...others.map((other) =>
      h(
        "div",
        { class: "rl-commit clickable", title: other.title, onClick: () => select(other) },
        icon("clock", 13),
        h("span", { class: "ellipsis" }, `${releaseLabel(other)} ${statusLabel(other)} · ${other.title || "(sem título)"}`),
      ),
    ),
    outcomeBanner(release, actions),
    h("div", { class: "rl-sec" }, "Etapas"),
    stepsList(snapshot, release, now),
    release.signals.length > 0 ? h("div", { class: "rl-sec" }, "Sinais do vigia") : null,
    signalsList(release),
    h("div", { class: "rl-sec" }, "Fila de runners", queue.waiting > 0 ? h("span", { class: "sp" }) : null, queue.waiting > 0 ? h("span", { class: "tx-warn", style: "text-transform:none;letter-spacing:0" }, `${queue.waiting} aguardando`) : null),
    runnersList(snapshot),
    queue.hint ? h("div", { class: "note tx-warn" }, icon("alert", 12), queue.hint) : null,
    h("div", { class: "rl-sec" }, "Vereditos recentes"),
    verdictRows(history, (picked) => select(picked)),
    cancelled > 0 ? h("div", { class: "muted", style: "font-size:11.5px;margin-top:4px" }, `${cancelled} ${cancelled === 1 ? "run cancelada oculta" : "runs canceladas ocultas"}`) : null,
    h(
      "div",
      { class: "rl-foot" },
      h("button", { class: "link", onClick: () => actions.openUrl(release.url) }, icon("external", 12), "ver run"),
      h("button", { class: "link quiet", onClick: () => actions.openCommit(release.headSha) }, icon("commit", 12), "ver commit"),
      h("span", { class: "sp" }),
      h("span", { class: "muted", style: "font-size:11.5px", title: "Abra pela lista Extension pages da barra lateral" }, "página Releases no menu lateral"),
    ),
  );
}

function mount(host: Host, root: HTMLElement, initialItem: GuestItem | null): void {
  root.className = "panel";
  let state: FeedState = { envelope: null, unavailable: null };
  let pinned: Release | null = null;
  let pinnedNumber = chipNumber(initialItem);
  let refreshing = false;
  const actions = hostActions(host, () => state.envelope?.snapshot?.repository ?? "dboltbr/dbolt");
  const feed = startFeed({ call: serviceCall(host), onState: (next) => ((state = next), render(), markSeen()) });

  const markSeen = () => {
    const snapshot = state.envelope?.snapshot;
    if (!snapshot || document.visibilityState !== "visible") return;
    void host.storage.set(SEEN_KEY, badgeState(snapshot).signature).catch(() => undefined);
    void host.setBadge(null).catch(() => undefined);
  };
  document.addEventListener("visibilitychange", markSeen);

  const select = (release: Release | null) => {
    pinned = release;
    pinnedNumber = release?.number ?? null;
    render();
    root.scrollIntoView({ block: "start" });
  };

  const resolvePinned = async (number: number) => {
    try {
      const found = await feed.release(number);
      if (found && pinnedNumber === number) {
        pinned = found;
        render();
      }
    } catch {
      /* stays on the current release */
    }
  };

  host.onItem((item) => {
    const number = chipNumber(item);
    if (number === null) return;
    pinnedNumber = number;
    const snapshot = state.envelope?.snapshot;
    pinned = snapshot ? findRelease(snapshot, number) : null;
    if (!pinned) void resolvePinned(number);
    render();
  });

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
    const fresh = h(
      "div",
      { class: `fresh${error || state.unavailable ? " err" : ""}` },
      envelope?.refreshing || refreshing ? spinner(11) : null,
      state.unavailable ?? (error ? `Última atualização falhou: ${error}` : snapshot ? `atualizado ${formatAgo(snapshot.fetchedAt, now)}` : ""),
      h("span", { class: "sp" }),
      h("button", { class: "iconbtn", title: "atualizar agora", onClick: () => void doRefresh() }, icon("refresh", 13)),
    );
    if (!snapshot) {
      replaceChildren(root, state.unavailable ? h("div", { class: "rl-banner warn" }, icon("alert", 14), state.unavailable) : h("div", { class: "loading" }, spinner(14), "carregando releases…"), fresh);
      return;
    }
    if (pinnedNumber !== null && (!pinned || pinned.number !== pinnedNumber)) {
      pinned = findRelease(snapshot, pinnedNumber) ?? pinned;
    } else if (pinned) {
      pinned = snapshot.releases.find((release) => release.runId === pinned!.runId) ?? pinned;
    }
    const release = pinned ?? primaryRelease(snapshot);
    if (!release) {
      replaceChildren(root, h("div", { class: "empty" }, "Nenhuma run do workflow release ainda."), fresh);
      return;
    }
    replaceChildren(root, releaseView(snapshot, release, now, actions, select, pinned !== null && pinned.runId !== primaryRelease(snapshot)?.runId), fresh);
  }

  render();
  if (pinnedNumber !== null) void resolvePinned(pinnedNumber);
  setInterval(render, 30_000);
}

boot((host, ctx, root) => mount(host, root, ctx.item ?? null));
