/// <reference types="@cloudflare/workers-types" />

/**
 * What the Cloud Sync device routes share (U-05.12; WIRE-CONTRACT-V4 §13.1): the caller, the
 * `account_required` answer, the catalog's migrations, and the mapping of the object's refusals.
 *
 * ── THE CALLER ───────────────────────────────────────────────────────────────────────────────
 *
 * Bearer only. `validateDeviceToken` is the one credential check (a session cookie is never read,
 * so a cookie-only request is a plain `401`); `X-PKey-Device` must then name the device the token
 * belongs to. The principal is `syncAccess(...).subject`: the device's pairwise subject, resolved
 * server-side. No route reads a subject or an account id from the request.
 *
 * ── THE OBJECT'S REFUSALS ARE NEVER COPIED ───────────────────────────────────────────────────
 *
 * `CloudSyncDoError.code` is the object's internal vocabulary (`absorbed`, `pin_mismatch`, …). It
 * is mapped here to a fixed set of answers and never placed in a response: `absorbed` (410) means
 * the subject this request resolved was merged away while the request ran, so the caller
 * re-resolves and retries once, and a second `absorbed` is a retryable `503 unavailable`.
 */

import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { bearer } from "../../../platform/http.js";
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import {
  isValidClientDeviceId,
  validateDeviceToken,
} from "../../../core/devices.js";
import type { DeviceRow } from "../../../core/repo.js";
import type { Product } from "../../../core/products.js";
import { getActiveSchema, getProduct } from "../../../core/products/store.js";
import { buildSignInUrl } from "../../../core/licensing/manageUrl.js";
import {
  syncAccess,
  type SyncAccess,
} from "../../../core/accounts/syncAccess.js";
import {
  knownPlatform,
  platformFamily,
} from "../../../core/devices/platformFamily.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import type { SyncEncryptionMode } from "@polaris-key/protocol/sync";
import type { CatalogMigrations } from "../engine/types.js";
import { resolveKey } from "../engine/migrations.js";
import { CloudSyncDoError } from "../do/client.js";

export interface SyncCaller {
  device: DeviceRow;
  access: SyncAccess;
  /** The device row's platform family: the home of its `platform`-scope rows. */
  family: string;
  /** The device row's own platform, if it is one of the closed set; else null (the directory's "last platform seen"). */
  platform: string | null;
}

/** The refusal to send when the device has no Cloud Sync principal (§13.1). */
export async function accountRequired(
  env: Env,
  db: Db,
  req: Request,
  product: Product,
): Promise<Response> {
  return json(
    {
      error: {
        code: ErrorCode.AccountRequired,
        message: "Sign in to use Cloud Sync.",
        signInUrl: await buildSignInUrl(env, db, req, product),
      },
    },
    { status: 403 },
  );
}

/**
 * Token, then device header, then principal. `401` for a missing, malformed or unknown token or a
 * header naming another device; `400` for a missing or malformed `X-PKey-Device`; `403
 * account_required` for a device with no principal.
 */
export async function authenticateSync(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<SyncCaller | Response> {
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);
  const header = req.headers.get(HEADER_DEVICE);
  if (!isValidClientDeviceId(header))
    return wireError(400, ErrorCode.BadRequest);
  if (header !== valid.device.device_id)
    return wireError(401, ErrorCode.Unauthorized);
  const access = await syncAccess(env, db, product, valid.device, now);
  if (!access) return accountRequired(env, db, req, product);
  return {
    device: valid.device,
    access,
    family: platformFamily(valid.device.platform),
    platform: knownPlatform(valid.device.platform),
  };
}

/**
 * The product row is read again right before the object is called (SR-2): a product deleted
 * since the router loaded it must not reach, or create, an object after its purge. `false` means
 * answer `404`.
 */
export async function productStillLive(db: Db, slug: string): Promise<boolean> {
  return (await getProduct(db, slug)) !== null;
}

export const productGone = (): Response => notFound();

/** A retryable answer for an object that could not serve the request right now. */
export function retryable(): Response {
  const res = wireError(503, "unavailable");
  res.headers.set("retry-after", "5");
  return res;
}

/**
 * The answer for an object failure that is not `absorbed`. The object's code stays in the
 * Worker: `unbound` (no namespace) and a 5xx are retryable, anything else is a Worker bug (500).
 */
export function objectFailure(e: unknown): Response {
  if (e instanceof CloudSyncDoError) {
    if (e.status >= 500 || e.code === "unbound") return retryable();
    return wireError(500, "internal_error");
  }
  throw e;
}

/** The object says the resolved subject was merged away (410 `absorbed`). */
export const isAbsorbed = (e: unknown): boolean =>
  e instanceof CloudSyncDoError && e.status === 410 && e.code === "absorbed";

// ── The catalog's migrations (rule 6) ────────────────────────────────────────────────────────

