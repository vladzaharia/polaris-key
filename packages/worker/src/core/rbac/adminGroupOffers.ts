/**
 * The `admin_group` conversion offers (ST-28 plan §5.1, built by ST-32.5).
 *
 * A product's `admin_group` grants nothing today. Where it is set to something other than the
 * parser default `"admin"` (an explicit `"admin"` cannot be told from the default, so it gets no
 * offer), a Superadmin is offered a rule that gives that group Product admin on the product. The
 * outcome, `accepted` or `dismissed`, is one `rbac.admin_group_offer` row on the platform trail
 * (with a `setting_key`, so retention keeps the latest) and one on the product's trail. An offer is
 * open until a platform row for it exists. ST-25 removes this file with the column.
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../db/types.js";
import {
  actorColumns,
  actorOf,
  auditStatement,
  platformAuditStatement,
  sql,
} from "../audit.js";
import type { AdminSession } from "../console/session.js";
import { listProducts } from "../products/store.js";

export const OFFER_ACTION = "rbac.admin_group_offer";
/** The group the manifest parser defaults to: never offered. */
export const DEFAULT_ADMIN_GROUP = "admin";

export interface Offer {
  product: string;
  name: string;
  group: string;
}

export type OfferOutcome = "accepted" | "dismissed";

const decidedSql = `EXISTS (SELECT 1 FROM platform_audit WHERE action = '${OFFER_ACTION}' AND target_id = ?)`;

/** Every product that has an offer and no outcome yet. */
export async function openOffers(db: Db): Promise<Offer[]> {
  const products = (await listProducts(db)).filter(
    (p) =>
      p.slug !== SYSTEM_PRODUCT_SLUG &&
      p.admin_group !== null &&
      p.admin_group !== "" &&
      p.admin_group !== DEFAULT_ADMIN_GROUP,
  );
  if (products.length === 0) return [];
  const decided = new Set(
    (
      await db.all<{ target_id: string }>(
        `SELECT DISTINCT target_id FROM platform_audit WHERE action = ? LIMIT 5000`,
        OFFER_ACTION,
      )
    ).map((r) => r.target_id),
  );
  return products
    .filter((p) => !decided.has(p.slug))
    .map((p) => ({ product: p.slug, name: p.name, group: p.admin_group! }));
}

/**
 * The two audit rows of one outcome, each written only while the offer has no outcome (so a
 * double click, or a dismiss racing an accept, records one). The product's row goes first: the
 * platform row is what the guard reads.
 */
export function offerOutcomeStatements(
  session: AdminSession,
  now: number,
  slug: string,
  outcome: OfferOutcome,
  detail: { ruleId?: string; group?: string } = {},
): DbStatement[] {
  const summary =
    outcome === "accepted"
      ? `Accepted the admin group offer for ${slug}`
      : `Dismissed the admin group offer for ${slug}`;
  const guard = sql(`WHERE NOT ${decidedSql}`, slug);
  const actor = actorColumns(actorOf(session));
  return [
    auditStatement(
      {
        product: slug,
        at: now,
        ...actor,
        action: OFFER_ACTION,
        target_kind: "product",
        target_id: slug,
        parent_id: null,
        summary,
      },
      guard,
    ),
    platformAuditStatement(
      {
        at: now,
        ...actor,
        action: OFFER_ACTION,
        target_kind: "product",
        target_id: slug,
        summary,
        before_json: null,
        after_json: JSON.stringify({
          outcome,
          ...(detail.group ? { group: detail.group } : {}),
          ...(detail.ruleId ? { ruleId: detail.ruleId } : {}),
        }),
        setting_key: `admin_group_offer:${slug}`,
      },
      guard,
    ),
  ];
}
