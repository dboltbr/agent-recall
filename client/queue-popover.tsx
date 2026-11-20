// Popover for a PR / Mergify merge queue item (composer pill and workspace header button).
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import {
  prStageBadge,
  type CiJob,
  type MergeQueueSnapshot,
  type PullRequestStatus,
} from "../shared/queue-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { retryReleases, useReleaseState } from "./data.ts";
import { Badge, LinkText, PressText, Sha, toneColor } from "./kit.tsx";
import { QueueLine, SectionLabel, Spin } from "./release-parts.tsx";

function JobRow({ theme, job }: { theme: PluginTheme; job: CiJob }) {
  const color =
    job.state === "success"
      ? theme.colors.statusSuccess
      : job.state === "failure"
        ? theme.colors.statusDanger
        : job.state === "running"
          ? theme.colors.accent
          : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 }}>
      {job.state === "running" ? (
        <Spin color={color} size={13} />
      ) : (
        <Icon
          name={job.state === "success" ? "CircleCheck" : job.state === "failure" ? "CircleX" : "Clock"}
          size={13}
          color={color}
        />
      )}
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12.5, flex: 1, minWidth: 0 }}>
        {job.name}
      </Text>
      {job.url ? <LinkText theme={theme} href={job.url} label="log" muted /> : null}
    </View>
  );
}

function aheadSummary(queue: MergeQueueSnapshot | undefined, pr: PullRequestStatus): string | null {
  if (pr.stage !== "queued" || !queue?.batches.length) return null;
  const active = queue.batches[0]!;
  const tested = active.prNumbers.map((num) => `#${num}`).join(", ");
  const progress = active.total > 0 ? ` (${active.done}/${active.total})` : "";
  return tested ? `atrás de ${tested} · batch #${active.prNumber}${progress}` : `atrás do batch #${active.prNumber}${progress}`;
}

export function QueueBody({
  theme,
  queue,
  pr,
  openReleases,
}: {
  theme: PluginTheme;
  queue: MergeQueueSnapshot | undefined;
  pr: PullRequestStatus;
  openReleases: (() => void) | null;
}) {
  const badge = prStageBadge(pr);
  const ahead = aheadSummary(queue, pr);
  const batch = pr.batchPrNumber ? (queue?.batches.find((item) => item.prNumber === pr.batchPrNumber) ?? null) : null;
  const jobsTitle = pr.stage === "checking" ? "Jobs do ci-queue" : "Jobs do CI";
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={pr.stage === "open" ? "GitPullRequest" : "GitMerge"} size={14} color={toneColor(theme, badge.tone)} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13.5 }}>{`PR #${pr.number}`}</Text>
        <Badge theme={theme} tone={badge.tone} label={badge.label} />
        <View style={{ flex: 1 }} />
        {pr.total > 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`${pr.done}/${pr.total}`}</Text>
        ) : null}
      </View>

      <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 12.5, marginTop: 6 }}>
        {pr.title}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 5, minWidth: 0 }}>
        <Sha theme={theme} sha={pr.branch} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{pr.headSha.slice(0, 7)}</Text>
      </View>

      {batch ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
          <Icon name="Layers" size={12} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>
            {batch.batchName ? `Batch ${batch.batchName} (#${batch.prNumber})` : `Batch #${batch.prNumber}`}
          </Text>
          <LinkText theme={theme} href={batch.url} label="ver batch" muted />
        </View>
      ) : null}

      {ahead ? <QueueLine theme={theme} text={ahead} /> : null}
      {pr.stage === "dequeued" ? (
        <QueueLine theme={theme} text="Removido da fila pelo Mergify; corrija o CI ou conflitos e recoloque o label queue." />
      ) : null}

      {pr.jobs.length > 0 ? (
        <>
          <SectionLabel theme={theme}>{jobsTitle}</SectionLabel>
          <View>
            {pr.jobs.map((job) => (
              <JobRow key={job.name} theme={theme} job={job} />
            ))}
          </View>
        </>
      ) : pr.stage === "checking" || pr.ciState === "running" || pr.ciState === "queued" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 }}>
          <Spin color={theme.colors.accent} size={13} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {pr.stage === "checking" ? "Executando ci-queue…" : "Executando CI…"}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <LinkText theme={theme} href={pr.url} icon="ExternalLink" label="ver PR" />
        {pr.runUrl ? <LinkText theme={theme} href={pr.runUrl} icon="Play" label="ver CI" muted /> : null}
        <View style={{ flex: 1 }} />
        {openReleases ? <PressText theme={theme} label="abrir Releases" onPress={openReleases} muted /> : null}
      </View>
    </View>
  );
}

export function QueuePopover({
  theme,
  pick,
  openReleases,
}: {
  theme: PluginTheme;
  pick: (view: ReleaseView) => PullRequestStatus | null;
  openReleases: (() => void) | null;
}) {
  const { view, error, loading } = useReleaseState();
  const pr = view?.snapshot ? pick(view) : null;
  return (
    <View style={{ padding: 12, width: 390, maxWidth: "100%" }}>
      {loading && !view ? (
        <Loading />
      ) : !view || !view.snapshot ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12.5 }}>
            {error ?? "Aguardando a primeira leitura do GitHub…"}
          </Text>
          {error ? <PressText theme={theme} label="Tentar de novo" icon="RotateCw" onPress={retryReleases} /> : null}
        </View>
      ) : !pr ? (
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Nenhum PR aberto para esta branch.</Text>
          {openReleases ? <PressText theme={theme} label="abrir Releases" onPress={openReleases} /> : null}
        </View>
      ) : (
        <>
          <QueueBody theme={theme} queue={view.snapshot.queue} pr={pr} openReleases={openReleases} />
          {error ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11.5, marginTop: 8 }}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}
