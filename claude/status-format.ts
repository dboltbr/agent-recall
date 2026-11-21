// Pure formatters for Claude Code CLI (`statusLine`) and Claude Code CLI/Desktop (`/release`
// command), sharing the exact PR-first labels, 3-stage progress and runner alert rules with Paseo
// and OpenChamber.
import { prForBranch, prForSession, prPillLabel, queueFooterLabel, queuedPrs, type PullRequestStatus } from "../core/queue-status.ts";
import { deployChips, popoverSteps, pusherLine, releaseBadge, runnerAlert, stepDetail, verdictRows } from "../core/release-copy.ts";
import {
  footerLabel,
  footerRelease,
  formatDuration,
  formatShortDuration,
  isActive,
  otherActive,
  pillLabel,
  releaseDurationMs,
  releaseForSession,
  releaseLabel,
  releaseMeta,
  STEP_LABELS,
  type Release,
  type ReleaseSnapshot,
} from "../core/release-status.ts";
import type { SessionRef } from "../core/types.ts";

export interface ClaudeContext {
  readonly sessionId?: string | null;
  readonly host?: string | null;
  readonly branch?: string | null;
  readonly now?: Date;
}

function sessionRefOf(ctx: ClaudeContext): SessionRef | null {
  if (!ctx.sessionId) return null;
  return { harness: "claude", host: ctx.host || "", id: ctx.sessionId };
}

function prForContext(snapshot: ReleaseSnapshot, ctx: ClaudeContext): PullRequestStatus | null {
  const queue = snapshot.queue;
  if (!queue) return null;
  const ref = sessionRefOf(ctx);
  if (ref) {
    const bySession = prForSession(queue, ref);
    if (bySession) return bySession;
  }
  if (ctx.branch && ctx.branch !== "main" && ctx.branch !== "HEAD") {
    return prForBranch(queue, ctx.branch);
  }
  return null;
}

function releaseForContext(snapshot: ReleaseSnapshot, ctx: ClaudeContext, now: Date): Release | null {
  const ref = sessionRefOf(ctx);
  if (ref) {
    const own = releaseForSession(snapshot, ref, now);
    if (own) return own;
  }
  return footerRelease(snapshot, now);
}

function chipGlyph(state: string): string {
  if (state === "success") return "✓";
  if (state === "failure") return "✗";
  if (state === "running") return "⟳";
  return "·";
}

function stepGlyph(state: string): string {
  if (state === "done") return "✓";
  if (state === "failed") return "✗";
  if (state === "running") return "⟳";
  if (state === "cancelled") return "⊘";
  return "○";
}

function deployInline(release: Release): string {
  const chips = deployChips(release);
  if (!chips.length) return "";
  return `[${chips.map((chip) => `${chipGlyph(chip.state)}${chip.name}`).join(" ")}]`;
}

/** One compact line for Claude Code CLI `statusLine` (empty string when nothing active/recent). */
export function formatClaudeStatusLine(snapshot: ReleaseSnapshot, ctx: ClaudeContext = {}): string {
  const now = ctx.now ?? new Date();
  const alert = runnerAlert(snapshot);
  const alertSuffix = alert?.tone === "bad" ? ` · ⚠ ${alert.text}` : "";
  const ref = sessionRefOf(ctx);
  const ownRelease = ref ? releaseForSession(snapshot, ref, now) : null;
  const pr = prForContext(snapshot, ctx);

  if (ownRelease && isActive(ownRelease)) {
    const detail = ownRelease.current === "deploy" ? deployInline(ownRelease) : "";
    return `🚀 ${pillLabel(ownRelease, now)}${detail ? ` ${detail}` : ""}${alertSuffix}`;
  }
  if (pr && (pr.stage !== "open" || pr.ciState === "running" || pr.ciState === "failure")) {
    return `🔀 ${prPillLabel(pr)}${alertSuffix}`;
  }
  const focused = ownRelease ?? footerRelease(snapshot, now);
  if (focused) {
    const others = isActive(focused) ? otherActive(snapshot, focused).length : 0;
    const detail = isActive(focused) && focused.current === "deploy" ? deployInline(focused) : "";
    return `🚀 ${footerLabel(focused, now, others)}${detail ? ` ${detail}` : ""}${alertSuffix}`;
  }
  const queueLabel = queueFooterLabel(snapshot.queue);
  if (queueLabel) return `🔀 ${queueLabel}${alertSuffix}`;
  return alert ? `⚠ ${alert.text}` : "";
}