export interface CatalogView {
  /** The active catalog's `schemaVersion`. */
  catalogVersion: number;
  migrations: CatalogMigrations;
  /** Old key → its current name, for every rename that is not also dropped. */
  aliases: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `cloudSync.migrations` of the product's active catalog, as the engine's maps. A migration whose
 * `toSchemaVersion` the catalog has not reached is not applied; a catalog that cannot be read has
 * no migrations (the pull still serves). Maps, not objects, so a key named `__proto__` is data.
 */
export async function catalogView(
  db: Db,
  product: Pick<Product, "slug" | "schemaVersion">,
  /** The active catalog row, when the caller already read it (the push reads it once). */
  loaded?: { catalog_json: string } | null,
): Promise<CatalogView> {
  const renamedTo = new Map<string, string>();
  const dropped = new Set<string>();
  let catalogVersion = product.schemaVersion;
  const row =
    loaded === undefined ? await getActiveSchema(db, product.slug) : loaded;
  if (row) {
    try {
      const catalog: unknown = JSON.parse(row.catalog_json);
      if (isRecord(catalog)) {
        if (Number.isSafeInteger(catalog.schemaVersion))
          catalogVersion = catalog.schemaVersion as number;
        const cs = catalog.cloudSync;
        const list =
          isRecord(cs) && Array.isArray(cs.migrations) ? cs.migrations : [];
        const steps = list
          .filter(isRecord)
          .filter(
            (m) =>
              Number.isSafeInteger(m.toSchemaVersion) &&
              (m.toSchemaVersion as number) <= catalogVersion,
          )
          .sort(
            (a, b) =>
              (a.toSchemaVersion as number) - (b.toSchemaVersion as number),
          );
        for (const m of steps) {
          if (isRecord(m.rename))
            for (const [from, to] of Object.entries(m.rename))
              if (typeof to === "string") renamedTo.set(from, to);
          if (Array.isArray(m.drop))
            for (const k of m.drop) if (typeof k === "string") dropped.add(k);
        }
      }
    } catch {
      // An unreadable catalog has no migrations.
    }
  }
  const migrations: CatalogMigrations = { renamedTo, dropped };
  const aliases: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const from of renamedTo.keys()) {
    const r = resolveKey(from, migrations);
    if (r.kind === "renamed") aliases[from] = r.to;
  }
  return { catalogVersion, migrations, aliases: { ...aliases } };
}

// ── The product's mode (WIRE-CONTRACT-V5 §13.10.1) ───────────────────────────────────────────

/**
 * What a request is served as, and what it says about it.
 *
 *   serve      the mode the push and pull run in. `"e2e"` only when the operator's launch gate
 *              `launch.syncE2e` is on and the catalog says `e2e` (the default). With the gate off
 *              nothing is sealed or accepted as `ct`: the Worker behaves as before E2E existed.
 *   advertise  the `encryption` member of discovery and of a pull. Absent with the gate off, so
 *              an app that requires E2E stays local (`unsupported`) rather than sending
 *              plaintext to a Worker that cannot take `ct`.
 */
export interface SyncMode {
  serve: SyncEncryptionMode;
  advertise?: SyncEncryptionMode;
}

/** The catalog's `cloudSync.encryption`; an unreadable catalog answers `e2e`, never plaintext. */
export function catalogEncryption(
  loaded: { catalog_json: string } | null,
): SyncEncryptionMode {
  if (!loaded) return "e2e";
  try {
    const catalog: unknown = JSON.parse(loaded.catalog_json);
    if (!isRecord(catalog)) return "e2e";
    const cs = catalog.cloudSync;
    // The same rule as `cloudSyncEncryption` (shared-catalog): `server` only when declared.
    return isRecord(cs) && cs.encryption === "server" ? "server" : "e2e";
  } catch {
    return "e2e";
  }
}

/**
 * Whether the active catalog declares at least one collection (`cloudSync.collections`): the only
 * condition under which discovery says `collections: true` (WIRE-CONTRACT-V5 §13.5). A catalog
 * that cannot be read declares none.
 */
export function catalogDeclaresCollections(
  loaded: { catalog_json: string } | null,
): boolean {
  if (!loaded) return false;
  try {
    const catalog: unknown = JSON.parse(loaded.catalog_json);
    if (!isRecord(catalog)) return false;
    const cs = catalog.cloudSync;
    return (
      isRecord(cs) && Array.isArray(cs.collections) && cs.collections.length > 0
    );
  } catch {
    return false;
  }
}

export async function syncMode(
  env: Env,
  db: Db,
  slug: string,
  loaded?: { catalog_json: string } | null,
): Promise<SyncMode> {
  if (!(await launchGateOn(env, db, "launch.syncE2e")))
    return { serve: "server" };
  const row = loaded === undefined ? await getActiveSchema(db, slug) : loaded;
  const mode = catalogEncryption(row);
  return { serve: mode, advertise: mode };
}
