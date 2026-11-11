/**
 * Platform → Issuer keys (I-21.14; plans/I-20.md §8): the key ring of every product that serves
 * Sign in with <Product>, and the emergency rotation.
 *
 *   GET  /api/platform/issuer-keys              each product with a ring: its keys' states and dates
 *   POST /api/platform/issuer-keys/:slug/rotate emergency rotation (Superadmin, step-up; typed slug)
 *
 * The route table (`../routes.ts`) holds the area (`platform`) and the step-up; the handler asks
 * for a Superadmin. Never a sealed half, a private member or a secret in a response. The rotation
 * drops every earlier key at once, so every token they signed stops verifying; it is audited in the
 * product's trail with the actor and the reason (`identity.issuer.key.emergency_rotated`).
 * Admin API routes are narrative-only under AGENTS.md rule 10 (`adminApi` in `routeCoverage.test.ts`).
 */

import { ErrorCode } from "../../core/errors.js";
import { actorOf } from "../../core/audit.js";
import { getProduct } from "../../core/products/store.js";
import { adminJson, err, readBody } from "../../core/console/respond.js";
import { isSuperadmin } from "../../core/rbac/can.js";
import {
  emergencyRotateIssuerKey,
  listIssuerKeys,
  productsWithIssuerKeys,
  readIssuerSetting,
} from "../../services/identity/public.js";
import type { AdminCtx } from "../routes.js";

async function list(c: AdminCtx): Promise<Response> {
  const slugs = await productsWithIssuerKeys(c.db);
  const products = [];
  for (const slug of slugs) {
    const row = await getProduct(c.db, slug);
    if (!row) continue;
    products.push({
      slug,
      name: row.name,
      issuerOn: await readIssuerSetting(c.db, row),
      keys: await listIssuerKeys(c.db, slug),
    });
  }
  return adminJson({ products });
}

export async function handlePlatformIssuerKeys(c: AdminCtx): Promise<Response> {
  const rest = c.segments.slice(2); // after platform/issuer-keys
  if (rest.length === 0) return list(c);
  // `<slug>/rotate`, POST only: the table lists no other.
  if (!isSuperadmin(c.session.principal))
    return err(
      403,
      ErrorCode.Forbidden,
      "Only a Superadmin may rotate an issuer key.",
    );
  const slug = rest[0]!;
  const row = await getProduct(c.db, slug);
  const have = row ? await listIssuerKeys(c.db, slug) : [];
  if (!row || have.length === 0) return err(404, ErrorCode.NotFound);
  const body = await readBody(c.req);
  if (body.confirmSlug !== slug)
    return err(422, ErrorCode.BadRequest, "Type the product slug to confirm.", {
      fields: ["confirmSlug"],
    });
  const reason =
    typeof body.reason === "string" && body.reason.trim() !== ""
      ? body.reason.trim().slice(0, 500)
      : null;
  const out = await emergencyRotateIssuerKey(
    c.env,
    c.db,
    slug,
    actorOf(c.session),
    c.now,
    reason,
  );
  return adminJson({
    ok: true,
    kid: out.kid,
    dropped: out.dropped,
    keys: await listIssuerKeys(c.db, slug),
  });
}
