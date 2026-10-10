import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/platform/env.js";

// The consumer's bindings (wrangler.deltas.toml) plus the lane's own, on `Cloudflare.Env`.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
