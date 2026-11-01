// Shared shapes. The note body and the host config are the contract with the dbolt repo
// (openspec change release-on-push-agent-recall, "Contrato entre as lanes").

export type Harness = "paseo" | "opencode";

/** One `Agent-Session` trailer: `paseo/<serverId>/<agentId>` or `opencode/<instance>/<ses_…>`. */
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

/** `~/.config/agent-recall/config.json`. */
export interface HostConfig {
  readonly instance: string;
  readonly repository: string;
  readonly notesRef: string;
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
