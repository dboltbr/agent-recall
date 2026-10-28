// Work Status section: one ~40 px strip with the release in focus, and the rail badge.
import { boot, serviceCall, type Host } from "../ui/boot.ts";
import { h, icon, replaceChildren, spinner } from "../ui/dom.ts";
import { startFeed, type FeedState } from "../ui/feed.ts";
import { readSeen } from "../ui/actions.ts";
import { releaseRing, segBar } from "../ui/render.ts";
import { PANEL_SURFACE, badgeState, elapsedLabel, headline, primaryRelease, revertParts, snapshotError, visibleBadge } from "../ui/view.ts";
import { displayName, formatAgo, isActive, trippedSignals, type Release } from "../../../core/release-status.ts";

function strip(release: Release, now: Date, onOpen: () => void, onLink: (url: string) => void): HTMLElement {
  const open = { class: "ws", onClick: onOpen, title: "abrir o painel Release" };
  if (release.verdict === "reverted") {
    const tripped = trippedSignals(release);
    const parts = revertParts(release);
    return h(
      "div",
      { ...open, class: "ws tall" },
      icon("undo", 16, "t-warn"),
      h(
        "div",
        { style: "min-width:0" },
        h("div", { class: "tx-warn ellipsis", style: "font-weight:600" }, `${displayName(release)} · ${parts?.what ?? headline(release)}`),
        h(
          "div",
          { class: "muted ellipsis", style: "font-size:12px" },
          parts?.notice ? `${parts.notice} · ` : "",
          h("span", { class: "link" }, tripped.length > 0 ? `ver ${tripped.length === 1 ? "sinal" : "sinais"}` : "ver detalhes"),
        ),
      ),
    );
  }
  if (release.verdict === "failed" || release.verdict === "red") {
    const url = release.failedJob?.url ?? release.url;
    return h(
      "div",
      open,
      icon("xCircle", 16, "t-bad"),
      h("span", { class: "tx-bad ellipsis", style: "font-weight:600" }, headline(release)),
      h("span", { class: "sp" }),
      h(
        "button",
        {
          class: "link",
          onClick: (event) => {
            event.stopPropagation();
            onLink(url);
          },
        },
        "ver log",
      ),
    );
  }
  const running = isActive(release);
  // Two rows inside the 40 px: the text line, then the step bar across the full width (the
  // section is ~280 px wide; side by side the bar would eat the step name).
  return h(
    "div",
    open,
    releaseRing(release, 16),
    h(
      "div",
      { class: "ws-col" },
      h(
        "div",
        { class: "ws-row" },
        h("span", { class: "t" }, displayName(release)),
        h("span", { class: "dim ellipsis hl" }, `· ${headline(release)}`),
        h("span", { class: "dim" }, running ? elapsedLabel(release, now) : formatAgo(release.completedAt ?? release.updatedAt, now)),
      ),
      segBar(release),
    ),
  );
}

function mount(host: Host, root: HTMLElement): void {
  root.className = "ws-wrap";
  let lastHeight = 0;
  let lastBadge = -1;

  const fit = () => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      void host.setHeight(height).catch(() => undefined);
    }
  };

  const openPanel = () => void host.openSurface(PANEL_SURFACE).catch(() => undefined);
  const openLink = (url: string) => void host.openUrl(url).catch(() => undefined);

  const render = async (state: FeedState) => {
    const snapshot = state.envelope?.snapshot ?? null;
    const release = snapshot ? primaryRelease(snapshot) : null;
    const now = new Date();
    if (release) {
      replaceChildren(root, strip(release, now, openPanel, openLink));
    } else if (state.unavailable || snapshotError(state.envelope)) {
      replaceChildren(root, h("div", { class: "ws" }, icon("alert", 14, "t-warn"), h("span", { class: "ellipsis" }, state.unavailable ?? snapshotError(state.envelope) ?? "")));
    } else if (snapshot) {
      replaceChildren(root, h("div", { class: "ws" }, h("span", null, "Nenhum release recente.")));
    } else {
      replaceChildren(root, h("div", { class: "ws" }, spinner(14), h("span", null, "carregando release…")));
    }
    root.style.height = root.firstElementChild?.classList.contains("tall") ? "" : "40px";
    fit();
    if (snapshot) {
      const count = visibleBadge(badgeState(snapshot), await readSeen(host));
      if (count !== lastBadge) {
        lastBadge = count;
        void host.setBadge(count > 0 ? count : null).catch(() => undefined);
      }
    }
  };

  let latest: FeedState = { envelope: null, unavailable: null };
  startFeed({ call: serviceCall(host), onState: (state) => void render((latest = state)) });
  // Durations tick even when the snapshot does not change.
  setInterval(() => void render(latest), 30_000);
  new ResizeObserver(fit).observe(root);
}

boot((host, _ctx, root) => mount(host, root));
