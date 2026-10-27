import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startPaseoRecall } from "./server/paseo.ts";

export default function contribute(_server: PluginServerContext) {
  const stop = startPaseoRecall();
  return () => stop();
}
