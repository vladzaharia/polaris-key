/**
 * The platform store connections (A-16; notes/S-13; owner decision 2026-10-04): ONE team-level
 * connection per store, platform-admin only, product-less.
 *
 *   GET    /api/platform/store-connections
 *          Every store: each credential slot's presence and metadata (source `console` | `secret`,
 *          key id, issuer id, client email, health) — NEVER a key — its settings (the Apple Team
 *          ID, …) and which product holds which app.
 *   PUT    /api/platform/store-connections/<store>                   `{value}`
 *   DELETE /api/platform/store-connections/<store>
 *          Set (validated by the kind's own outlet-credential validator — `validateAscApiKey` for
 *          the App Store) or clear the console credential of the store's PRIMARY slot. Clearing
 *          hands over to the Worker secret if one is set. Echoes metadata only.
 *   PUT    /api/platform/store-connections/<store>/credentials/<slot>   `{value}`
 *   DELETE /api/platform/store-connections/<store>/credentials/<slot>
 *          The same for any slot (`app-store` / `in-app-purchase-key`).
 *   PUT    /api/platform/store-connections/<store>/settings/<key>   `{value}`
 *   DELETE /api/platform/store-connections/<store>/settings/<key>
 *          A non-secret setting (`app-store` / `teamId`).
 *   GET    /api/platform/store-connections/<store>/apps[?refresh=1][&tracks=1]
 *          Every app the team credential can see, with its distribution status and the product
 *          holding it. Cached briefly in KV (assignments are joined fresh).
 *   PUT    /api/platform/store-connections/<store>/apps/<appId>/product   `{product}`
 *   DELETE /api/platform/store-connections/<store>/apps/<appId>/product
 *          Assign the app to a product — the product's platform pin (and, for the App Store, the
 *          In-App Purchase key's bundle-id pin), plus a re-pin of any key the product holds of its
 *          own through the existing audited pin path — or release it. Refused (409
 *          `app_assigned_elsewhere`) while another product holds the app, by platform pin or by
 *          its own credential's pin.
 *   …      /api/platform/store-connections/app-store/{capability-types,bundle-ids[/<id>/capabilities],
 *          apps/lookup,signing,operations}
 *          A-17b's team provisioning on App Store Connect (`platformStoreProvisioning.ts`): every
 *          write through A-17a's write gate and operation ledger, audited `platform.asc.<op>`.
 *
 * Every write is audited: platform-level events through `core/platformEvents.ts` (A-12's
 * `platform_audit`), and an assignment also in the product's own trail
 * (`outlet_credential.pin`). Admin API routes are narrative-only under AGENTS.md rule 10
 * (`adminApi` in `routeCoverage.test.ts`), so there is no OpenAPI entry.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  auditStatement,
  getProduct,
  platformAuditStatement,
} from "../../repo.js";
import { randomId } from "../../crypto.js";
import type { DbStatement } from "../../db/types.js";
import {
  listOutletCredentialPins,
  validateOutletCredentialPin,
} from "../../core/outletCredentials.js";
import {
  deletePlatformCredential,
  isPlatformStore,
  listPlatformPins,
  platformCredentialBySlot,
  platformCredentialsOf,
  platformCredentialStatus,
  platformPin,
  platformPinHolder,
  platformPinWrites,
  PLATFORM_CREDENTIALS,
  PLATFORM_STORES,
  primaryPlatformCredential,
  putPlatformCredential,
  resolvePlatformCredential,
  type PlatformCredentialId,
  type PlatformStore,
} from "../../core/platformCredentials.js";
import {
  deletePlatformStoreSetting,
  platformStoreSettingId,
  platformStoreSettingsView,
  putPlatformStoreSetting,
} from "../../core/platformStoreSettings.js";
import {
  appendPlatformEvent,
  type PlatformEventActor,
} from "../../core/platformEvents.js";
import {
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
} from "../../services/distribution/connectors/platformApps.js";
import { listPlatformAscApps } from "../../services/distribution/connectors/asc/platform.js";
import { listPlatformPlayApps } from "../../services/distribution/connectors/play/platform.js";
import { listPlatformMsStoreApps } from "../../services/distribution/connectors/msstore/platform.js";
import { listPlatformSteamApps } from "../../services/distribution/commerce/steam.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  AdminBodyError,
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";
import { planOwnRepins } from "./outletCredentials.js";
import { routeAscProvisioning } from "./platformStoreProvisioning.js";

const STORE_LABELS: Record<PlatformStore, string> = {
  "app-store": "App Store",
  "google-play": "Google Play",
  "microsoft-store": "Microsoft Store",
  steam: "Steam",
};

export interface ListerOptions {
  env: Env;
  db: Db;
  actor: PlatformEventActor;
  now: number;
  refresh: boolean;
  /** Extra per-app detail that costs store calls with side effects (Play's track status, which
   *  opens and deletes an edit per app). Only on an explicit `?tracks=1`. */
  tracks: boolean;
}

