/// <reference types="@cloudflare/workers-types" />

/**
 * The commerce bridge's admin surface (P6-01) — `/manage/api/products/<slug>/commerce…`:
 *
 *     GET    …/commerce                         settings, store products, setup per
 *                                                            store, recent purchases and events
 *     PUT    …/commerce/settings                replace the settings (`settings.ts`)
 *     POST   …/commerce/settings/<store>/use-assigned
 *                                                            drop that store's typed identity
 *                                                            fields so the assigned app applies
 *     PUT    …/commerce/products                map one store product to a flag (one
 *                                                            the catalog declares, or the
 *                                                            deliverable's delivery gate) and a
 *                                                            deliverable
 *     DELETE …/commerce/products/<store>/<id>   remove a mapping: no new grant for
 *                                                            the product; grants already made
 *                                                            stay, and a later refund or
 *                                                            revocation still revokes every
 *                                                            grant the purchase made (by its
 *                                                            hash, whatever the map says now)
 *
 * Narrative-only like the rest of the console API; platform-admin session, CSRF and rate limit
 * run in `console/api.ts` first. Every write is audited with the session's subject.
 *
 * **Commerce needs License.** A write is refused `409` (reason `commerce_requires_license`) while
 * License is off for the product: a purchase could be verified but never granted, and the store
 * would have taken the player's money for nothing. The public routes are hidden in that state too
 * (`index.ts`).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/console/session.js";
import { adminJson, err, readBody } from "../../core/console/respond.js";
import { audit } from "../../core/audit.js";
import { readActiveCatalog } from "../../core/activeCatalog.js";
import {
  isStore,
  STORES,
  type Store,
} from "../../core/licensing/storeGrants.js";
import {
  listOutletCredentials,
  outletCredentialPin,
} from "../../core/outletCredentials.js";
import {
  PLATFORM_CREDENTIALS,
  platformCredentialsOf,
  platformPin,
  storeAppBinding,
  type PlatformStore,
} from "../../core/platformCredentials.js";
import { listEvents } from "../../core/stores/events.js";
import {
  readStoredCommerceSettings,
  validateCommerceSettings,
  writeCommerceSettings,
  type StoredCommerceSettings,
} from "./settings.js";
import {
  effectiveCommerceSettings,
  type EffectiveCommerce,
} from "./identity.js";
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
import { APP_STORE_EVENTS, PLAY_EVENTS } from "./bridge.js";

type AdminCtx = ServiceContext & { session: AdminSession };

/**
 * An active own credential of the identity slot with no pin, while the product holds a platform
 * pin for that slot: the own key hides the platform pin (D12), so the store has no app. The
 * console says so instead of "no app assigned".
 */
async function ownUnpinnedBlocksPlatformPin(
  db: AdminCtx["db"],
  product: string,
  store: PlatformStore,
  field: string,
): Promise<boolean> {
  const id = platformCredentialsOf(store).find(
    (c) => PLATFORM_CREDENTIALS[c].pinField === field,
  );
  if (!id) return false;
  const own = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === PLATFORM_CREDENTIALS[id].kind,
  );
  if (own.length === 0 || own.some((c) => outletCredentialPin(c) !== null))
    return false;
  return (await platformPin(db, id, product)) !== null;
}

export async function setupOf(
  ctx: Pick<AdminCtx, "env" | "db"> & { product: { slug: string } },
  eff: EffectiveCommerce,
): Promise<
  Record<
    Store,
    { configured: boolean; credential: string | null; reason: string | null }
  >
