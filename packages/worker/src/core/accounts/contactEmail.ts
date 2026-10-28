/**
 * The shared contact email of a product's people (CC-16.L): the one rule Users (Identity) and the
 * Cloud Connect console read. Core owns it so a service reads it without reaching into another
 * service's tables.
 */

import type { Db } from "../../db/types.js";
import { jsonList, jsonListArg } from "../sqlIn.js";

// ── Consent ──────────────────────────────────────────────────────────────────────────────────

/**
 * The profile claims an account consented to share with one product on "Continue to <App>"
 * (`account_product_grants.claims_json`, written by I-07/I-08). Read leniently, because the writer
 * lands after this reader: a JSON array of claim names, an object of `claim: true`, or
 * `{ "claims": [...] }`. Anything else is no consent.
 */
export function consentedClaims(json: string | null | undefined): Set<string> {
  if (!json) return new Set();
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return new Set();
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.claims)) v = o.claims;
    else
      return new Set(
        Object.entries(o)
          .filter(([, on]) => on === true)
          .map(([k]) => k),
      );
  }
  return Array.isArray(v)
    ? new Set(v.filter((c): c is string => typeof c === "string"))
    : new Set();
}

/** The row's contact: the buyer email first, the consented primary email otherwise. */
export function contactOf(
  buyerEmail: string | null,
  primaryEmail: string | null,
  claims: Set<string>,
): { email: string | null; source: "license" | "consented" | null } {
  if (buyerEmail) return { email: buyerEmail, source: "license" };
  if (primaryEmail && claims.has("email"))
    return { email: primaryEmail, source: "consented" };
  return { email: null, source: null };
}

/**
 * The contact email of each subject (a missing key means none the product may see). The buyer's
 * licence email first; the account's primary email only when `identityOn` and the person consented
 * to share `email` with this product.
 */
export async function contactEmailsFor(
  db: Db,
  product: string,
  subjects: readonly string[],
  opts: { identityOn: boolean },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (subjects.length === 0) return out;
  const rows = await db.all<{
    subject: string;
    buyer_email: string | null;
    primary_email: string | null;
    claims_json: string | null;
  }>(
    `SELECT s.subject,
            (SELECT l.email FROM licenses l
              WHERE l.product = s.product AND l.account_id = s.account_id AND l.email IS NOT NULL
              ORDER BY l.activated_at, l.id LIMIT 1) AS buyer_email,
            a.primary_email AS primary_email,
            g.claims_json AS claims_json
       FROM account_product_subjects s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN account_product_grants g ON g.account_id = s.account_id AND g.product = s.product
      WHERE s.product = ? AND s.subject IN ${jsonList()}`,
    product,
    jsonListArg(subjects),
  );
  for (const r of rows) {
    const c = contactOf(
      r.buyer_email,
      r.primary_email,
      opts.identityOn ? consentedClaims(r.claims_json) : new Set<string>(),
    );
    if (c.email) out.set(r.subject, c.email);
  }
  return out;
}