/** Each store's apps lister (the store's own bounded, redirect-free client). */
const LISTERS: Partial<
  Record<PlatformStore, (o: ListerOptions) => Promise<PlatformAppsListing>>
> = {
  "app-store": (o) => listPlatformAscApps({ ...o, use: "asc:platform-apps" }),
  "google-play": (o) =>
    listPlatformPlayApps({ ...o, use: "play:platform-apps" }),
  "microsoft-store": (o) =>
    listPlatformMsStoreApps({ ...o, use: "ms-store:platform-apps" }),
  steam: (o) => listPlatformSteamApps({ ...o, use: "steam:platform-apps" }),
};

function actorOf(session: AdminSession): PlatformEventActor {
  return { sub: session.sub, name: session.name, email: session.email };
}

export async function handlePlatformStoreConnections(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin only");
  try {
    return await route(req, env, db, session, rest, now);
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}

async function route(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  const [store, sub, a, b] = rest;
  if (store === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({
      ok: true,
      stores: await Promise.all(
        PLATFORM_STORES.map((s) => storeView(env, db, s)),
      ),
    });
  }
  if (!isPlatformStore(store)) return notFound();

  // A-17b: the App Store's team provisioning routes (bundle ids, capabilities, app lookup,
  // signing expiry, the team ledger).
  if (store === "app-store") {
    const provisioning = routeAscProvisioning(
      {
        req,
        env,
        db,
        session,
        now,
        holderOf: (appId, bundleId) => ascHolderOf(db, appId, bundleId),
      },
      rest.slice(1),
    );
    if (provisioning) return provisioning;
  }

  if (sub === undefined)
    return credentialWrite(
      req,
      env,
      db,
      session,
      primaryPlatformCredential(store),
      now,
      rest.length === 1,
    );
  if (sub === "credentials" && a !== undefined && rest.length === 3) {
    const id = platformCredentialBySlot(store, a);
    if (!id) return notFound();
    return credentialWrite(req, env, db, session, id, now, true);
  }
  if (sub === "settings" && a !== undefined && rest.length === 3) {
    const id = platformStoreSettingId(store, a);
    if (!id) return notFound();
    return settingWrite(req, db, session, store, id, now);
  }
  if (sub === "apps" && rest.length === 2) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return appsList(req, env, db, session, store, now);
  }
  if (sub === "apps" && a !== undefined && b === "product" && rest.length === 4)
    return assignment(req, env, db, session, store, a, now);
  return notFound();
}

// ── status ───────────────────────────────────────────────────────────────────────────────────

async function storeView(env: Env, db: Db, store: PlatformStore) {
  const credentials = [];
  for (const id of platformCredentialsOf(store))
    credentials.push(await platformCredentialStatus(env, db, id));
  const assignments = new Map<string, Record<string, string>>();
  for (const id of platformCredentialsOf(store))
    for (const p of await listPlatformPins(db, id)) {
      const row = assignments.get(p.product) ?? {};
      row[id] = p.pin;
      assignments.set(p.product, row);
    }
  return {
    store,
    label: STORE_LABELS[store],
    configured: credentials[0]?.configured ?? false,
    primary: primaryPlatformCredential(store),
    credentials,
    settings: await platformStoreSettingsView(env, db, store),
    appsListing: LISTERS[store] !== undefined,
    assignments: [...assignments.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([product, pins]) => ({ product, pins })),
  };
}

