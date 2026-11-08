// Shared shapes. The note body and the host config are the contract with the dbolt repo
// (openspec change release-on-push-agent-recall, "Contrato entre as lanes").

export type Harness = "paseo" | "opencode" | "claude";

/**
 * One `Agent-Session` trailer: `paseo/<serverId>/<agentId>`, `opencode/<instance>/<ses_…>` or
 * `claude/<instance>/<sessionId>` (Claude Code outside Paseo).
 */
export interface SessionRef {
  readonly harness: Harness;
  readonly host: string;
  readonly id: string;
}

export interface NoteSession extends SessionRef {
  readonly commits?: readonly string[];
}

/**
 * The watch's rollback of a red release (`scripts/release-incident-note.py respond`): the pin in
 * `dbolt-deploy`, or the range's flag commits on `main` for a flags-only release. Read
 * defensively: it is JSON from another repository.
 */
export interface NoteRollback {
  /** `pending` until the watch records how it ended: `reverted`, `blocked`, `failed` or `none`. */
  readonly outcome?: string;
  readonly target?: string;
  /** The revert commit (`dbolt-deploy` or `main`). */
  readonly commit?: string;
  /** Flux applied the revert within 5 min. */
  readonly applied?: boolean;
  readonly reason?: string;
  readonly findings?: readonly unknown[];
  readonly detail?: string;
  readonly commits?: readonly string[];
  readonly at?: string;
}

/** Body of a `refs/notes/release-watch` note, keyed by the commit of tag `release-<n>`. */
export interface Note {
  /** Autoridade explícita da API; ensaio não congela main. */
  readonly frozen?: boolean;
  readonly release: string | number;
  /** The watch verdict object (`{verdict, sources, missing, at}`); read through release-status. */
  readonly verdict?: unknown;
  readonly range?: { readonly from?: string | null; readonly to?: string; readonly truncated?: boolean };
  /** The `Agent-Session` of the range head: the session that acts. Null: nobody is called. */
  readonly owner?: NoteSession | null;
  /** The range's other sessions: told, never asked to act. */
  readonly notified?: readonly NoteSession[];
  readonly rollback?: NoteRollback | null;
  readonly updatedAt: string;
  /** The green release that lifted the freeze. */
  readonly resolvedBy?: string;
  readonly drill?: boolean;
  /** Written by this plugin when a call failed on every rung. */
  readonly recall?: unknown;
}

/** One entry of a blocked note's `expired`: a session that lost the lease or never took the call. */
export interface ExpiredSession {
  /** `<harness>/<host>/<id>`. */
  readonly session?: string;
  readonly at?: string;
  readonly reason?: string;
}

/** The incident host's claim on a blocked note no session of the range can take any more. */
export interface BlockedIncident {
  /** `<harness>/<host>` of the plugin that claimed it. */
  readonly by?: string;
  readonly at?: string;
  /** `<harness>/<host>/<id>` of the agent it opened, once open. */
  readonly session?: string;
}

/**
 * Body of a `refs/notes/release-blocked` note, keyed by the run's head commit (a release blocked
 * before its tag has no tag). Its own shape, written by the dbolt `blocked-note` job: `owner` is a
 * session string here. States: `red` → `investigating` → `fix-pending` → `shipped`, or
 * `unrelated`, `escalated`, `duplicate` (an open note of the same range already has an owner).
 */
export interface BlockedNote {
  readonly release: string | number;
  readonly state: string;
  readonly range?: { readonly from?: string | null; readonly to?: string };
  /** Every identified `Agent-Session` of the range with its commits; commits without one are absent. */
  readonly sessions?: readonly NoteSession[];
  /** `<harness>/<host>/<id>` of the session that took the release. */
  readonly owner?: string | null;
  /** `failures`: the failing tests the CI read from the failed jobs' logs. */
  readonly run?: { readonly id?: number; readonly url?: string; readonly failedJob?: string; readonly failures?: readonly string[] };
  readonly assessment?: { readonly suspects?: readonly { readonly commit?: string; readonly evidence?: string }[] };
  readonly fix?: { readonly session?: string; readonly branch?: string; readonly commit?: string };
  readonly inheritedFrom?: string;
  readonly drill?: boolean;
  readonly createdAt?: string;
  readonly updatedAt: string;
  /**
   * The lease holder's last sign of work (`owner` in `investigating`, `fix.session` in
   * `fix-pending`), written only by the holder's plugin; never moves `updatedAt`.
   */
  readonly heartbeatAt?: string;
  /** Sessions that lost the lease or never took the call: never called again for this note. */
  readonly expired?: readonly ExpiredSession[];
  readonly incident?: BlockedIncident | null;
  /** Written by this plugin when a call failed on every rung. */
  readonly recall?: unknown;
}

/** `~/.config/agent-recall/config.json`. */
export interface HostConfig {
  /** Ao migrar o host, a fonte de incidentes passa a ser exclusivamente a API da factory. */
  readonly factoryApiUrl?: string;
  readonly factoryToken?: string;
  readonly instance: string;
  readonly repository: string;
  readonly notesRef: string;
  /** Blocked-release notes (`refs/notes/release-blocked`, `-drill` in a drill). */
  readonly blockedRef: string;
  /** This host opens a new agent for a blocked note no session of the range can take. */
  readonly incidentHost?: boolean;
  /** The dbolt checkout the incident agent opens in; required by `incidentHost`. */
  readonly incidentCheckout?: string;
}

/** Who this plugin is: it only acts on trailers of its own harness and host. */
export interface Me {
  readonly harness: Harness;
  readonly host: string;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly timeoutMs: number;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** Runs a program without a shell. Never rejects: a spawn failure or timeout is a non-zero code. */
export type Exec = (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** `owner` is asked to act; `notified` is only told, with the owner's name. */
export type Role = "owner" | "notified";
