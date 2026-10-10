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
import {
  adminJson,
  adminNotFound,
  audit,
  auditStatementFor,
  err,
  readBody,
  settingRefused,
} from "../../core/adminApi.js";
import { writeSettings } from "../../core/settings/write.js";
import {
  planSignInSettingsPatch,
  signInSettingsView,
} from "./signInSettings.js";
import { CLAIM_BY_KEY_SETTING } from "./settings.js";
import {
  getPortalProductSettings,
  listingSettingWrites,
  portalProductSettingsView,
  stmtUpsertPortalProductSettings,
  upsertPortalProductSettings,
  type ListingPatch,
  type PortalProductSettingsView,
  type PortalSettingsPatch,
} from "./portal/repo.js";
import {
  isListingAudience,
  isListingState,
  parseGroupLabels,
  parseOfferPaths,
} from "../../core/storefront/polarisKeyListing.js";

/**
 * The typed confirmation widening the audience to `everyone` needs (S-21 owner decision 5,
 * confirm level L2): the setting's registry key, as the platform-settings route asks for its key.
 */
export const STOREFRONT_AUDIENCE_CONFIRM = "storefront.polarisKey.audience";

export async function handleIdentityAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { rest } = ctx;
  if (rest.length !== 1) return null;
  if (rest[0] === "portal") return handlePortalSettings(ctx);
  if (rest[0] === "sign-in-settings") return handleSignInSettings(ctx);
  return null;
}

/** What the console says when a sign-in setting is refused. */
const SIGN_IN_REFUSAL_COPY: Record<string, string> = {
  type: "That value has the wrong type.",
  empty: "Enter a name, or clear it to use the product's name.",
  too_long: "Use 40 characters or fewer.",
  forbidden_character: "Remove control characters, quotes and angle brackets.",
  reserved: "That name is reserved. Choose your app's own name.",
};

/**
 * `GET|PATCH …/identity/sign-in-settings` (I-12): the settings of sign-in THROUGH this product,
 * which exist only while its Identity toggle is on (S-16 §5.2). With Identity off the route is
 * absent (404), like every other product-scoped identity surface; the platform-level Users page
 * stays reachable either way.
 */