// ── credentials ──────────────────────────────────────────────────────────────────────────────

async function credentialWrite(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  id: PlatformCredentialId,
  now: number,
  exact: boolean,
): Promise<Response> {
  if (!exact) return notFound();
  const spec = PLATFORM_CREDENTIALS[id];
  if (req.method === "DELETE") {
    if (!(await deletePlatformCredential(db, id))) return notFound();
    await appendPlatformEvent(db, {
      actor: actorOf(session),
      at: now,
      action: "platform_credential.delete",
      target: { kind: "platform_credential", id },
      summary: `Cleared the console ${spec.label}; ${spec.secretName} applies if set`,
    });
    const after = await resolvePlatformCredential(env, db, id);
    return adminJson({
      ok: true,
      id,
      configured: after !== null,
      source: after?.source ?? null,
    });
  }
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  // A Google key arrives as the JSON file it is; accept that string form for every kind.
  let value: unknown = body.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return err(422, ErrorCode.BadRequest, "value must be a JSON object", {
        fields: ["value"],
      });
    }
  }
  const r = await putPlatformCredential(env, db, {
    id,
    value,
    actor: session.sub,
    now,
  });
  if (!r.ok)
    return err(r.status, ErrorCode.BadRequest, r.message, {
      fields: [`value.${r.field}`],
    });
  await appendPlatformEvent(db, {
    actor: actorOf(session),
    at: now,
    action: "platform_credential.set",
    target: { kind: "platform_credential", id },
    summary: `${r.created ? "Set" : "Rotated"} the console ${spec.label}`,
    // Display metadata only (key id, issuer id, client email): never the key.
    after: r.meta,
  });
  // NEVER echo the value: the id and its display metadata only.
  return adminJson({ ok: true, id, source: "console", meta: r.meta });
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────

async function settingWrite(
  req: Request,
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  id: NonNullable<ReturnType<typeof platformStoreSettingId>>,
  now: number,
): Promise<Response> {
  if (req.method === "DELETE") {
    const before = await deletePlatformStoreSetting(db, id);
    if (before === null) return notFound();
    await appendPlatformEvent(db, {
      actor: actorOf(session),
      at: now,
      action: "platform_store_setting.delete",
      target: { kind: "platform_store_setting", id },
      summary: `Cleared the console ${id}`,
      before,
    });
    return adminJson({ ok: true, store, id });
  }
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const r = await putPlatformStoreSetting(db, id, body.value, session.sub, now);
  if (!r.ok)
    return err(422, ErrorCode.BadRequest, r.message, { fields: ["value"] });
  if (r.before !== r.value)
    await appendPlatformEvent(db, {
      actor: actorOf(session),
      at: now,
      action: "platform_store_setting.set",
      target: { kind: "platform_store_setting", id },
      summary: `Set ${id} to ${r.value}`,
      before: r.before,
      after: r.value,
    });
  return adminJson({ ok: true, store, id, value: r.value });
}

// ── apps ─────────────────────────────────────────────────────────────────────────────────────

/** Who holds each app of a store: platform pins first, then products' own credential pins. */
async function holders(
  db: Db,
  store: PlatformStore,
): Promise<
  Map<string, { product: string; via: "platform" | "own-credential" }>
> {
  const primary = primaryPlatformCredential(store);
  const out = new Map<
    string,
    { product: string; via: "platform" | "own-credential" }
  >();
  for (const p of await listPlatformPins(db, primary))
    out.set(p.pin, { product: p.product, via: "platform" });
  for (const c of await listOutletCredentialPins(
    db,
    PLATFORM_CREDENTIALS[primary].kind,
  ))
    if (!out.has(c.pin))
      out.set(c.pin, { product: c.product, via: "own-credential" });
  return out;
}

/**
 * Which product holds an App Store app or its bundle id (A-17b's shared-bundle confirmation):
 * the app's holder (platform pin, then a product's own key pin), else the holder of the In-App
 * Purchase key's bundle-id pin (platform pin, then a product's own key pin).
 */
