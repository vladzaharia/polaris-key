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
 *   GET    /api/platform/store-connections/<store>/apps[?refresh=1]
 *          Every app the team credential can see, with its distribution status and the product
 *          holding it. Cached briefly in KV (assignments are joined fresh).
 *   PUT    /api/platform/store-connections/<store>/apps/<appId>/product   `{product}`
 *   DELETE /api/platform/store-connections/<store>/apps/<appId>/product
 *          Assign the app to a product — the product's platform pin (and, for the App Store, the
 *          In-App Purchase key's bundle-id pin), plus a re-pin of any key the product holds of its
 *          own through the existing audited pin path — or release it. Refused (409
 *          `app_assigned_elsewhere`) while another product holds the app, by platform pin or by
 *          its own credential's pin.
 *
 * Every write is audited: platform-level events through `core/platformEvents.ts` (A-12's
 * `platform_audit` once it exists), and an assignment also in the product's own trail
 * (`outlet_credential.pin`). Admin API routes are narrative-only under AGENTS.md rule 10
 * (`adminApi` in `routeCoverage.test.ts`), so there is no OpenAPI entry.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { getProduct } from "../../repo.js";
import {
  listOutletCredentialPins,
  validateOutletCredentialPin,
} from "../../core/outletCredentials.js";
import {
  clearPlatformPin,
  deletePlatformCredential,
  isPlatformStore,
  listPlatformPins,
  platformCredentialBySlot,
  platformCredentialsOf,
  platformCredentialStatus,
  platformPinHolder,
  PLATFORM_CREDENTIALS,
  PLATFORM_STORES,
  primaryPlatformCredential,
  putPlatformCredential,
  resolvePlatformCredential,
  setPlatformPin,
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
import { audit } from "../audit.js";
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
import { repinOwnCredentials } from "./outletCredentials.js";

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

async function listing(
  env: Env,
  db: Db,
  session: AdminSession,
  store: PlatformStore,
  now: number,
  refresh: boolean,
): Promise<PlatformAppsListing | Response> {
  const lister = LISTERS[store];
  if (!lister)
    return err(
      404,
      "not_supported",
      `the ${STORE_LABELS[store]} apps listing is not available`,
    );
  try {
    return await lister({ env, db, actor: actorOf(session), now, refresh });
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
  const refresh = /^(1|true)$/.test(
    new URL(req.url).searchParams.get("refresh") ?? "",
  );
  const l = await listing(env, db, session, store, now, refresh);
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

  const results: Array<{
    credential: PlatformCredentialId;
    pin: string;
    before: string | null;
    changed: boolean;
  }> = [];
  for (const [id, pin] of pins) {
    const r = await setPlatformPin(db, {
      id,
      product: slug,
      pin,
      actor: session.sub,
      now,
    });
    if (!r.ok)
      return err(
        r.status,
        r.status === 409 ? "app_assigned_elsewhere" : ErrorCode.BadRequest,
        r.message,
        r.status === 409 ? { product: r.holder } : undefined,
      );
    results.push({ credential: id, pin, before: r.before, changed: r.changed });
    if (r.changed)
      await audit(
        db,
        slug,
        session,
        now,
        "outlet_credential.pin",
        { kind: "platform_credential", id },
        `Pinned the platform ${PLATFORM_CREDENTIALS[id].label} to ${PLATFORM_CREDENTIALS[id].pinField} ${pin} for this product (was ${r.before ?? "unpinned"})`,
      );
  }
  // The product's own keys take precedence over the team key: pin them to the same app through
  // the existing audited path, so the assignment means the same thing whichever key is used.
  const repinned: string[] = [];
  for (const [id, pin] of pins)
    repinned.push(
      ...(await repinOwnCredentials(
        db,
        slug,
        session,
        now,
        PLATFORM_CREDENTIALS[id].kind,
        pin,
      )),
    );
  if (results.some((r) => r.changed) || repinned.length > 0)
    await appendPlatformEvent(db, {
      actor: actorOf(session),
      at: now,
      action: "store_connection.assign",
      target: { kind: "store_app", id: `${store}:${appId}` },
      summary: `Assigned ${STORE_LABELS[store]} app ${appId}${app.name ? ` (${app.name})` : ""} to product ${slug}`,
      before: Object.fromEntries(results.map((r) => [r.credential, r.before])),
      after: Object.fromEntries(results.map((r) => [r.credential, r.pin])),
    });
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
    ownCredentialsRepinned: repinned,
  });
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
    const pin = await clearPlatformPin(db, id, slug);
    if (pin === null) continue;
    cleared.push({ credential: id, pin });
    await audit(
      db,
      slug,
      session,
      now,
      "outlet_credential.pin",
      { kind: "platform_credential", id },
      `Released the platform ${PLATFORM_CREDENTIALS[id].label} pin ${PLATFORM_CREDENTIALS[id].pinField} ${pin} for this product`,
    );
  }
  await appendPlatformEvent(db, {
    actor: actorOf(session),
    at: now,
    action: "store_connection.unassign",
    target: { kind: "store_app", id: `${store}:${appId}` },
    summary: `Released ${STORE_LABELS[store]} app ${appId} from product ${slug}`,
    before: Object.fromEntries(cleared.map((c) => [c.credential, c.pin])),
  });
  // A key the product holds of its own keeps its pin: re-pin or delete it per product.
  return adminJson({ ok: true, store, appId, product: slug, cleared });
}
