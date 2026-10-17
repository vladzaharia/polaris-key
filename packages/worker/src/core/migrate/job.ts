/**
 * The data-migration job contract (P0-49, CQW-17). A job is a one-off change to stored data that
 * a release depends on: a backfill, a seed, a re-seal, a materialisation. Every such change is a
 * `MigrationJob` run by `./runner.ts`; no consumer ships a runner of its own.
 *
 * The runner gives a job the same four properties, so the job need only be correct per unit:
 *
 *   dry run   `plan` reads and writes nothing; the runner stores its answer as the report.
 *   apply     only against a report an operator read (pinned by id); unit by unit, resumable.
 *   idempotent `apply` of a unit that is already applied changes nothing (the contract below).
 *   down      `down` undoes one unit, for the units an apply finished.
 *
 * A semantic change runs in two releases: release N materialises explicit values under the old
 * semantics through a job; release N+1 switches the resolver once a fresh dry run reports zero
 * diffs (`RunView.changes === 0`).
 *
 * A job lives with the code that owns its data: a service contributes it through
 * `ServiceDescriptor.contributes.migrations`, Core's own through `CORE_MIGRATIONS`. Nothing runs
 * a job but an operator's request (the admin route): not a deploy, not the scheduled tick.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";

/** The unit of a job that is not keyed per product. */
export const PLATFORM_UNIT = "platform";

export interface MigrationContext {
  env: Env;
  db: Db;
  /** Epoch seconds. */
  now: number;
}

/** What a unit's dry run found. `detail` is JSON, and never holds secret material. */
export interface UnitPlan {
  /** Rows the apply would change. Zero means the unit is already migrated. */
  changes: number;
  detail?: unknown;
}

export interface MigrationJob {
  /** Stable id, `<owner>.<name>` (`identity.seed-platform-connection`). */
  id: string;
  /** One line for the operator. */
  summary: string;
  /**
   * Set when the change has its own gated flow (a notice window, a freeze, a step-up, a stored
   * report the console reads) that the runner must not bypass. The runner dry-runs the job and
   * keeps the report, but refuses `apply` and `down` (`delegated`); this names where to apply.
   */
  delegatedTo?: string;
  /** The units to migrate: product slugs, or `[PLATFORM_UNIT]` for a platform-wide job. */
  units(ctx: MigrationContext): Promise<string[]>;
  /** The dry run of one unit. Reads only. */
  plan(ctx: MigrationContext, unit: string): Promise<UnitPlan>;
  /**
   * Apply one unit. MUST be idempotent: the runner calls it again for a unit it could not prove
   * finished (a call killed between the write and the runner's mark). Answers rows changed.
   */
  apply(ctx: MigrationContext, unit: string): Promise<number>;
  /** Undo one unit. Answers rows changed. */
  down(ctx: MigrationContext, unit: string): Promise<number>;
}