/** Human-readable Markdown summary for `/agent-recall:release` in Claude Code CLI & Desktop. */
export function formatClaudeFullStatus(snapshot: ReleaseSnapshot, ctx: ClaudeContext = {}): string {
  const now = ctx.now ?? new Date();
  const lines: string[] = [];
  const release = releaseForContext(snapshot, ctx, now) ?? snapshot.releases[0] ?? null;

  if (release) {
    const badge = releaseBadge(release);
    const dur = formatShortDuration(releaseDurationMs(release, now));
    lines.push(`### 🚀 ${releaseLabel(release)} — **${badge.label}** (${releaseMeta(release)}${dur ? ` · ${dur}` : ""})`);
    const prs = release.prs ?? [];
    const title = prs[0]?.title || release.title;
    if (title) lines.push(`- **Mudança:** ${title}`);
    if (prs.length === 1) lines.push(`- **Branch:** \`${prs[0]!.branch}\``);
    else if (prs.length > 1) lines.push(`- **Branches:** ${prs.map((pr) => `#${pr.number} \`${pr.branch}\``).join(" · ")}`);
    const who = pusherLine(release, null, now);
    if (who) lines.push(`- **Autor:** ${who}`);
    lines.push("");
    lines.push("**Etapas**");
    for (const step of popoverSteps(release)) {
      const label = STEP_LABELS[step.id];
      const count = step.id === "images" && step.total ? ` ${step.done ?? 0}/${step.total}` : "";
      const stepTime = step.state === "pending" || step.state === "skipped" ? "" : formatDuration(step.durationMs);
      let detail = stepDetail(release, step, null, now);
      if (step.id === "deploy") {
        const chips = deployChips(release);
        if (chips.length) detail = chips.map((chip) => `${chipGlyph(chip.state)} ${chip.name}`).join(" · ");
      }
      lines.push(`- ${stepGlyph(step.state)} **${label}${count}**${detail ? ` — ${detail}` : ""}${stepTime ? ` (${stepTime})` : ""}`);
    }
    const links: string[] = [];
    if (prs[0]?.url) links.push(`[ver PR #${prs[0].number}](${prs[0].url})`);
    links.push(`[ver run](${release.url})`);
    lines.push("", links.join(" · "));
  } else {
    lines.push("Nenhuma release encontrada no snapshot.");
  }

  const alert = runnerAlert(snapshot);
  if (alert) {
    lines.push("", `> ${alert.tone === "bad" ? "⚠️" : "⏳"} **Runners:** ${alert.text}`);
  }

  const pr = prForContext(snapshot, ctx);
  const queued = queuedPrs(snapshot.queue);
  if (pr || queued.length > 0) {
    lines.push("", "**Fila de merge**");
    if (pr && !queued.some((q) => q.number === pr.number)) {
      lines.push(`- Esta branch: **${prPillLabel(pr)}** — ${pr.title}`);
    }
    for (const item of queued.slice(0, 5)) {
      const marker = pr?.number === item.number ? " *(esta branch)*" : "";
      lines.push(`- **${prPillLabel(item)}**${marker} — ${item.title}`);
    }
  }

  const recent = verdictRows(snapshot, 3).filter((item) => item.runId !== release?.runId);
  if (recent.length > 0) {
    lines.push("", "**Últimos vereditos**");
    for (const item of recent) {
      lines.push(`- **${releaseLabel(item)}** · ${releaseBadge(item).label} · ${item.prs?.[0]?.title || item.title}`);
    }
  }

  return lines.join("\n");
}