> {
  const slug = ctx.product.slug;
  const { settings, stored } = eff;
  const one = async (
    block: boolean,
    configured: boolean,
    blocked: () => Promise<boolean>,
    credential: () => Promise<string | null>,
    what: string,
  ) => {
    if (!configured)
      return {
        configured: false,
        credential: null,
        // A block whose identity is neither typed nor assigned (A-28.2); no block: off (D13).
        reason: !block
          ? "no settings for this store"
          : (await blocked())
            ? "own_credential_unpinned"
            : "no_app_assigned",
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
      stored.appStore !== null,
      settings.appStore !== null,
      () => ownUnpinnedBlocksPlatformPin(ctx.db, slug, "app-store", "bundleId"),
      () =>
        appStoreCredential(ctx.env, ctx.db, slug, settings.appStore!.bundleId),
      "app-store-server-key",
    ),
    play: await one(
      stored.play !== null,
      settings.play !== null,
      () =>
        ownUnpinnedBlocksPlatformPin(
          ctx.db,
          slug,
          "google-play",
          "packageName",
        ),
      () => playCredential(ctx.env, ctx.db, slug, settings.play!.packageName),
      "google-service-account",
    ),
    steam: await one(
      stored.steam !== null,
      settings.steam !== null,
      () => ownUnpinnedBlocksPlatformPin(ctx.db, slug, "steam", "appId"),
      () => steamCredential(ctx.env, ctx.db, slug, settings.steam!.appId),
      "steam-publisher-key",
    ),
  };
}

async function view(ctx: AdminCtx) {
  const slug = ctx.product.slug;
  const eff = await effectiveCommerceSettings(ctx.db, slug);
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
    // As stored: the identity fields are what the operator typed (null: derived or unset).
    settings: eff.stored,
    // Which app each store's purchases belong to (A-28.3): the value in force, where it came
    // from, the assigned app, and whether a typed value disagrees with it.
    identity: eff.identity,
    setup: await setupOf(ctx, eff),
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
 * - the deliverable's delivery gate (`dist_access.entitlement`, read through `hooks.delivery().entitlement`): a pack sold as
 *   DLC is mapped to the very flag that gates its download, and that gate is an entitlement name
 *   the catalog need not declare (policy-only gates pass through unpruned, `core/licensing/payload.ts`);
 * - a `flag` entry of the product's active catalog, which the app reads.
 *
 * With no catalog, or one that cannot be read, only the gate is accepted, and the refusal says
 * which: "declares no flag" would be untrue there.
 *
 * Stricter than before CM-29 while Distribution is off: the gate is read through Distribution's
 * hook, which answers `null` then, so a flag that only a delivery gate names is refused until the
 * catalog declares it (or Distribution is on). The refusal says so.
 */
async function flagRefusal(
  db: AdminCtx["db"],
  hooks: AdminCtx["hooks"],
  slug: string,
  flag: string,
  deliverable: string,
): Promise<string | null> {
  // Distribution's gate, through its hook: no gate is read while Distribution is off.
  const delivery = hooks.delivery();
  const gate = await delivery?.entitlement(deliverable);
  if (gate === flag) return null;
  const noGate = delivery
    ? ""
    : " (Distribution is off, so no delivery gate is read)";
  const active = await readActiveCatalog(db, slug);
  if (active.state === "missing")
    return `the product has no catalog to check ${flag} against${noGate}: publish one that declares ${flag} as a flag`;
  if (active.state === "unreadable")
    return `the product's active catalog cannot be read, so ${flag} cannot be checked: publish the catalog again`;
  const declared = active.catalog.entryByKey(flag);
  if (declared?.kind === "flag") return null;
  return declared
    ? `${flag} is a ${declared.kind} key in the catalog, not a flag`
    : `the catalog declares no flag ${flag}`;
}

const PLATFORM_OF = {
  "app-store": "app-store",
  play: "google-play",
  steam: "steam",
} as const satisfies Record<Store, PlatformStore>;

/**
 * `POST …/commerce/settings/<store>/use-assigned` (A-28.3, D14): the server works out the assigned
 * app and the client sends nothing. It deletes that store's typed identity fields (App Store:
 * `bundleId` and `appAppleId`, which name one app; Play: `packageName`; Steam: `appId`), so the
 * assigned app applies; every other field stays. `409 no_assigned_app` when the store has no
 * assigned app to use. A store with no `commerce.stores` block stays off (D13): nothing to clear,
 * and nothing is written. Idempotent: with no typed field left, nothing is written or audited.
 */
async function useAssigned(ctx: AdminCtx, store: Store): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const binding = await storeAppBinding(db, slug, PLATFORM_OF[store]);
  const field = (
    {
      "app-store": "bundleId",
      play: "packageName",
      steam: "appId",
    } as const
  )[store];
  if (!binding.fields[field]?.value)
    return err(
      409,
      ErrorCode.BadRequest,
      "no app is assigned to this product on this store",
      { reason: "no_assigned_app" },
    );
  const stored = await readStoredCommerceSettings(db, slug);
  const before = { ...(storedBlock(stored, store) ?? {}) };
  const typed = identityTyped(store, before);
  if (storedBlock(stored, store) && Object.keys(typed).length > 0) {
    const next: StoredCommerceSettings = {
      appStore: stored.appStore && { ...stored.appStore },
      play: stored.play && { ...stored.play },
      steam: stored.steam && { ...stored.steam },
    };
    if (store === "app-store" && next.appStore) {
      next.appStore.bundleId = null;
      next.appStore.appAppleId = null;
    } else if (store === "play" && next.play) next.play.packageName = null;
    else if (store === "steam" && next.steam) next.steam.appId = null;
    await writeCommerceSettings(db, slug, next, session.sub, now);
    await audit(
      db,
      slug,
      session,
      now,
      "commerce.binding.derived",
      { kind: "commerce", id: slug },
      `Use the assigned ${store} app for ${slug}`,
      {
        before: { store, typed },
        after: { store, typed: {}, assigned: binding.fields[field]!.value },
      },
    );
  }
  return adminJson(await view(ctx));
}