async function ascHolderOf(
  db: Db,
  appId: string | null,
  bundleId: string,
): Promise<string | null> {
  if (appId !== null) {
    const h = (await holders(db, "app-store")).get(appId);
    if (h) return h.product;
  }
  const iap: PlatformCredentialId = "app-store.in-app-purchase-key";
  const pinned = await platformPinHolder(db, iap, bundleId);
  if (pinned !== null) return pinned;
  const own = (
    await listOutletCredentialPins(db, PLATFORM_CREDENTIALS[iap].kind)
  ).find((c) => c.pin === bundleId);
  return own?.product ?? null;
}

async function listing(
  env: Env,
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  now: number,
  refresh: boolean,
  tracks = false,
): Promise<PlatformAppsListing | Response> {
  const lister = LISTERS[store];
  if (!lister)
    return err(
      404,
      "not_supported",
      `the ${STORE_LABELS[store]} apps listing is not available`,
    );
  try {
    return await lister({
      env,
      db,
      actor: actorOf(session),
      now,
      refresh,
      tracks,
    });
  } catch (e) {
    if (e instanceof PlatformStoreNotConfigured)
      return err(
        409,
        "not_configured",
        `the platform ${STORE_LABELS[store]} connection has no usable credential: store one in the console or set ${PLATFORM_CREDENTIALS[primaryPlatformCredential(store)].secretName}`,
      );
    if (e instanceof PlatformStoreUnavailable)
      return err(502, "store_unavailable", e.message, { status: e.status });
    throw e;
  }
}

async function appsList(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const refresh = /^(1|true)$/.test(q.get("refresh") ?? "");
  const tracks = /^(1|true)$/.test(q.get("tracks") ?? "");
  const l = await listing(env, db, session, store, now, refresh, tracks);
  if (l instanceof Response) return l;
  const held = await holders(db, store);
  return adminJson({
    ok: true,
    ...l,
    apps: l.apps.map((app) => {
      const h = held.get(app.appId);
      return {
        ...app,
        assignedProduct: h?.product ?? null,
        assignedVia: h?.via ?? null,
      };
    }),
  });
}

// ── assignment ───────────────────────────────────────────────────────────────────────────────

