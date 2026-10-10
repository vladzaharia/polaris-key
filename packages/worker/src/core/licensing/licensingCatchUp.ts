/**
 * The licensing catch-up (LX-08; plans/LX-01.md §6.2 steps 2–4, notes/S-19 §7.14): what makes
 * the licensing model's new rows complete after the deploy that starts writing them.
 *
 * `wrangler d1 migrations apply` runs before the code deploy, so for a few minutes a pre-LX-08
 * Worker still serves: it writes and revokes store grants in `license_store_grants` without their
 * projection, maps store products without their entitlement rows, and its sign-in writer still
 * puts provisioned keys into `overrides_json`. Nothing it does is unsafe (reads stay on those old
 * rows), but the new rows lag. This catches them up, and then keeps them caught up:
 *
 *   1. per product (`licensing.reconcile`): Core re-projects every store purchase into its grant
 *      (`storeGrantProjection`), and each registered service contributes its own re-projection
 *      (`ServiceDescriptor.licensingReconcile`: Distribution's `dist_purchases.grant_id` and
 *      store-product entitlement rows), whatever its enablement, in one batch per product;
 *   2. platform-wide (`licensing.migrateProvisioned`): every licence's OIDC-provisioned keys
 *      move to its `oidc` grant (`moveProvisionedKeys`), within a budget.
 *
 * Both are idempotent and resumable: once the rows agree, a pass writes nothing, and a pass that
 * stopped at its budget, failed part-way or ran twice at once is simply finished by the next.
 * Neither changes a single byte any device receives. It runs from the deploy hook after every
 * production deploy (`platformDeploy.ts`) and from the nightly maintenance (`scheduled.ts`,
 * step `licensingCatchUp`), never on a request path. docs/RUNBOOK.md "Licensing model expand
 * (LX-08)".
 */

import type { Db, DbStatement } from "../../db/types.js";
import { SERVICE_SLUGS } from "../services.js";
import { listAllProductSlugs } from "../repo.js";
import {
  moveProvisionedKeys,
  storeGrantProjection,
  type ProvisionedMoveReport,
} from "./grants.js";

/** The registry shape the catch-up needs (a `ServiceRegistry`, kept structural to avoid a cycle). */
type ReconcileRegistry = ReadonlyMap<
  string,
  { licensingReconcile?(product: string): DbStatement[] }
>;

/** Every statement re-projecting one product's licensing rows: Core's, then each registered
 *  service's in canonical `SERVICE_SLUGS` order. */
export function licensingReconcileStatements(
  registry: ReconcileRegistry,
  product: string,
): DbStatement[] {
  const out = storeGrantProjection(product, null, "migration");
  for (const slug of SERVICE_SLUGS) {
    const contribute = registry.get(slug)?.licensingReconcile;
    if (contribute) out.push(...contribute(product));
  }
  return out;
}

export interface LicensingCatchUpReport {
  /** Products whose rows were re-projected. */
  products: number;
  /** Products whose batch threw (named, with the message); the rest still ran. */
  failures: Record<string, string>;
  provisioned: ProvisionedMoveReport;
}

/**
 * One catch-up pass (see the header). `budget` caps the licences the provisioned-keys move
 * examines; the deploy hook passes a small one, the nightly maintenance the default.
 */
export async function runLicensingCatchUp(
  db: Db,
  registry: ReconcileRegistry,
  now: number,
  budget?: number,
): Promise<LicensingCatchUpReport> {
  const report: LicensingCatchUpReport = {
    products: 0,
    failures: {},
    provisioned: { moved: 0, deferred: 0, raced: 0, more: false },
  };
  for (const product of await listAllProductSlugs(db)) {
    try {
      await db.batch(licensingReconcileStatements(registry, product));
      report.products++;
    } catch (e) {
      report.failures[product] = e instanceof Error ? e.message : String(e);
    }
  }
  report.provisioned = await moveProvisionedKeys(db, now, budget);
  return report;
}
