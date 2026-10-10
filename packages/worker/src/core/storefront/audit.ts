/**
 * Before-and-after projection and the audit row of a store write (A-17a's App Store Connect
 * audit, generalised by A-18a; notes/S-14 §7.4, notes/S-15 §6.3).
 *
 *   - **Before and after are the store's own reads**: the natural-key pre-read and the re-read
 *     after the write. Both go through `projectStoreResource`, keyed by (store, resource type):
 *     each adapter's `audit.projection` is an ALLOW-list of attributes per type; a type not listed
 *     keeps only `{ type, id }`.
 *   - **Never stored**, whatever a list says: passwords, secrets, emails, phone numbers, names of
 *     people and contact fields (`REDACTED_KEY`, checked after the allow-list as defence in
 *     depth); testers are projected to their state only, so no email reaches a row (the caller's
 *     summary gives a count). No request body and no vendor error body is stored: a failure keeps
 *     its status and the vendor's error token only.
 *   - **One audit row per write**: product scope appends to the product's `audit`
 *     (`distribution.<action>.<op>`), team scope to `platform_audit` (`platform.<action>.<op>`,
 *     with the projections as `before` / `after`); `<action>` is the adapter's (`asc` for the App
 *     Store). Product audit rows have no before/after columns, so the projections live on the
 *     ledger row, whose `op_id` the summary names.
 */

import type { Db } from "../../db/types.js";
import { audit } from "../console/audit.js";
import type { AdminSession } from "../console/session.js";
import { appendPlatformEvent } from "../ops/platformEvents.js";
import { storefrontAdapter, type StorefrontId } from "./adapter.js";

/** A resource as a store answers it (JSON:API objects; other stores map theirs onto this). */
export interface StoreResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
}

/** Keys never stored, even if a projection lists them (defence in depth). */
const REDACTED_KEY =
  /password|secret|email|phone|contact|firstname|lastname|demoaccount|token/i;

/** The most characters of one projected string value. */
const MAX_VALUE = 300;

/** A projected resource: its type, id and the allowed attributes the store returned. */
export interface StoreProjection {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
}

function projectValue(v: unknown): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v.slice(0, MAX_VALUE);
  // Short lists of tokens (a webhook's event types); nothing nested.
  if (
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((x) => typeof x === "string")
  )
    return v.map((x: string) => x.slice(0, 100));
  return undefined;
}

/** Project one resource through its store's allow-list for its type. `null` in, `null` out. */
export function projectStoreResource(
  store: StorefrontId,
  r: StoreResource | null | undefined,
): StoreProjection | null {
  if (!r || typeof r.type !== "string" || typeof r.id !== "string") return null;
  const projection = storefrontAdapter(store)?.audit.projection ?? {};
  const keep = Object.hasOwn(projection, r.type) ? projection[r.type]! : [];
  const attributes: Record<string, unknown> = {};
  for (const k of keep) {
    if (REDACTED_KEY.test(k)) continue;
    const v = projectValue(r.attributes?.[k]);
    if (v !== undefined) attributes[k] = v;
  }
  return { type: r.type, id: r.id, attributes };
}

export interface StoreAuditEntry {
  store: StorefrontId;
  scope: "team" | "product";
  /** The product slug (product scope only). */
  product: string | null;
  /** The full admin session for product scope (the product audit writer takes one). */
  session: AdminSession;
  now: number;
  /** The operation, e.g. `bundle_id.register`; the action is `<prefix>.<adapter action>.<op>`. */
  op: string;
  /** The store object written (or found). */
  target: { kind: string; id: string } | null;
  summary: string;
  opId: string;
  before: StoreProjection | null;
  after: StoreProjection | null;
}

/** Append the one audit row of a write: the product's trail, or the platform trail. */
export async function recordStoreAudit(
  db: Db,
  e: StoreAuditEntry,
): Promise<void> {
  const adapter = storefrontAdapter(e.store);
  if (!adapter) throw new Error(`unknown storefront ${e.store}`);
  const action = adapter.audit.action;
  const summary = `${e.summary} [op ${e.opId.slice(0, 12)}]`;
  if (e.scope === "product") {
    if (!e.product)
      throw new Error("product-scope store audit without a product");
    await audit(
      db,
      e.product,
      e.session,
      e.now,
      `distribution.${action}.${e.op}`,
      e.target,
      summary,
    );
    return;
  }
  await appendPlatformEvent(db, {
    actor: { sub: e.session.sub, name: e.session.name, email: e.session.email },
    at: e.now,
    action: `platform.${action}.${e.op}`,
    target: e.target,
    summary,
    before: e.before,
    after: e.after,
  });
}