async function assignment(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  rawAppId: string,
  now: number,
): Promise<Response> {
  const primary = primaryPlatformCredential(store);
  const primarySpec = PLATFORM_CREDENTIALS[primary];
  const checked = validateOutletCredentialPin(primarySpec.kind, rawAppId);
  if (!checked.ok) return notFound();
  const appId = checked.value;

  if (req.method === "DELETE") return unassign(db, session, store, appId, now);
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const slug = typeof body.product === "string" ? body.product : "";
  if (!/^[a-z0-9-]+$/.test(slug) || !(await getProduct(db, slug)))
    return err(
      422,
      ErrorCode.BadRequest,
      "product must be an existing product",
      {
        fields: ["product"],
      },
    );

  // The app must be one the team credential can actually see: assignment is from the list.
  const l = await listing(env, db, session, store, now, false);
  if (l instanceof Response) return l;
  const app = l.apps.find((x) => x.appId === appId);
  if (!app)
    return err(
      404,
      "app_not_found",
      `the platform ${STORE_LABELS[store]} credential cannot see app ${appId}`,
    );

  // Every pin this assignment sets, and the refusal if any other product holds one of them.
  const pins: Array<[PlatformCredentialId, string]> = [[primary, appId]];
  for (const [id, pin] of Object.entries(app.pins) as Array<
    [PlatformCredentialId, string]
  >)
    if (id !== primary && platformCredentialsOf(store).includes(id))
      pins.push([id, pin]);
  for (const [id, pin] of pins) {
    const holder = await platformPinHolder(db, id, pin);
    const own = (
      await listOutletCredentialPins(db, PLATFORM_CREDENTIALS[id].kind)
    ).find((c) => c.pin === pin && c.product !== slug);
    const other =
      holder !== null && holder !== slug ? holder : (own?.product ?? null);
    if (other !== null)
      return err(
        409,
        "app_assigned_elsewhere",
        `${PLATFORM_CREDENTIALS[id].pinField} ${pin} is already pinned to product ${other}; release it there first`,
        { product: other },
      );
  }

  // Plan everything first, write it as ONE batch: the pins, the release of a pin the new app does
  // not name, the re-pin of the product's own keys and every audit row — all or nothing.
  const results: Array<{
    credential: PlatformCredentialId;
    pin: string;
    before: string | null;
    changed: boolean;
  }> = [];
  for (const [id, pin] of pins) {
    const before = await platformPin(db, id, slug);
    results.push({ credential: id, pin, before, changed: before !== pin });
  }
  // A pin on another credential of the store that this app does not name (an App Store app the
  // listing shows without a bundle id) would still point at the product's PREVIOUS app: release it.
  const set = new Set(pins.map(([id]) => id));
  const released: Array<{ credential: PlatformCredentialId; pin: string }> = [];
  for (const id of platformCredentialsOf(store)) {
    if (set.has(id)) continue;
    const before = await platformPin(db, id, slug);
    if (before !== null) released.push({ credential: id, pin: before });
  }
  // The product's own keys take precedence over the team key: pin them to the same app through
  // the audited pin path — but only keys of the same store account as the team key.
  const team = (await resolvePlatformCredential(env, db, primary))?.meta ?? {};
  const own = { writes: [] as DbStatement[], repinned: [] as string[] };
  const skipped: Array<{ id: string; reason: string }> = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const [id, pin] of pins) {
    const kind = PLATFORM_CREDENTIALS[id].kind;
    const plan = await planOwnRepins(db, slug, session, now, kind, pin, (m) =>
      sameAccount(kind, m, team),
    );
    own.writes.push(...plan.writes);
    own.repinned.push(...plan.repinned);
    skipped.push(...plan.skipped);
    refused.push(...plan.refused);
  }
  if (refused.length > 0)
    return err(
      409,
      "own_credential_other_account",
      `the product's own credential${refused.length > 1 ? "s" : ""} ${refused.map((r) => r.id).join(", ")} belong${refused.length > 1 ? "" : "s"} to another ${STORE_LABELS[store]} account than the platform's: re-pin or delete ${refused.length > 1 ? "them" : "it"} on the product first`,
      { credentials: refused.map((r) => r.id) },
    );

  const changed =
    results.some((r) => r.changed) ||
    released.length > 0 ||
    own.repinned.length > 0;
  const actorRow = {
    actor_sub: session.sub,
    actor_name: session.name,
    actor_email: session.email,
  };
  const productAudit = (id: PlatformCredentialId, summary: string) =>
    auditStatement({
      product: slug,
      id: randomId("aud"),
      at: now,
      ...actorRow,
      action: "outlet_credential.pin",
      target_kind: "platform_credential",
      target_id: id,
      parent_id: null,
      summary,
    });
  const writes: DbStatement[] = [
    ...platformPinWrites([
      ...results
        .filter((r) => r.changed)
        .map((r) => ({
          id: r.credential,
          product: slug,
          pin: r.pin,
          actor: session.sub,
          now,
        })),
      ...released.map((r) => ({
        id: r.credential,
        product: slug,
        pin: null,
        actor: session.sub,
        now,
      })),
    ]),
    ...results
      .filter((r) => r.changed)
      .map((r) =>
        productAudit(
          r.credential,
          `Pinned the platform ${PLATFORM_CREDENTIALS[r.credential].label} to ${PLATFORM_CREDENTIALS[r.credential].pinField} ${r.pin} for this product (was ${r.before ?? "unpinned"})`,
        ),
      ),
    ...released.map((r) =>
      productAudit(
        r.credential,
        `Released the platform ${PLATFORM_CREDENTIALS[r.credential].label} pin ${PLATFORM_CREDENTIALS[r.credential].pinField} ${r.pin} for this product (the assigned app names none)`,
      ),
    ),
    ...own.writes,
  ];
  if (changed)
    writes.push(
      platformAuditStatement({
        id: randomId("paud"),
        at: now,
        ...actorRow,
        action: "store_connection.assign",
        target_kind: "store_app",
        target_id: `${store}:${appId}`,
        summary: `Assigned ${STORE_LABELS[store]} app ${appId}${app.name ? ` (${app.name})` : ""} to product ${slug}`,
        before_json: JSON.stringify(
          Object.fromEntries([
            ...results.map((r) => [r.credential, r.before]),
            ...released.map((r) => [r.credential, r.pin]),
          ]),
        ),
        after_json: JSON.stringify(
          Object.fromEntries([
            ...results.map((r) => [r.credential, r.pin]),
            ...released.map((r) => [r.credential, null]),
          ]),
        ),
      }),
    );
  if (writes.length > 0) {
    try {
      await db.batch(writes);
    } catch (e) {
      // A racing assignment took the app between the checks and the batch: nothing was written.
      if (/UNIQUE/i.test(e instanceof Error ? e.message : ""))
        return err(
          409,
          "app_assigned_elsewhere",
          `${appId} was just assigned to another product; nothing was changed`,
        );
      throw e;
    }
  }
  return adminJson({
    ok: true,
    store,
    appId,
    product: slug,
    pins: results.map(({ credential, pin, changed }) => ({
      credential,
      pin,
      changed,
    })),
    released,
    ownCredentialsRepinned: own.repinned,
    // Own keys left alone because their store account cannot be told from their metadata (a
    // Google service account with another email, a Steam key): re-pin them on the product.
    ownCredentialsSkipped: skipped,
  });
}

