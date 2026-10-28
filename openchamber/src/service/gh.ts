import type { Exec } from "../../../core/types.ts";

/** Hard deadline per `gh` call. */
export const GH_TIMEOUT_MS = 25_000;
/** A token is reused this long before `gh auth token` runs again (a `gh auth refresh` is picked up). */
export const TOKEN_TTL_MS = 10 * 60_000;

/**
 * The host's GitHub token, from the `gh` login of the user running OpenChamber. Cached briefly;
 * never logged, never sent to the page.
 */
export function createTokenSource(exec: Exec, now: () => number) {
  let cached: { value: string; at: number } | null = null;
  return {
    async token(): Promise<string> {
      if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.value;
      const result = await exec("gh", ["auth", "token"], { timeoutMs: GH_TIMEOUT_MS, env: { GH_PROMPT_DISABLED: "1" } });
      const value = result.stdout.trim();
      if (result.code !== 0 || value === "") {
        cached = null;
        throw new Error("gh auth token falhou: rode `gh auth login` no host do OpenChamber");
      }
      cached = { value, at: now() };
      return value;
    },
    /** Drops the cached token, e.g. after GitHub answered 401. */
    forget(): void {
      cached = null;
    },
  };
}
