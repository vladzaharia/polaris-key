/// <reference types="@cloudflare/workers-types" />

/**
 * Identity's admin surface — `GET|PATCH /manage/api/products/<slug>/identity/portal` (§R1).
 *
 * The customer-portal module settings: which sign-in methods a product's portal offers, whether
 * it shows releases, whether an OIDC identity auto-links to a licence, and its branding blob.
 * They are Identity's because `portal_product_settings` is Identity's table (spec §5.2) and
 * because every switch on the form is a statement about how a HUMAN signs in to this product.
 *
 * Moved here verbatim from `admin/handlers/products.ts`. The console's pre-namespace spelling
 * `/manage/api/products/<slug>/portal` is GONE, not rewritten: the transitional alias was deleted
 * once the console migrated in P7, and `admin/api.ts` now lets that bare spelling fall through to
 * the same 404 every other unknown resource gets. `identity/portal` is the only way in.
 *
 * The OIDC half of spec §4.2's `identity/{oidc,portal}` is not here yet: product OIDC has no
 * admin editor today (it is manifest-fed through `linkRepo`/`resync`), so there is nothing to
 * regroup. Adding it is one more branch in this file.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { adminJson, audit, err, readBody } from "../../core/adminApi.js";
import {
  getPortalProductSettings,
  portalProductSettingsView,
  upsertPortalProductSettings,
} from "./portal/repo.js";

export async function handleIdentityAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { rest } = ctx;
  if (rest.length !== 1 || rest[0] !== "portal") return null;
  return handlePortalSettings(ctx);
}

async function handlePortalSettings(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;

  if (req.method === "GET") {
    const settings = await getPortalProductSettings(db, slug);
    return adminJson({ settings: portalProductSettingsView(settings) });
  }
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const patch: Parameters<typeof upsertPortalProductSettings>[2] = {};
  const booleans = [
    "portalEnabled",
    "oidcEnabled",
    "magicEnabled",
    "licenseKeyClaimEnabled",
    "releasesEnabled",
    "keyReissueEnabled",
    "claimByKey",
    "discoverEnabled",
  ] as const;
  const fields: string[] = [];
  for (const key of booleans) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") fields.push(key);
    else patch[key] = body[key];
  }
  // R5-01/R5-02 — tri-state, so an operator can override the issuer-derived default in either
  // direction: `null` restores "auto" (on for platform-issuer products, OFF for products on a
  // tenant-controlled 'custom' issuer, whose email/sub claims are outside the trust boundary).
  if (body.autoLinkEnabled !== undefined) {
    if (body.autoLinkEnabled === null) patch.autoLinkEnabled = null;
    else if (typeof body.autoLinkEnabled === "boolean")
      patch.autoLinkEnabled = body.autoLinkEnabled;
    else fields.push("autoLinkEnabled");
  }
  if (body.branding !== undefined) patch.branding = body.branding;
  if (fields.length > 0) {
    return err(422, ErrorCode.BadRequest, "invalid portal settings", {
      fields,
    });
  }

  const settings = await upsertPortalProductSettings(db, slug, patch, now);
  await audit(
    db,
    slug,
    session,
    now,
    "portal.settings.update",
    { kind: "product", id: slug },
    `Updated portal settings for ${slug}`,
  );
  return adminJson({
    ok: true,
    settings: portalProductSettingsView(settings),
  });
}
