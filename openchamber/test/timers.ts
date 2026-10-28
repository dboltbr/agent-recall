// Manual clock + timers for the monitor: nothing fires until the test advances time.
import type { Timers } from "../src/service/monitor.ts";

export function manualTime(start = 0) {
  let now = start;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    setTimeout(callback, ms) {
      const id = ++next;
      pending.set(id, { at: now + ms, run: callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    /** Delays of the timers still pending, relative to now. */
    pending: () => [...pending.values()].map((entry) => entry.at - now).sort((a, b) => a - b),
    /** Moves time forward, firing due timers in order and letting their promises settle. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