/**
 * Whether an own credential's key belongs to the same store account as the platform's team key,
 * from non-secret metadata only: App Store keys by issuer id (the team), Partner Center by seller
 * id. A Google service account is `same` only with the same email (another one may or may not be
 * in the developer account: `unknown`); a Steam key carries no account id (`unknown`).
 */
function sameAccount(
  kind: string,
  own: Record<string, string>,
  team: Record<string, string>,
): "same" | "different" | "unknown" {
  const by = (field: string, unknownIfDifferent = false) =>
    !own[field] || !team[field]
      ? "unknown"
      : own[field] === team[field]
        ? "same"
        : unknownIfDifferent
          ? "unknown"
          : "different";
  switch (kind) {
    case "asc-api-key":
    case "app-store-server-key":
      return by("issuerId");
    case "ms-partner-center":
      return by("sellerId");
    case "google-service-account":
      return by("clientEmail", true);
    default:
      return "unknown";
  }
}

async function unassign(
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  appId: string,
  now: number,
): Promise<Response> {
  const primary = primaryPlatformCredential(store);
  const slug = await platformPinHolder(db, primary, appId);
  if (slug === null) return notFound();
  const cleared: Array<{ credential: PlatformCredentialId; pin: string }> = [];
  for (const id of platformCredentialsOf(store)) {
    const pin = await platformPin(db, id, slug);
    if (pin !== null) cleared.push({ credential: id, pin });
  }
  const actorRow = {
    actor_sub: session.sub,
    actor_name: session.name,
    actor_email: session.email,
  };
  // One batch: the releases and their audit rows, all or nothing.
  await db.batch([
    ...platformPinWrites(
      cleared.map((c) => ({
        id: c.credential,
        product: slug,
        pin: null,
        actor: session.sub,
        now,
      })),
    ),
    ...cleared.map((c) =>
      auditStatement({
        product: slug,
        id: randomId("aud"),
        at: now,
        ...actorRow,
        action: "outlet_credential.pin",
        target_kind: "platform_credential",
        target_id: c.credential,
        parent_id: null,
        summary: `Released the platform ${PLATFORM_CREDENTIALS[c.credential].label} pin ${PLATFORM_CREDENTIALS[c.credential].pinField} ${c.pin} for this product`,
      }),
    ),
    platformAuditStatement({
      id: randomId("paud"),
      at: now,
      ...actorRow,
      action: "store_connection.unassign",
      target_kind: "store_app",
      target_id: `${store}:${appId}`,
      summary: `Released ${STORE_LABELS[store]} app ${appId} from product ${slug}`,
      before_json: JSON.stringify(
        Object.fromEntries(cleared.map((c) => [c.credential, c.pin])),
      ),
      after_json: null,
    }),
  ]);
  // A key the product holds of its own keeps its pin: re-pin or delete it per product.
  return adminJson({ ok: true, store, appId, product: slug, cleared });
}
