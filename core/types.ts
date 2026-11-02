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
  readonly run?: { readonly id?: number; readonly url?: string; readonly failedJob?: string };
  readonly assessment?: { readonly suspects?: readonly { readonly commit?: string; readonly evidence?: string }[] };
  readonly fix?: { readonly session?: string; readonly branch?: string; readonly commit?: string };
  readonly inheritedFrom?: string;
  readonly drill?: boolean;
  readonly createdAt?: string;
  readonly updatedAt: string;
  /** Written by this plugin when a call failed on every rung. */
  readonly recall?: unknown;
}

/** `~/.config/agent-recall/config.json`. */
export interface HostConfig {
  readonly instance: string;
  readonly repository: string;
  readonly notesRef: string;
  /** Blocked-release notes (`refs/notes/release-blocked`, `-drill` in a drill). */
  readonly blockedRef: string;
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
