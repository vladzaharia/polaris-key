import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the tests live, independent of how deep a test file sits. `TEST_ROOT` is this
 * directory (`packages/worker/test`), `WORKER_ROOT` the package. A test that builds a path from
 * its own location uses these, so moving it into `core/`, `services/<slug>/` or `surfaces/`
 * changes nothing (`scripts/test-layout.mjs` swaps the old `HERE` for `TEST_ROOT`).
 */
export const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = join(TEST_ROOT, "..");
