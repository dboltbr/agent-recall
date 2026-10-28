// Plugin RPC contracts between the daemon (`server/release.ts`) and the release surfaces.
// Clients never call GitHub: they read the snapshot the daemon's poller keeps.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ReleaseSnapshotSchema } from "./release-status.ts";

export const AgentInfoSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  workspaceId: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const ReleaseViewSchema = z.object({
  /** Paseo server id of the daemon: which `paseo/<host>/<agent>` trailers are local agents. */
  host: z.string().nullable(),
  /** Null until the first load (no token yet, or still booting). */
  snapshot: ReleaseSnapshotSchema.nullable(),
  /** Local Paseo agents of the snapshot (sessions and handoffs) that exist on this daemon. */
  agents: z.array(AgentInfoSchema),
});
export type ReleaseView = z.infer<typeof ReleaseViewSchema>;

export const releaseSnapshot = defineRpc({
  name: "release.snapshot",
  input: z.object({}),
  output: ReleaseViewSchema,
});

export const releaseRefresh = defineRpc({
  name: "release.refresh",
  input: z.object({}),
  output: z.object({ refreshed: z.boolean(), view: ReleaseViewSchema }),
});
