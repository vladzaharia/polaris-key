// Isolate-level caches, cleared between tests.
//
// A module with a cache that outlives a request registers its clear here at load time. The test
// setup (`test/setup/oidcClient.ts`) calls `runResets` before each test, so a test file sees the
// module state a fresh Worker isolate would, whether or not the runner gives each file its own
// module graph (`vitest run --no-isolate`).
//
// Production only ever calls `registerReset`, which keeps a function reference. `runResets` is
// called from tests alone; `test/isolationGuard.test.ts` fails when `src/` calls it.

const resets: Array<() => void> = [];

/** Register the function that empties one module's isolate state. Call at module load. */
export function registerReset(fn: () => void): void {
  resets.push(fn);
}

/** Empty every registered cache. Tests only. */
export function runResets(): void {
  for (const fn of resets) fn();
}
