import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startPaseoRecall } from "./server/paseo.ts";
import { releaseRefresh, releaseSnapshot } from "./shared/rpc.ts";

export default function contribute(server: PluginServerContext) {
  const recall = startPaseoRecall();
  const { release } = recall;
  // The daemon API exists only inside handlers and hooks: the first one hands it to the release
  // cards, which wait for it.
  server.handle(releaseSnapshot, (_input, { paseo }) => {
    release.attach(paseo);
    return release.view();
  });
  server.handle(releaseRefresh, (_input, { paseo }) => {
    release.attach(paseo);
    return release.refresh();
  });
  const offStarted = server.on("agent.turn_started", ({ agent }, { paseo }) => {
    release.attach(paseo);
    release.noteAgent(agent.id, { title: agent.title, workspaceId: agent.workspaceId });
  });
  const offEnded = server.on("agent.turn_ended", ({ agent }, { paseo }) => {
    release.attach(paseo);
    release.noteAgent(agent.id, { title: agent.title, workspaceId: agent.workspaceId });
  });
  return async () => {
    offStarted();
    offEnded();
    await recall.stop();
  };
}
