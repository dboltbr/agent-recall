import type { ReleaseSource } from "../../../core/release-fetch.ts";
import type { Release, ReleaseSnapshot } from "../../../core/release-status.ts";
import type { Note } from "../../../core/types.ts";

export interface LoaderOptions {
  readonly source: Pick<ReleaseSource, "load" | "lookup">;
  readonly token: () => Promise<string>;
  /** Watch notes keyed by the commit of tag `release-<n>`. */
  readonly notes: (token: string) => Promise<ReadonlyMap<string, Note>>;
  readonly warn: (message: string) => void;
}

export interface Loader {
  load(): Promise<ReleaseSnapshot>;
  lookup(number: number): Promise<Release | null>;
}

/**
 * Joins the token, the notes and the GitHub reads. A notes failure does not hide the workflow
 * runs: the snapshot still goes out with the last notes that loaded, or none.
 */
export function createLoader(options: LoaderOptions): Loader {
  let lastNotes: ReadonlyMap<string, Note> = new Map();

  const freshNotes = async (token: string): Promise<ReadonlyMap<string, Note>> => {
    try {
      lastNotes = await options.notes(token);
    } catch (error) {
      options.warn(`notas do vigia indisponíveis: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lastNotes;
  };

  return {
    async load() {
      const token = await options.token();
      const notes = await freshNotes(token);
      return options.source.load({ token, notes });
    },
    async lookup(number) {
      const token = await options.token();
      return options.source.lookup({ token, notes: lastNotes.size > 0 ? lastNotes : await freshNotes(token), number });
    },
  };
}
