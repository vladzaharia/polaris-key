/// <reference types="@cloudflare/workers-types" />

/**
 * The commerce bridge's admin surface (P6-01) — `/manage/api/products/<slug>/distribution/commerce…`:
 *
 *     GET    …/distribution/commerce                         settings, store products, setup per
 *                                                            store, recent purchases and events
 *     PUT    …/distribution/commerce/settings                replace the settings (`settings.ts`)
 *     PUT    …/distribution/commerce/products                map one store product to a flag (one
 *                                                            the catalog declares, or the
 *                                                            deliverable's delivery gate) and a
 *                                                            deliverable
 *     DELETE …/distribution/commerce/products/<store>/<id>   remove a mapping: no new grant for
 *                                                            the product; grants already made
 *                                                            stay, and a later refund or
 *                                                            revocation still revokes every
 *                                                            grant the purchase made (by its
 *                                                            hash, whatever the map says now)
 *
 * Narrative-only like the rest of the console API; platform-admin session, CSRF and rate limit
 * run in `admin/api.ts` first. Every write is audited with the session's subject.
 *
 * **Commerce needs License.** A write is refused `409` (reason `commerce_requires_license`) while
 * License is off for the product: a purchase could be verified but never granted, and the store
 * would have taken the player's money for nothing. The public routes are hidden in that state too
 * (`index.ts`).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { ErrorCode } from "../../../core/errors.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../admin/session.js";
import { adminJson, err, readBody } from "../../../admin/lib/respond.js";
import { audit } from "../../../admin/audit.js";
import { readActiveCatalog } from "../../../core/activeCatalog.js";
import { isStore, STORES, type Store } from "../../../core/storeGrants.js";
import { entitlementOf } from "../access.js";
import { listEvents } from "../connectors/state.js";
import {
  readCommerceSettings,
  validateCommerceSettings,
  writeCommerceSettings,
  type CommerceSettings,
} from "./settings.js";
import {
  deleteStoreProduct,
  isDeliverableId,
  isFlag,
  isStoreProductId,
  listStoreProducts,
  recentPurchases,
  upsertStoreProduct,
} from "./state.js";
import { appStoreCredential } from "./apple.js";
import { playCredential } from "./play.js";
import { steamCredential } from "./steam.js";
import { APP_STORE_EVENTS, PLAY_EVENTS } from "./index.js";

type AdminCtx = ServiceContext & { session: AdminSession };

async function setupOf(
  ctx: AdminCtx,
  settings: CommerceSettings,
): Promise<
  Record<
    Store,
    { configured: boolean; credential: string | null; reason: string | null }
  >
> {
  const slug = ctx.product.slug;
  const one = async (
    configured: boolean,
    credential: () => Promise<string | null>,
    what: string,
  ) => {
    if (!configured)
      return {
        configured: false,
        credential: null,
        reason: "no settings for this store",
      };
    const id = await credential();
    return {
      configured: id !== null,
      credential: id,
      reason:
        id === null
          ? `no active ${what} credential pinned to the configured app`
          : null,
    };
  };
  return {
    "app-store": await one(
      settings.appStore !== null,
      () =>
        appStoreCredential(ctx.env, ctx.db, slug, settings.appStore!.bundleId),
      "app-store-server-key",
    ),
    play: await one(
      settings.play !== null,
      () => playCredential(ctx.env, ctx.db, slug, settings.play!.packageName),
      "google-service-account",
    ),
    steam: await one(
      settings.steam !== null,
      () => steamCredential(ctx.env, ctx.db, slug, settings.steam!.appId),
      "steam-publisher-key",
    ),
  };
}

async function view(ctx: AdminCtx) {
  const slug = ctx.product.slug;
  const settings = await readCommerceSettings(ctx.db, slug);
  const events = [
    ...(await listEvents(ctx.db, slug, APP_STORE_EVENTS, 25)),
    ...(await listEvents(ctx.db, slug, PLAY_EVENTS, 25)),
  ]
    .sort((a, b) => b.received_at - a.received_at)
    .map((e) => ({
      connector: e.connector,
      id: e.event_id,
      type: e.event_type,
      outcome: e.outcome,
      receivedAt: e.received_at,
    }));
  return {
    licenseEnabled: ctx.product.services.license?.enabled === true,
    settings,
    setup: await setupOf(ctx, settings),
    products: (await listStoreProducts(ctx.db, slug)).map((p) => ({
      store: p.store,
      productId: p.store_product_id,
      deliverable: p.deliverable_id,
      flag: p.flag,
      modifiedAt: p.modified_at,
      modifiedBy: p.modified_by,
    })),
    purchases: await recentPurchases(ctx.db, slug),
    events,
  };
}

const licenseOff = () =>
  err(
    409,
    ErrorCode.BadRequest,
    "commerce needs License enabled for this product",
    {
      reason: "commerce_requires_license",
    },
  );

/**
 * Why a mapping's flag is refused, or `null` (P0-48). A purchase grants the name it is mapped to,
 * so the name must be one something reads, or the store takes the player's money and unlocks
 * nothing (a typo, or a config key's name). Two names are read:
 *
 * - the deliverable's delivery gate (`dist_access.entitlement`, `entitlementOf`): a pack sold as
 *   DLC is mapped to the very flag that gates its download, and that gate is an entitlement name
 *   the catalog need not declare (policy-only gates pass through unpruned, `core/payload.ts`);
 * - a `flag` entry of the product's active catalog, which the app reads.
 *
 * With no catalog, or one that cannot be read, only the gate is accepted, and the refusal says
 * which: "declares no flag" would be untrue there.
 */