async function handleSignInSettings(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  if (product.services.identity?.enabled !== true) return adminNotFound();
  const ref = { slug: product.slug, name: product.name };
  if (req.method === "GET") {
    return adminJson({ settings: await signInSettingsView(db, ref) });
  }
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const plan = await planSignInSettingsPatch(db, ref, body);
  if (!plan.ok) {
    const first = plan.fields[0]!;
    return err(422, ErrorCode.BadRequest, SIGN_IN_REFUSAL_COPY[first.reason], {
      fields: plan.fields.map((f) => f.field),
      reasons: Object.fromEntries(plan.fields.map((f) => [f.field, f.reason])),
    });
  }
  const target = { kind: "product", id: product.slug };
  const summary = `Updated sign-in settings for ${product.slug}`;
  const current = await getPortalProductSettings(db, product.slug);
  // I-09: claimByKey is `identity.keyEntry.claimByKey`, written through `writeSetting()`; the
  // passthrough name rides in the same batch, so a refused write saves neither.
  if (
    plan.claimByKey !== undefined &&
    plan.claimByKey !== (current.claim_by_key === 1)
  ) {
    if (!ctx.settings)
      throw new Error(
        "the sign-in settings route needs ServiceContext.settings",
      );
    const written = await writeSettings(
      { env: ctx.env, db, registry: ctx.settings },
      [
        {
          key: CLAIM_BY_KEY_SETTING,
          value: plan.claimByKey,
          audit: {
            action: "portal.settings.update",
            target,
            summary: claimByKeySummary(product.slug, plan.claimByKey),
          },
        },
      ],
      {
        actor: {
          sub: session.sub,
          name: session.name ?? null,
          email: session.email ?? null,
        },
        origin: "console",
        now,
        product: product.slug,
        strict: false,
        extra: (guard) => [
          ...(Object.keys(plan.patch).length > 0
            ? [
                stmtUpsertPortalProductSettings(
                  current,
                  product.slug,
                  plan.patch,
                  now,
                  guard,
                ),
              ]
            : []),
          auditStatementFor(
            product.slug,
            session,
            now,
            "identity.signin.settings.update",
            target,
            summary,
            guard,
          ),
        ],
      },
    );
    if (!written.ok) return settingRefused(written);
  } else {
    if (Object.keys(plan.patch).length > 0)
      await upsertPortalProductSettings(db, product.slug, plan.patch, now);
    await audit(
      db,
      product.slug,
      session,
      now,
      "identity.signin.settings.update",
      target,
      summary,
    );
  }
  return adminJson({
    ok: true,
    settings: await signInSettingsView(db, ref),
  });
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
  const patch: PortalSettingsPatch = {};
  const listing: ListingPatch = {};
  const booleans = [
    "portalEnabled",
    "oidcEnabled",
    "magicEnabled",
    "licenseKeyClaimEnabled",
    "releasesEnabled",
    "keyReissueEnabled",
  ] as const;
  const fields: string[] = [];
  for (const key of booleans) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") fields.push(key);
    else patch[key] = body[key];
  }
  // I-09: `claimByKey` is the registry setting `identity.keyEntry.claimByKey`, written through
  // `writeSetting()` (a console claim on a manifest-declared value).
  let claimByKey: boolean | undefined;
  if (body.claimByKey !== undefined) {
    if (typeof body.claimByKey !== "boolean") fields.push("claimByKey");
    else claimByKey = body.claimByKey;
  }
  // The legacy Discover switch is the listing state now (PS-02 dual-write).
  if (body.discoverEnabled !== undefined) {
    if (typeof body.discoverEnabled !== "boolean")
      fields.push("discoverEnabled");
    else listing.discoverEnabled = body.discoverEnabled;
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
  // PS-02: the Polaris Key listing state (S-21 §6.2). Accepted here until ST-05's generic
  // settings API exists; the registry entries are `storefront.polarisKey.*`.
  if (body.storeListed !== undefined) {
    if (isListingState(body.storeListed))
      listing.storeListed = body.storeListed;
    else fields.push("storeListed");
  }
  if (body.storeAudience !== undefined) {
    if (isListingAudience(body.storeAudience))
      listing.storeAudience = body.storeAudience;
    else fields.push("storeAudience");
  }
  if (body.storeOfferPaths !== undefined) {
    const paths = parseOfferPaths(body.storeOfferPaths);
    if (paths === undefined) fields.push("storeOfferPaths");
    else listing.storeOfferPaths = paths;
  }
  if (body.storeGroupLabels !== undefined) {
    const labels = parseGroupLabels(body.storeGroupLabels);
    if (labels === undefined) fields.push("storeGroupLabels");
    else listing.storeGroupLabels = labels;
  }
  if (fields.length > 0) {
    return err(422, ErrorCode.BadRequest, "invalid portal settings", {
      fields,
    });
  }

  const current = await getPortalProductSettings(db, slug);
  const before = portalProductSettingsView(current);
  if (
    listing.storeAudience === "everyone" &&
    before.storeAudience !== "everyone" &&
    body.confirm !== STOREFRONT_AUDIENCE_CONFIRM
  )
    return err(
      400,
      ErrorCode.BadRequest,
      `type ${STOREFRONT_AUDIENCE_CONFIRM} to confirm`,
      { reason: "confirm_required", level: "L2" },
    );

  // ST-04: the listing values are registry settings (`storefront.polarisKey.*`), written through
  // `writeSetting()` with one `storefront.polarisKey.update` row per value that changes; the
  // portal switches and branding ride in the same batch with the `portal.settings.update` row.
  // A bespoke route with no version in its contract: compatibility mode (ST-05: an alias).
  const target = { kind: "product", id: slug };
  const writes = listingSettingWrites(current, listing).map((w) => ({
    ...w,
    audit: {
      action: "storefront.polarisKey.update",
      target,
      summary: `Changed the Polaris Key listing for ${slug}: ${describeListingChange(before, w.key, w.value)}`,
    },
  }));
  if (claimByKey !== undefined && claimByKey !== (current.claim_by_key === 1))
    writes.push({
      key: CLAIM_BY_KEY_SETTING,
      value: claimByKey,
      audit: {
        action: "portal.settings.update",
        target,
        summary: claimByKeySummary(slug, claimByKey),
      },
    });
  const portalSummary = `Updated portal settings for ${slug}`;
  if (writes.length === 0) {
    await upsertPortalProductSettings(db, slug, patch, now);
    await audit(
      db,
      slug,
      session,
      now,
      "portal.settings.update",
      target,
      portalSummary,
    );
  } else {
    if (!ctx.settings)
      throw new Error(
        "the portal settings route needs ServiceContext.settings",
      );
    const written = await writeSettings(
      { env: ctx.env, db, registry: ctx.settings },
      writes,
      {
        actor: {
          sub: session.sub,
          name: session.name ?? null,
          email: session.email ?? null,
        },
        origin: "console",
        now,
        product: slug,
        strict: false,
        extra: (guard) => [
          stmtUpsertPortalProductSettings(current, slug, patch, now, guard),
          auditStatementFor(
            slug,
            session,
            now,
            "portal.settings.update",
            target,
            portalSummary,
            guard,
          ),
        ],
      },
    );
    if (!written.ok) return settingRefused(written);
  }
  return adminJson({
    ok: true,
    settings: portalProductSettingsView(
      await getPortalProductSettings(db, slug),
    ),
  });
}

/** The audit summary of a claimByKey change (I-09): turning it on lets a leaked key claim. */
function claimByKeySummary(slug: string, on: boolean): string {
  return on
    ? `Allowed adding ${slug} licenses by key without the purchase email`
    : `Required the purchase email to add ${slug} licenses by key`;
}

/** One listing value's change, as `name before → after`; group labels are counted, never quoted. */
function describeListingChange(
  before: PortalProductSettingsView,
  key: string,
  value: unknown,
): string {
  const paths = (v: readonly string[] | null) =>
    v === null ? "all" : v.length === 0 ? "none" : v.join(", ");
  switch (key) {
    case "storefront.polarisKey.listed":
      return `listing ${before.storeListed} → ${String(value)}`;
    case "storefront.polarisKey.audience":
      return `audience ${before.storeAudience} → ${String(value)}`;
    case "storefront.polarisKey.offerPaths":
      return `ways to obtain ${paths(before.storeOfferPaths)} → ${paths(value as string[] | null)}`;
    default:
      return `group labels for ${Object.keys(value as object).length} group(s)`;
  }
}
