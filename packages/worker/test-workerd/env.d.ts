import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/platform/env.js";

// `cloudflare:test`'s `env` is typed `Cloudflare.Env` (vitest-pool-workers 0.13+ dropped
// `ProvidedEnv`), so the worker's bindings plus the lane's own go on that interface.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