async function flagRefusal(
  db: AdminCtx["db"],
  slug: string,
  flag: string,
  deliverable: string,
): Promise<string | null> {
  if ((await entitlementOf(db, slug, deliverable)) === flag) return null;
  const active = await readActiveCatalog(db, slug);
  if (active.state === "missing")
    return `the product has no catalog to check ${flag} against: publish one that declares ${flag} as a flag`;
  if (active.state === "unreadable")
    return `the product's active catalog cannot be read, so ${flag} cannot be checked: publish the catalog again`;
  const declared = active.catalog.entryByKey(flag);
  if (declared?.kind === "flag") return null;
  return declared
    ? `${flag} is a ${declared.kind} key in the catalog, not a flag`
    : `the catalog declares no flag ${flag}`;
}

export async function handleCommerceAdmin(
  ctx: AdminCtx,
): Promise<Response | null> {
  const { req, db, product, session, now, rest, hooks } = ctx;
  const slug = product.slug;
  if (rest.length === 1) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson(await view(ctx));
  }
  const licenseOn = product.services.license?.enabled === true;

  if (rest.length === 2 && rest[1] === "settings") {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!licenseOn) return licenseOff();
    const v = validateCommerceSettings(await readBody(req));
    if (!v.ok)
      return err(422, ErrorCode.BadRequest, v.message, { fields: [v.field] });
    await writeCommerceSettings(db, slug, v.value, session.sub, now);
    const on = (["appStore", "play", "steam"] as const).filter(
      (k) => v.value[k] !== null,
    );
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.commerce.settings",
      { kind: "commerce", id: slug },
      `Set the commerce settings of ${slug} (stores: ${on.join(", ") || "none"})`,
    );
    return adminJson(await view(ctx));
  }

  if (rest[1] !== "products") return null;
  if (rest.length === 2) {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!licenseOn) return licenseOff();
    const body = await readBody(req);
    if (!isStore(body.store))
      return err(
        422,
        ErrorCode.BadRequest,
        `store must be one of ${STORES.join(", ")}`,
        {
          fields: ["store"],
        },
      );
    const store = body.store;
    if (!isStoreProductId(store, body.productId))
      return err(
        422,
        ErrorCode.BadRequest,
        store === "steam"
          ? "productId must be the DLC's Steam app id"
          : `productId must be the ${store} product id`,
        { fields: ["productId"] },
      );
    if (!isFlag(body.flag))
      return err(
        422,
        ErrorCode.BadRequest,
        "flag must be a licence flag (a short identifier)",
        {
          fields: ["flag"],
        },
      );
    const deliverable =
      body.deliverable === undefined ? APP_DELIVERABLE_ID : body.deliverable;
    if (!isDeliverableId(deliverable))
      return err(
        422,
        ErrorCode.BadRequest,
        "deliverable must be a deliverable id",
        {
          fields: ["deliverable"],
        },
      );
    // A mapping to a deliverable Release does not know would unlock nothing, and mislead.
    const known = (await hooks.releaseCatalog()?.deliverables()) ?? [];
    if (
      deliverable !== APP_DELIVERABLE_ID &&
      !known.some((d) => d.id === deliverable)
    )
      return err(422, ErrorCode.BadRequest, `no deliverable ${deliverable}`, {
        fields: ["deliverable"],
      });
    const refused = await flagRefusal(
      db,
      slug,
      body.flag as string,
      deliverable,
    );
    if (refused)
      return err(422, ErrorCode.BadRequest, refused, { fields: ["flag"] });
    await upsertStoreProduct(db, {
      product: slug,
      store,
      store_product_id: body.productId as string,
      deliverable_id: deliverable,
      flag: body.flag as string,
      modified_at: now,
      modified_by: session.sub,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.commerce.product.set",
      { kind: "store-product", id: `${store}:${body.productId as string}` },
      `Mapped ${store} product ${body.productId as string} to ${body.flag as string} on ${deliverable}`,
    );
    return adminJson(await view(ctx));
  }

  if (rest.length === 4) {
    if (req.method !== "DELETE")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const store = rest[2]!;
    let id: string;
    try {
      id = decodeURIComponent(rest[3]!);
    } catch {
      return err(404, ErrorCode.NotFound, "no such store product");
    }
    if (!isStore(store) || !isStoreProductId(store, id))
      return err(404, ErrorCode.NotFound, "no such store product");
    const n = await deleteStoreProduct(db, slug, store, id);
    if (n === 0) return err(404, ErrorCode.NotFound, "no such store product");
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.commerce.product.delete",
      { kind: "store-product", id: `${store}:${id}` },
      `Removed the mapping of ${store} product ${id}`,
    );
    return adminJson(await view(ctx));
  }
  return null;
}