/** The typed identity fields a store block holds (only the non-null ones). */
function identityTyped(
  store: Store,
  block: Record<string, unknown>,
): Record<string, unknown> {
  const keys =
    store === "app-store"
      ? ["bundleId", "appAppleId"]
      : store === "play"
        ? ["packageName"]
        : ["appId"];
  return Object.fromEntries(
    keys.filter((k) => block[k] != null).map((k) => [k, block[k]]),
  );
}

function storedBlock(
  stored: StoredCommerceSettings,
  store: Store,
): Record<string, unknown> | null {
  return ({
    "app-store": stored.appStore,
    play: stored.play,
    steam: stored.steam,
  }[store] ?? null) as Record<string, unknown> | null;
}

export async function handleCommerceAdmin(
  ctx: AdminCtx,
): Promise<Response | null> {
  const { req, db, product, session, now, rest, hooks } = ctx;
  const slug = product.slug;
  if (rest.length === 0) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson(await view(ctx));
  }
  const licenseOn = product.services.license?.enabled === true;

  if (rest.length === 1 && rest[0] === "settings") {
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
      "commerce.settings",
      { kind: "commerce", id: slug },
      `Set the commerce settings of ${slug} (stores: ${on.join(", ") || "none"})`,
    );
    return adminJson(await view(ctx));
  }

  if (
    rest.length === 3 &&
    rest[0] === "settings" &&
    rest[2] === "use-assigned" &&
    isStore(rest[1])
  ) {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!licenseOn) return licenseOff();
    return useAssigned(ctx, rest[1]);
  }
  if (rest[0] === "settings") return null;

  if (rest[0] !== "products") return null;
  if (rest.length === 1) {
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
      hooks,
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
      "commerce.product.set",
      { kind: "store-product", id: `${store}:${body.productId as string}` },
      `Mapped ${store} product ${body.productId as string} to ${body.flag as string} on ${deliverable}`,
    );
    return adminJson(await view(ctx));
  }

  if (rest.length === 3) {
    if (req.method !== "DELETE")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const store = rest[1]!;
    let id: string;
    try {
      id = decodeURIComponent(rest[2]!);
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
      "commerce.product.delete",
      { kind: "store-product", id: `${store}:${id}` },
      `Removed the mapping of ${store} product ${id}`,
    );
    return adminJson(await view(ctx));
  }
  return null;
}
