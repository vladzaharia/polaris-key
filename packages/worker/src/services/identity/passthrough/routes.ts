/**
 * The two browser-facing passthrough reads (WIRE-CONTRACT-V4 §12.7.2, §12.7.3; plans/PX-W13.md
 * §2.2, §2.3), dispatched by the portal API (`portal/api.ts`):
 *
 *   GET /api/signin/requests/:handle           the request: the client record, the device label
 *                                              and the user code. Needs the binder, not a session
 *                                              (the card shows it before anyone signs in).
 *   GET /api/signin/requests/:handle/consent   app consent: what the app gets if the person
 *                                              continues. Needs the account session AND the binder.
 *
 * Both are same-origin JSON with `cache-control: no-store`. A handle that is unknown, expired,
 * presented without its binder, or for a product whose Identity toggle is off answers
 * `404 not_found`, every time in the same shape. Neither reads a display query parameter:
 * `appName`, `name`, `icon`, `developer`, `origin` and `device` mean nothing here.
 *
 * "App consent" is `account_product_grants` (I-05's table, D19/D22). It is not S-19's grants
 * (the reasons for entitlements); every new type and route here says "app consent" (§8 Q6).
 */

import type { SettingsRegistry } from "../../../core/settings/registry.js";
import type {
  AppConsentView,
  ConsentItem,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import type { PortalHooksFor } from "../portal/api.js";
import { getPortalAccount } from "../portal/repo.js";
import { avatarUrl } from "../card/avatars.js";
import { licenseConsentItem } from "./anchor.js";
import { licenseChoiceView, replaceView } from "./choice.js";
import { clientRecordFor, cloudSyncOn } from "./client.js";
import { readSignInRequest } from "./request.js";

/** The profile claims an app may receive (D19); the consent list names all three. */
export const CONSENT_PROFILE_CLAIMS = ["name", "picture", "email"] as const;

type Reply = { status: 200; body: unknown } | { status: 404 };

export async function liveRequest(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  now: number,
) {
  const record = await readSignInRequest(env, req, handle, now);
  if (!record) return null;
  const product = await loadProductPublic(db, record.product);
  // Passthrough exists only with the product's Identity toggle on (S-16, I-04).
  if (!product || !product.services.identity.enabled) return null;
  return { record, product };
}

/** `GET /api/signin/requests/:handle`. */
export async function signInRequestView(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Reply> {
  const live = await liveRequest(env, db, req, handle, now);
  if (!live) return { status: 404 };
  const { record, product } = live;
  const view: SignInRequestView = {
    request: handle,
    client: await clientRecordFor(env, db, product, record.kind, now, hooksFor),
    deviceLabel: record.deviceLabel,
    userCode: record.userCode,
    expiresAt: record.expiresAt,
    // I-08 (§12.4): what `authorize` carried. Hints prefill the card and verify nothing.
    ...(record.authz
      ? {
          purpose: record.authz.purpose,
          licenseChoice: record.authz.licenseChoice,
          scope: record.authz.scope,
          loginHint: record.authz.loginHint,
          nameHint: record.authz.nameHint,
        }
      : {}),
  };
  return { status: 200, body: view };
}

/** The canonical scope an app consent covers, and its hash (§12.7.3). */
export async function consentScope(
  claims: readonly string[],
  services: readonly string[],
): Promise<string> {
  // Sorted members, sorted arrays, no whitespace: one byte string per scope.
  const canonical = JSON.stringify({
    claims: [...claims].sort(),
    services: [...services].sort(),
    v: 1,
  });
  return hashKey(canonical);
}

function consentServices(license: boolean, cloudSync: boolean): string[] {
  return [...(license ? ["license"] : []), ...(cloudSync ? ["cloudSync"] : [])];
}

/** The hash of what the product asks an app consent to cover (what the consent view shows). */
export function askedScopeHash(product: ProductPublic): Promise<string> {
  return consentScope(
    CONSENT_PROFILE_CLAIMS,
    consentServices(product.services.license.enabled, cloudSyncOn(product)),
  );
}

/**
 * What an app consent covers for this account and product, and whether one stands: the one
 * reading the card's consent view and the exchange's `confirm` (I-13.5) share. `scopeHash` is
 * {@link askedScopeHash}; only a change of claims or services re-asks (§8 Q5), so a new anchor
 * licence or new grants do not.
 */
export async function consentState(
  env: Env,
  db: Db,
  product: ProductPublic,
  accountId: string,
  now: number,
  settings?: SettingsRegistry,
): Promise<{
  items: ConsentItem[];
  scopeHash: string;
  firstTime: boolean;
  changed: boolean;
  /** The claims the person granted, when a consent row stands (else `null`). */
  claims: string[] | null;
}> {
  const license = product.services.license.enabled;
  const cloudSync = cloudSyncOn(product);
  const items: ConsentItem[] = [];
  if (license)
    items.push(
      await licenseConsentItem(db, accountId, product, now, {
        env,
        registry: settings,
      }),
    );
  if (cloudSync) items.push({ kind: "cloudSync" });
  items.push({ kind: "profile", claims: [...CONSENT_PROFILE_CLAIMS] });
  const scopeHash = await askedScopeHash(product);
  const grant = await db.first<{
    scope_hash: string | null;
    claims_json: string;
  }>(
    "SELECT scope_hash, claims_json FROM account_product_grants WHERE account_id = ? AND product = ?",
    accountId,
    product.slug,
  );
  return {
    items,
    scopeHash,
    firstTime: grant === null,
    // A consent recorded before scopes were (`scope_hash` NULL) asks once more, to record one.
    changed: grant !== null && grant.scope_hash !== scopeHash,
    claims: grant ? parseClaims(grant.claims_json) : null,
  };
}

function parseClaims(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** `GET /api/signin/requests/:handle/consent`, for the signed-in `accountId`. */
export async function signInConsentView(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  accountId: string,
  now: number,
  /** The settings registry (ST-04), for the product's entitlement model; absent reads `legacy`. */
  settings?: SettingsRegistry,
): Promise<Reply> {
  const live = await liveRequest(env, db, req, handle, now);
  if (!live) return { status: 404 };
  const { product } = live;
  const account = await getPortalAccount(db, accountId, now);
  if (!account) return { status: 404 };

  const { items, scopeHash, firstTime, changed } = await consentState(
    env,
    db,
    product,
    account.id,
    now,
    settings,
  );
  const view: AppConsentView = {
    request: handle,
    person: {
      displayName: account.display_name,
      email: account.primary_email,
      // PX-W16 (G32): the picture in use, the same record Account → Profile edits; null shows
      // initials.
      avatarUrl: avatarUrl(account.avatar_key ?? null),
    },
    items,
    scopeHash,
    firstTime,
    changed,
  };
  return { status: 200, body: view };
}

/**
 * `GET /api/signin/requests/:handle/licenses` (I-08b, §12.4.1): the licence choice for the signed-in
 * account, as the card renders it. A browser has no device yet, so `keep` is never offered here.
 */
export async function signInLicensesView(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  accountId: string,
  now: number,
): Promise<Reply> {
  const live = await liveRequest(env, db, req, handle, now);
  if (!live) return { status: 404 };
  const account = await getPortalAccount(db, accountId, now);
  if (!account) return { status: 404 };
  const cx = { env, db, product: live.product, now };
  return {
    status: 200,
    body: await licenseChoiceView(cx, req, accountId, {
      deviceId: null,
      card: { handle, deviceLabel: live.record.deviceLabel },
    }),
  };
}

/**
 * `GET /api/signin/requests/:handle/licenses/:licenseId/devices` (I-08b, §12.4.1): the seat-holding
 * devices Replace could free. One `404` for every licence that is not a full one of this account's.
 */
export async function signInReplaceView(
  env: Env,
  db: Db,
  req: Request,
  handle: string,
  licenseId: string,
  accountId: string,
  now: number,
): Promise<Reply> {
  const live = await liveRequest(env, db, req, handle, now);
  if (!live) return { status: 404 };
  const account = await getPortalAccount(db, accountId, now);
  if (!account) return { status: 404 };
  const view = await replaceView(
    { env, db, product: live.product, now },
    accountId,
    licenseId,
    { deviceId: null },
  );
  return view ? { status: 200, body: view } : { status: 404 };
}
