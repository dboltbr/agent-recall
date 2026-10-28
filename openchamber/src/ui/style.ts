// Release widgets drawn with the host's theme tokens (`--oc-*`, written by `applyHostReady`), so
// light and dark follow the host. Fallbacks only matter before the first `ready`.

const CSS = `
:root {
  --rl-fg: var(--oc-fg, #e7e7e7);
  --rl-muted: var(--oc-muted, #9a9a9a);
  --rl-xmuted: color-mix(in srgb, var(--rl-muted) 72%, transparent);
  --rl-bg: var(--oc-bg, #161616);
  --rl-s1: var(--oc-muted-surface, color-mix(in srgb, var(--rl-fg) 5%, transparent));
  --rl-s2: color-mix(in srgb, var(--rl-fg) 9%, transparent);
  --rl-track: color-mix(in srgb, var(--rl-fg) 16%, transparent);
  --rl-border: var(--oc-border, color-mix(in srgb, var(--rl-fg) 12%, transparent));
  --rl-border2: color-mix(in srgb, var(--rl-fg) 18%, transparent);
  --rl-ok: var(--oc-success, #3fb950);
  --rl-bad: var(--oc-error, #f85149);
  --rl-warn: var(--oc-warning, #d29922);
  --rl-run: var(--oc-info, #58a6ff);
  --rl-ok-t: var(--oc-success-text, var(--rl-ok));
  --rl-bad-t: var(--oc-error-text, var(--rl-bad));
  --rl-warn-t: var(--oc-warning-text, var(--rl-warn));
  --rl-run-t: var(--oc-info-text, var(--rl-run));
  --rl-accent: var(--oc-primary-text, var(--rl-run-t));
  --rl-mono: var(--oc-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  --rl-font: var(--oc-font, system-ui, sans-serif);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; color: var(--rl-fg); font-family: var(--rl-font); font-size: 13px; }
button { font: inherit; }
.ic { flex: none; display: block; }
.mono { font-family: var(--rl-mono); }
.muted { color: var(--rl-muted); }
.sp { flex: 1; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.spin { color: var(--rl-run); animation: rl-spin 0.9s linear infinite; }
@keyframes rl-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.t-run { color: var(--rl-run); } .t-ok { color: var(--rl-ok); } .t-bad { color: var(--rl-bad); } .t-warn { color: var(--rl-warn); } .t-mut { color: var(--rl-muted); }
.tx-ok { color: var(--rl-ok-t); } .tx-bad { color: var(--rl-bad-t); } .tx-warn { color: var(--rl-warn-t); } .tx-run { color: var(--rl-run-t); }
.link { color: var(--rl-accent); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; background: none; border: 0; padding: 0; white-space: nowrap; }
.link:hover { text-decoration: underline; text-underline-offset: 2px; }
.link.quiet { color: var(--rl-muted); }
.link:focus-visible { outline: 2px solid var(--oc-focus, var(--rl-accent)); outline-offset: 2px; border-radius: 3px; }

/* pills */
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
.b-ok { color: var(--rl-ok-t); background: color-mix(in srgb, var(--rl-ok) 14%, transparent); }
.b-bad { color: var(--rl-bad-t); background: color-mix(in srgb, var(--rl-bad) 14%, transparent); }
.b-run { color: var(--rl-run-t); background: color-mix(in srgb, var(--rl-run) 14%, transparent); }
.b-warn { color: var(--rl-warn-t); background: color-mix(in srgb, var(--rl-warn) 14%, transparent); }
.b-mut { color: var(--rl-muted); background: var(--rl-s2); }
.b-run .spin { color: inherit; }

/* status section strip */
.ws { height: 100%; display: flex; align-items: center; gap: 9px; padding: 0 10px; font-size: 12.5px; color: var(--rl-muted); overflow: hidden; cursor: pointer; }
.ws-wrap { padding: 0 2px; }
.ws.tall { align-items: flex-start; padding: 8px 10px; }
.ws .t { font-weight: 600; color: var(--rl-fg); white-space: nowrap; }
.ws .dim { white-space: nowrap; }
.ws .hl { flex: 1 1 auto; min-width: 0; }
.ws-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ws-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ws .seg { width: 100%; }
.ws .seg i { flex: 1; width: auto; height: 4px; }
.ws .ic { margin-top: 0; }
.ws.tall .ic { margin-top: 1px; }
.ws:focus-visible { outline: 2px solid var(--oc-focus, var(--rl-accent)); outline-offset: -2px; border-radius: 6px; }

/* segmented step bar */
.seg { display: flex; gap: 3px; flex: none; }
.seg i { display: block; width: 16px; height: 5px; border-radius: 3px; background: var(--rl-track); }
.seg i.ok { background: var(--rl-ok); }
.seg i.bad { background: var(--rl-bad); }
.seg i.warn { background: var(--rl-warn); }
.seg i.cur { background: linear-gradient(90deg, var(--rl-run) var(--p, 33%), var(--rl-track) var(--p, 33%)); }

/* release block */
.rl { color: var(--rl-fg); font-size: 13px; }
.rl-head { display: flex; align-items: center; gap: 10px; }
.rl-head .t { font-weight: 600; font-size: 13.5px; }
.rl-head .s { color: var(--rl-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.rl-commit { display: flex; align-items: center; gap: 7px; color: var(--rl-muted); font-size: 12.5px; margin-top: 5px; min-width: 0; }
.rl-commit.clickable { cursor: pointer; }
.rl-commit.clickable:hover { color: var(--rl-fg); }
.sha { font-family: var(--rl-mono); font-size: 11.5px; color: var(--rl-fg); background: var(--rl-s2); padding: 0 5px; border-radius: 4px; flex: none; }
.rl-sec { color: var(--rl-xmuted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin: 16px 0 6px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.rl-steps { display: flex; flex-direction: column; }
.rl-step { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: start; padding: 6px 0; position: relative; }
.rl-step .si { width: 18px; height: 18px; display: grid; place-items: center; }
.rl-step .sn { font-weight: 500; }
.rl-step .sn .n { color: var(--rl-muted); font-weight: 400; }
.rl-step .sd { color: var(--rl-muted); font-size: 12px; margin-top: 1px; }
.rl-step .st { color: var(--rl-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rl-step.pending .sn, .rl-step.skipped .sn { color: var(--rl-muted); font-weight: 400; }
.rl-step:not(:last-child)::after { content: ""; position: absolute; left: 8.5px; top: 26px; bottom: -6px; width: 1px; background: var(--rl-border2); }
.pend-dot { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--rl-xmuted); display: block; }
.rl-imgs { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--rl-s2); color: var(--rl-fg); font-size: 11.5px; font-family: var(--rl-mono); }
.chip.q { background: transparent; border: 1px dashed var(--rl-border2); color: var(--rl-muted); }
.chip.b { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rl-run) 55%, transparent); }
.chip.x { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rl-bad) 55%, transparent); }
.note { margin-top: 6px; display: flex; gap: 6px; align-items: flex-start; font-size: 12px; }
.note .ic { margin-top: 2px; }

/* runner queue + verdict rows */
.rq { display: flex; flex-direction: column; gap: 2px; }
.rq-r { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: 12px; min-width: 0; }
.rq-r > .ic { color: var(--rl-muted); }
.rq-r .n { font-family: var(--rl-mono); font-size: 11.5px; flex: none; }
.rq-r .b { margin-left: auto; }
.rq-r.clickable { cursor: pointer; border-radius: 6px; }
.rq-r.clickable:hover { background: var(--rl-s1); }
.sig { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; font-size: 12px; padding: 3px 0; color: var(--rl-muted); }
.sig b { font-weight: 500; color: var(--rl-fg); }

.rl-banner { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; margin-top: 10px; }
.rl-banner.bad { background: color-mix(in srgb, var(--rl-bad) 12%, transparent); color: var(--rl-bad-t); }
.rl-banner.warn { background: color-mix(in srgb, var(--rl-warn) 13%, transparent); color: var(--rl-warn-t); }
.rl-banner.ok { background: color-mix(in srgb, var(--rl-ok) 12%, transparent); color: var(--rl-ok-t); }
.rl-banner .link { margin-left: auto; color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.rl-foot { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--rl-border); font-size: 12px; }
.fresh { color: var(--rl-xmuted); font-size: 11px; display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.fresh.err { color: var(--rl-warn-t); }

/* panel shell */
.panel { padding: 12px 14px 16px; }
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.iconbtn { background: none; border: 0; color: var(--rl-muted); padding: 4px; border-radius: 6px; cursor: pointer; display: inline-grid; place-items: center; }
.iconbtn:hover { color: var(--rl-fg); background: var(--rl-s2); }
.iconbtn:disabled { opacity: .5; cursor: default; }
.iconbtn:focus-visible { outline: 2px solid var(--oc-focus, var(--rl-accent)); outline-offset: 1px; }

/* page */
.page { padding: 18px 24px 28px; display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
.page-h { display: flex; align-items: baseline; gap: 12px; }
.page-h .title { font-size: 17px; font-weight: 600; }
.page-h .sub { color: var(--rl-muted); font-size: 13px; }
.cols { display: flex; gap: 16px; align-items: flex-start; }
.cols > .main { flex: 1; min-width: 0; }
.cols > .side { width: 340px; flex: none; display: flex; flex-direction: column; gap: 16px; }
@media (max-width: 900px) { .cols { flex-direction: column; align-items: stretch; } .cols > .side { width: auto; } }
.card { border: 1px solid var(--rl-border); border-radius: 14px; background: var(--rl-s1); padding: 16px 18px; }
.card h4 { margin: 0 0 12px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; white-space: nowrap; min-width: 0; }
.card h4 .x { color: var(--rl-muted); font-weight: 400; font-size: 12.5px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pipe { display: flex; align-items: flex-start; margin: 18px 0 6px; }
.pipe .pn { flex: 1; min-width: 0; position: relative; padding-top: 22px; }
.pipe .pn .pd { position: absolute; top: 0; left: 0; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; background: var(--rl-s2); color: var(--rl-muted); }
.pipe .pn .pd .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; display: block; }
.pipe .pn::before { content: ""; position: absolute; top: 7.5px; left: 20px; right: 4px; height: 1px; background: var(--rl-border2); }
.pipe .pn:last-child::before { display: none; }
.pipe .pn.ok .pd { background: color-mix(in srgb, var(--rl-ok) 20%, transparent); color: var(--rl-ok); }
.pipe .pn.ok::before { background: color-mix(in srgb, var(--rl-ok) 55%, transparent); }
.pipe .pn.cur .pd { background: color-mix(in srgb, var(--rl-run) 20%, transparent); color: var(--rl-run); }
.pipe .pn.bad .pd { background: color-mix(in srgb, var(--rl-bad) 20%, transparent); color: var(--rl-bad); }
.pipe .pn .pl { font-weight: 500; font-size: 12.5px; }
.pipe .pn.pend .pl { color: var(--rl-muted); font-weight: 400; }
.pipe .pn .pm { color: var(--rl-muted); font-size: 11.5px; margin-top: 1px; }
.lanes { display: flex; flex-direction: column; gap: 5px; }
.lane { display: grid; grid-template-columns: 190px 1fr 70px; align-items: center; gap: 12px; font-size: 12px; }
.lane .ln { font-family: var(--rl-mono); font-size: 11.5px; display: flex; align-items: center; gap: 7px; min-width: 0; }
.lane .ln span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane .lt { height: 14px; border-radius: 4px; background: var(--rl-s2); position: relative; overflow: hidden; }
.lane .lt b { position: absolute; top: 0; bottom: 0; border-radius: 4px; min-width: 3px; }
.lane .lt b.ok { background: color-mix(in srgb, var(--rl-ok) 55%, transparent); }
.lane .lt b.bad { background: color-mix(in srgb, var(--rl-bad) 55%, transparent); }
.lane .lt b.run { background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--rl-run) 60%, transparent) 0 6px, color-mix(in srgb, var(--rl-run) 40%, transparent) 6px 12px); }
.lane .lt b.q { background: transparent; border: 1px dashed var(--rl-border2); }
.lane .ld { color: var(--rl-muted); text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.htab { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; }
.htab th { text-align: left; font-weight: 500; color: var(--rl-xmuted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; padding: 0 10px 8px; border-bottom: 1px solid var(--rl-border); white-space: nowrap; }
.htab td { padding: 10px; border-bottom: 1px solid var(--rl-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.htab td.c-sig { max-width: 220px; }
.htab .grow { width: 100%; max-width: 0; }
.htab tr.dim td { opacity: .55; }
.ctab { container-type: inline-size; }
@container (max-width: 820px) { .htab .c-agent { display: none; } }
@container (max-width: 680px) { .htab .c-sig, .htab .c-dur { display: none; } }
.tfoot { margin-top: 10px; font-size: 12px; }
.htab tr:last-child td { border-bottom: 0; }
.htab td.lk { text-align: right; }
.empty { color: var(--rl-muted); font-size: 12.5px; padding: 6px 0; }
.loading { display: flex; align-items: center; gap: 8px; color: var(--rl-muted); padding: 12px 0; font-size: 12.5px; }
`;

export function installStyle(): void {
  if (document.getElementById("rl-style")) return;
  const style = document.createElement("style");
  style.id = "rl-style";
  style.textContent = CSS;
  document.head.append(style);
}
