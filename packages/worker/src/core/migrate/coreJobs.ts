/**
 * Core's own data-migration jobs (P0-49). Each is a DELEGATED job: Core has a gated flow of its
 * own for the change (a notice window, a freeze, a step-up, a report the console reads), and the
 * runner must not become a second way to start it. The runner dry-runs the job so the CLI and the
 * report ledger see one shape; `apply` and `down` answer `delegated` (`MigrationJob.delegatedTo`).
 *
 * Why these two are not folded all the way in:
 *
 *   - The licence-override migration (U-03) is a platform-wide state machine: prerequisite flags,
 *     a 30-day notice, a not-before date, a freeze of licence config from the run's start, a
 *     completion that switches the document builder, a 90-day report and a nightly sweep. Its
 *     drops of unowned overrides cannot be undone, so it has no down. Mapping that onto
 *     plan/apply/down would change the console's behaviour, so only its dry run joins the runner.
 *   - The settings backfill (ST-01c) already is dry run, pinned report, apply, no-op re-apply,
 *     per product. But its dry run WRITES a report row and reads the manifest from GitHub, which a
 *     runner `plan` may not do, and its apply reverts console values (D19) with no down. It
 *     keeps its own flow, and its table crossings stay with P0-26.
 */

import type { MigrationJob } from "./job.js";
import { dryRunOverrideMigration } from "../ops/overrideMigration.js";
import { listAllProductSlugs } from "../products/store.js";

/** The override migration's dry run, per product: counts only (no licence id, no value). */
export const overrideMigrationJob: MigrationJob = {
  id: "core.licence-override-migration",
  summary:
    "Move licence config and secret overrides onto the owner's account override (apply from the console)",
  delegatedTo:
    "the console's licence override migration (notice, then run, with a step-up)",
  units: ({ db }) => listAllProductSlugs(db),
  async plan({ db, now }, unit) {
    const { inventory } = await dryRunOverrideMigration(db, now, {
      product: unit,
    });
    const p = inventory.products[0];
    return {
      changes: p?.licences ?? 0,
      detail: p
        ? {
            owned: p.owned,
            dropped: p.dropped,
            collapsingAccounts: p.collapsingAccounts,
          }
        : undefined,
    };
  },
  apply: () => Promise.reject(new Error("delegated")),
  down: () => Promise.reject(new Error("delegated")),
};

export const CORE_MIGRATIONS: readonly MigrationJob[] = [overrideMigrationJob];
