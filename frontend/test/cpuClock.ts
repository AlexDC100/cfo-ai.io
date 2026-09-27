// cpuClock.ts — the CPU time THIS thread has spent, in milliseconds.
//
// WHY (review round 1 of stage CB-I): the latency laws timed a keystroke on
// the WALL clock (`performance.now()`), and the full suite runs ~240 files
// in parallel workers beside whatever else the machine is doing. A wall
// clock under load measures the load: the same keystroke that costs 5 ms
// alone read 380 ms while the scheduler ran other workers, and the full
// suite was red in 3 of 3 re-review runs on laws whose code had not moved.
// Raising the 100 ms budget would only hide the next real regression.
//
// What a jsdom latency law can honestly hold is the WORK a keystroke
// costs: the CPU the render thread spends between the keystroke and its
// committed frame. That does not grow while the thread waits for a core,
// so a law read on it is the same law alone or under load, and a keystroke
// that really does 150 ms of work (an index rebuilt per keystroke) is
// still red. The real browser's wall-clock latency is held live, on the
// built bundle (e2e/design/cmdbar.spec.ts G7).
//
// `process.threadCpuUsage` (Node >= 23.9) counts this thread only — right
// under both vitest pools. Without it, `process.cpuUsage` (the process —
// one worker per file under the default forks pool).

type Usage = { user: number; system: number };

const threadUsage: (() => Usage) | null = (() => {
  const p = process as unknown as { threadCpuUsage?: () => Usage };
  return typeof p.threadCpuUsage === "function" ? () => p.threadCpuUsage!() : null;
})();

/** CPU milliseconds this thread (else this process) has run. */
export function cpuNow(): number {
  const u = threadUsage ? threadUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/** Which clock `cpuNow` reads, for the GATE-WORK line. */
export const CPU_CLOCK = threadUsage ? "thread-cpu" : "process-cpu";

/** The REAL wall clock, captured before any test fakes `performance` —
 *  printed beside the CPU figure, never asserted. */
export const wallNow: () => number = (() => {
  const perf = globalThis.performance;
  const now = perf.now.bind(perf);
  return () => now();
})();
