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

/** Body of a `refs/notes/release-watch` note, keyed by the commit of tag `release-<n>`. */
export interface Note {
  readonly release: string | number;
  readonly verdict?: string;
  readonly range?: { readonly from?: string; readonly to?: string };
  readonly sessions?: readonly NoteSession[];
  readonly state: string;
  readonly owner?: string;
  readonly updatedAt: string;
  readonly drill?: boolean;
  readonly assessment?: {
    readonly at?: string;
    readonly suspects?: readonly { readonly commit?: string }[];
  };
  readonly decision?: { readonly action?: string; readonly commits?: readonly string[] };
  readonly fix?: { readonly session?: string; readonly readyAt?: string };
}

/** `~/.config/agent-recall/config.json`. */
export interface HostConfig {
  readonly instance: string;
  readonly incidentHost: boolean;
  readonly repository: string;
  readonly notesRef: string;
}

/** Who this plugin is: it only acts on trailers of its own harness and host. */
export interface Me {
  readonly harness: Harness;
  readonly host: string;
  readonly incidentHost: boolean;
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

export type Role = "investigate" | "fix";
