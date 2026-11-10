/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/token`, grant `authorization_code` (WIRE-CONTRACT-V4 §12.5; plans/I-27.md
 * §2.1, plans/I-08.md §3).
 *
 * The app redeems the code Continue handed it, with the PKCE verifier, and gets a device token.
 * The body is form-encoded (a JSON body is `invalid_request`), the answer is `no-store`, CORS
 * answers only the product's `web.origins` and never with credentials (`core/cors.ts`,
 * the `cors: true` row of `identity/token`). It needs `X-PKey-Device`; the device metadata
 * headers are read when present, as on `license/activate`.
 *
 * ── THE ORDER ───────────────────────────────────────────────────────────────────────────────
 *
 *   shape checks that cannot burn a code (method, content type, parameters, device id), then the
 *   code is REDEEMED: one atomic consume against the hash of the challenge derived from the
 *   verifier. A match or a mismatch both end the code (`code.ts`), so a wrong verifier cannot be
 *   guessed at and a second redemption finds nothing. Only then are `client_id` and
 *   `redirect_uri` compared with what the code was issued for, and the account re-checked: the
 *   code lives 60 seconds and the account may have been disabled or erased since Continue.
 *
 * ── THE DEVICE BINDING ──────────────────────────────────────────────────────────────────────
 *
 * Continue knew the person and not the device; the device binds here (D5). With the licence the
 * person chose at Continue, `bindSignedInDevice` claims a seat (seat-checked, `bound_by =
 * 'signin'`, the pairwise subject written). With none to choose, the device is bound licence-less
 * (`registerDeviceBinding`), and `license` is `null`. A device id already holding a licence is
 * never taken over without a choice (`license_choice_required`); keeping a licence the device
 * runs on needs the device's own token in `Authorization: Bearer`: with that proof the sign-in
 * binds the account to the device where it stands and answers the token the device already holds.
 *
 * A code the card's key route issued (`kind: "key"`, LK-SKIP, §12.4.2) names a key and no
 * account: `redeemKeyReturn` binds the device by key, as `license/activate` does, and answers
 * `via: "key"`.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Flat RFC 6749 §5.2 bodies for the grant's own refusals, and flat Polaris refusals beside them
 * (`not_entitled`, `device_limit`, `license_choice_required`, `429 rate_limited` with
 * `retryAfter`), the shape `license/activate` answers.
 */

import {
  RESTORE_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type KeyReturnTokenResponse,
  type TokenResponse,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { bearer } from "../../../platform/http.js";
import { sha256B64url } from "../../../platform/hash.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import {
  ErrorCode,
  errorResponse,
  json,
  methodNotAllowed,
} from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { oauth, readForm, withNoStore } from "./oauthHttp.js";
import { CLIENT_ID_PATTERN } from "@polaris-key/protocol/identity";
import { namedClientId } from "../issuer/clientAuth.js";
import { handleIssuerToken } from "../issuer/token.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  accountForSubject,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import {
  deviceMetadata,
  isValidClientDeviceId,
  licenseUsable,
  NO_LICENSE_ID,
  shapeDevice,
  shapeLicense,
  validateDeviceToken,
} from "../../../core/devices.js";
import { getLicense } from "../../../core/licensing/store.js";
import { customerTierId } from "../../../core/licensing/implicitTier.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import {
  DeviceKeysConflictError,
  DeviceKeysInvalidError,
  type DeviceKeyPair,
} from "../../../core/devices/keys.js";
import { registerDeviceKeys } from "../../../core/devices/registerKeys.js";
import { getAccountRow } from "../accounts/repo.js";
import { redeemAuthorizationCode, type SignInCodeRecord } from "./code.js";
import {
  bindChoice,
  bindKeyReturn,
  type BindRefusal,
  type BindResult,
} from "./bind.js";
import { bindWithoutChoice, settleAppMode } from "./settle.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import { handleExchange } from "./exchange.js";
import { handleRestoreGrant } from "./restore.js";
import { markFresh } from "./fresh.js";
import { restoreServed } from "../restore/gate.js";
import { markRestoreOrigin } from "../restore/store.js";
import {
  deviceBelongsElsewhere,
  sendRestoreNotice,
} from "../restore/signedIn.js";

// `choice/complete` binds without a choice through the same function (settle.ts).
export { bindWithoutChoice };

const CLIENT_ID_RE = new RegExp(CLIENT_ID_PATTERN);

/** The token endpoint: 30 a minute per client network, 10 per device id; both fail closed. */
export const TOKEN_RATE = { bucket: "identityToken", limit: 30, windowSec: 60 };
export const TOKEN_DEVICE_RATE = {
  bucket: "identityTokenDevice",
  limit: 10,
  windowSec: 60,
};

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export { oauth, readForm };

export async function handleToken(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  settings?: SettingsRegistry;
}): Promise<Response> {
  const { req, env, db, product, now, settings } = ctx;
  if (req.method !== "POST") return methodNotAllowed();
  const form = await readForm(req);
  if (!form)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "A form-encoded body is required.",
    );
  // I-21.9 (§12.13.4): a request that names a registered client, in the header or the body, is
  // the issuer's, with its own budgets (per client and network, `clientAuth.ts`); the own client's
  // shared network budget below never sees it, so one client cannot spend another's.
  const named = namedClientId(req, form);
  if (named !== null && CLIENT_ID_RE.test(named))
    return handleIssuerToken({ req, env, db, slug: product.slug, now, form });
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...TOKEN_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: TOKEN_RATE.windowSec,
    });
  const grant = form.get("grant_type");
  if (!grant)
    return oauth(400, ErrorCode.InvalidRequest, "grant_type is required.");
  // LG-1: with the gate off the grant is not one this build knows (`unsupported_grant_type`).
  if (
    grant === TOKEN_EXCHANGE_GRANT_TYPE &&
    (await launchGateOn(env, db, "launch.identityExchange"))
  )
    return handleExchange({ req, env, db, product, now, form, settings });
  // I-49.7 (§12.11.8 step 1): with the launch gate, the product setting or Identity off the grant
  // is not one this build knows, and nothing has been read or consumed.
  if (
    grant === RESTORE_GRANT_TYPE &&
    (await restoreServed(env, db, product.slug))
  )
    return handleRestoreGrant({ req, env, db, product, now, form, settings });
  if (grant !== "authorization_code")
    return oauth(400, ErrorCode.UnsupportedGrantType);
  const clientId = form.get("client_id");
  if (!clientId)
    return oauth(400, ErrorCode.InvalidRequest, "client_id is required.");
  if (clientId !== product.slug) return oauth(401, ErrorCode.InvalidClient);
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  if (!code || !verifier)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "code and code_verifier are required.",
    );
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !isValidClientDeviceId(deviceId))
    return oauth(400, ErrorCode.InvalidRequest, "X-PKey-Device is required.");
  // A malformed code or verifier cannot be a real one: refused without touching the store.
  if (!CODE_RE.test(code) || !VERIFIER_RE.test(verifier))
    return oauth(400, ErrorCode.InvalidGrant);
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...TOKEN_DEVICE_RATE, id: deviceId },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: TOKEN_DEVICE_RATE.windowSec,
    });

  // Redeem: the challenge derived from the verifier is the proof. Match or mismatch, the code ends.
  const record = await redeemAuthorizationCode(
    env,
    product.slug,
    code,
    await sha256B64url(verifier),
  );
  if (!record) return oauth(400, ErrorCode.InvalidGrant);
  if (record.clientId !== clientId) return oauth(400, ErrorCode.InvalidGrant);
  // §12.12: a code from a pushed request belongs to the device that pushed it.
  if (record.deviceId !== undefined && record.deviceId !== deviceId)
    return oauth(400, ErrorCode.InvalidGrant);
  const presentedUri = form.get("redirect_uri");
  if (
    presentedUri !== undefined &&
    !constantTimeEqual(presentedUri, record.redirectUri)
  )
    return oauth(400, ErrorCode.InvalidGrant);

  // LK-SKIP (§12.4.2): a code the card's key route issued names a key, not an account.
  if (record.kind === "key")
    return redeemKeyReturn(
      { req, env, db, product, now, ...(settings ? { settings } : {}) },
      record,
      deviceId,
      form.get("device_name") ?? undefined,
    );

  // The code is 60 s old at most; the account may not be what it was at Continue.
  const subject = await resolveSubject(db, product.slug, record.subject);
  const accountId = subject
    ? await accountForSubject(db, product.slug, subject)
    : null;
  const account = accountId ? await getAccountRow(db, accountId) : null;
  if (
    !subject ||
    !account ||
    account.status !== "active" ||
    account.id !== record.accountId
  )
    return oauth(400, ErrorCode.InvalidGrant);
  if ((await erasureVerdict(env, now, account.id)) !== "clear")
    return oauth(400, ErrorCode.InvalidGrant);

  return bindAndAnswer(
    { req, env, db, product, now },
    {
      accountId: account.id,
      subject,
      email: account.primary_email,
      deviceId,
      scope: record.scope,
      licenseChoice: record.licenseChoice,
      choice: record.choice ?? null,
      deviceName: form.get("device_name") ?? undefined,
      fresh: true,
      audit: {
        action: "signin.token",
        summary: "Signed in a device through authorize",
      },
    },
  );
}

/**
 * LK-SKIP (WIRE-CONTRACT-V5 §12.4.2 items 5 and 6, §12.5 rule 3): a key-return code binds the
 * device on the key's licence as `license/activate` would, with no account and no sign-in binding.
 *
 * A code on a product whose launch gate, Identity or License is off is `invalid_grant`, and so is
 * a code whose key, licence or product no longer holds (`bindKeyReturn`). A licence that is in an
 * account is a flat `403 license_owned` with `signInUrl`. The answer is the ordinary one plus
 * `via: "key"`, `scope: ""` and `keyEntries`; `subject` is always `null`, because the key bind
 * clears any binding the device held (U-02). The code was consumed before this runs, so every
 * refusal here spends it.
 */
async function redeemKeyReturn(
  cx: {
    req: Request;
    env: Env;
    db: Db;
    product: Product;
    now: number;
    settings?: SettingsRegistry;
  },
  record: SignInCodeRecord,
  deviceId: string,
  deviceName: string | undefined,
): Promise<Response> {
  const { req, env, db, product, now } = cx;
  const invalidGrant = (): Response => oauth(400, ErrorCode.InvalidGrant);
  if (
    record.product !== product.slug ||
    typeof record.licenseId !== "string" ||
    typeof record.keyHash !== "string" ||
    !product.services.license.enabled ||
    !product.services.identity?.enabled ||
    !(await launchGateOn(env, db, "launch.identityKeyReturn"))
  )
    return invalidGrant();

  const bound = await bindKeyReturn(
    cx,
    {
      id: deviceId,
      metadata: deviceMetadata(req),
      label: normalizeDeviceLabel(deviceName),
    },
    { keyHash: record.keyHash, licenseId: record.licenseId },
  );
  if (!bound.ok) {
    const r = bound.refusal;
    if (r.reason === "invalid_grant") return invalidGrant();
    if (r.reason === "license_owned")
      return withNoStore(
        errorResponse(403, ErrorCode.LicenseOwned, "license is in an account", {
          signInUrl: r.signInUrl,
        }),
      );
    if (r.reason === "key_entry_limit")
      return withNoStore(
        errorResponse(403, ErrorCode.KeyEntryLimit, "key entry limit reached", {
          keyEntries: r.keyEntries,
          ...(r.manageUrl !== undefined ? { manageUrl: r.manageUrl } : {}),
        }),
      );
    return flatRefusal(r);
  }
  // Unreachable: Identity is on, so the gate admitted and counted. A fail-closed guard, so a
  // missing count is never answered.
  if (!bound.keyEntries) return oauth(503, "unavailable");

  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: null,
    actor_name: null,
    actor_email: null,
    action: "signin.token.key",
    target_kind: "device",
    target_id: deviceId,
    parent_id: bound.licenseId,
    summary: "Returned a device to the app on a license key",
  });
  const license = await getLicense(db, product.slug, bound.licenseId);
  if (!license) return oauth(503, "unavailable");
  const body: KeyReturnTokenResponse = {
    access_token: bound.token,
    token_type: "Bearer",
    via: "key",
    scope: "",
    schemaVersion: product.schemaVersion,
    device: shapeDevice(bound.device, deviceId),
    license: shapeLicense(license, await customerTierId(db, license)),
    subject: null,
    keyEntries: bound.keyEntries,
  };
  return withNoStore(json(body));
}

/** What `bindAndAnswer` needs about a sign-in that has found its account. */
export interface SignedIn {
  accountId: string;
  subject: string;
  email: string | null;
  deviceId: string;
  scope: string[];
  licenseChoice: string;
  /** The licence the person chose at Continue, when they did. */
  choice: { licenseId: string; replaceDeviceId?: string } | null;
  deviceName: string | undefined;
  audit: { action: string; summary: string };
  /**
   * The device keys the exchange registers (I-13.4): written once the device is bound, and carried
   * in the pending grant when a choice is due, for `choice/complete` to write.
   */
  keys?: DeviceKeyPair;
  /** The signing key the device held when the exchange checked it (`null`: none). */
  heldSignKey?: string | null;
  /** A same-device grant (I-43.1): marks the step-up once the device is bound. Only `authorization_code` sets it. */
  fresh?: true;
  /**
   * The exchange found the person's app consent standing (I-13.5, plan D-A2): exactly one licence
   * with a free seat then binds with no tap. Never set by `authorization_code`.
   */
  silentSingle?: boolean;
  /**
   * A sign-in by silent-restore key (I-49.7): the device row must not belong to another subject or
   * licence, the grant a choice leaves open carries it, and once the device is bound it is marked
   * as signed in by restore, its keys are registered `via: "restore"` and the notice goes out.
   */
  via?: "restore";
}

/**
 * The tail both grants share: bind the device (or hand over the pending grant when the app has a
 * choice to make) and answer. `authorization_code` and the token exchange (I-13.4) differ only in
 * how they found the account.
 */
export async function bindAndAnswer(
  cx: { req: Request; env: Env; db: Db; product: Product; now: number },
  p: SignedIn,
): Promise<Response> {
  const { req, env, db, product, now } = cx;
  const { deviceId, subject } = p;
  const account = { id: p.accountId, primary_email: p.email };

  const metadata = deviceMetadata(req);
  const label = normalizeDeviceLabel(p.deviceName);

  // A device that presents its own live token proves it holds the device. Only then may a sign-in
  // keep the licence the device runs on, or take over a device id that already has a credential:
  // the binding is written on the existing row and the token it already holds is the answer.
  // Without the proof an existing device id is never touched.
  const presented = bearer(req);
  const held = presented
    ? await validateDeviceToken(env, db, product, presented, now, { deviceId })
    : null;
  const proven = held && !("error" in held) ? held : null;
  const keepable =
    proven &&
    proven.device.license_id !== NO_LICENSE_ID &&
    proven.license !== null &&
    licenseUsable(proven.license, now)
      ? proven
      : null;

  // I-49.7: a restore never takes over a device row that belongs to another person or licence.
  if (
    p.via === "restore" &&
    (await deviceBelongsElsewhere(db, product.slug, deviceId, subject))
  )
    return oauth(400, ErrorCode.InvalidGrant);

  const who = { accountId: account.id, subject, email: account.primary_email };
  const deviceArgs = {
    id: deviceId,
    metadata,
    label,
    held:
      keepable && presented ? { token: presented, row: keepable.device } : null,
  };

  let bound: BindResult;
  if (p.choice) {
    // The person chose at Continue (a licence, a replace, or the one Continue minted for them).
    bound = await bindChoice(cx, who, deviceArgs, {
      kind: "license",
      licenseId: p.choice.licenseId,
      ...(p.choice.replaceDeviceId !== undefined
        ? { replaceDeviceId: p.choice.replaceDeviceId }
        : {}),
    });
  } else if (p.licenseChoice === "app" && product.services.license.enabled) {
    // App mode: the app runs the choice. If one is due, hand over the grant instead of a token.
    const settled = await settleAppMode(cx, who, deviceArgs, {
      scope: p.scope,
      ...(p.keys ? { keys: p.keys } : {}),
      ...(p.fresh ? { fresh: true as const } : {}),
      ...(p.silentSingle ? { silentSingle: true } : {}),
      ...(p.via ? { via: p.via } : {}),
      ...(p.via === "restore"
        ? {
            silentBlocked: (licenseId: string) =>
              deviceBelongsElsewhere(
                db,
                product.slug,
                deviceId,
                subject,
                licenseId,
              ),
          }
        : {}),
      keepable: keepable !== null,
      proven: proven !== null,
    });
    if (settled.kind === "refused") return oauth(400, ErrorCode.InvalidGrant);
    if (settled.kind === "choose") return withNoStore(json(settled.pending));
    bound = settled.bound;
  } else {
    bound = await bindWithoutChoice(
      cx,
      who,
      deviceArgs,
      keepable !== null,
      proven !== null,
    );
  }
  if (!bound.ok) return flatRefusal(bound.refusal);

  if (p.via === "restore")
    await markRestoreOrigin(db, {
      product: product.slug,
      deviceId,
      subject,
      now,
    });
  if (p.keys) {
    try {
      await registerDeviceKeys(
        { db, env, now },
        product.slug,
        deviceId,
        p.keys,
        undefined,
        p.heldSignKey,
        p.via,
      );
    } catch (e) {
      // A key another device of the product holds, or a malformed one: the same plain refusal.
      if (
        e instanceof DeviceKeysInvalidError ||
        e instanceof DeviceKeysConflictError
      )
        return oauth(400, ErrorCode.InvalidGrant);
      throw e;
    }
  }

  if (p.fresh) await markFresh(env, product.slug, deviceId, p.subject);
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: p.audit.action,
    target_kind: "device",
    target_id: deviceId,
    parent_id: bound.licenseId === NO_LICENSE_ID ? null : bound.licenseId,
    summary: p.audit.summary,
  });
  if (p.via === "restore")
    await sendRestoreNotice(cx, {
      accountId: account.id,
      email: account.primary_email,
      deviceLabel: bound.device.label,
    });
  return withNoStore(
    json(await tokenBody(db, product, deviceId, p.scope, subject, bound)),
  );
}

/** The `200` of `token` and of `choice/complete`: one shape (§12.5, §12.5.1). */
export async function tokenBody(
  db: Db,
  product: Product,
  deviceId: string,
  scope: string[],
  subject: string,
  bound: Extract<BindResult, { ok: true }>,
): Promise<TokenResponse> {
  const license =
    bound.licenseId === NO_LICENSE_ID
      ? null
      : await getLicense(db, product.slug, bound.licenseId);
  return {
    access_token: bound.token,
    token_type: "Bearer",
    scope: scope.join(" "),
    schemaVersion: product.schemaVersion,
    device: shapeDevice(bound.device, deviceId),
    license: license
      ? shapeLicense(license, await customerTierId(db, license))
      : null,
    subject,
    ...(bound.keyEntries ? { keyEntries: bound.keyEntries } : {}),
  };
}

/** A bind refusal as `token` answers it: flat, the shape `license/activate` answers. */
function flatRefusal(r: BindRefusal): Response {
  switch (r.reason) {
    case "device_limit":
      return withNoStore(
        errorResponse(403, "device_limit", "device limit reached", {
          limit: r.limit,
          deviceCount: r.deviceCount,
          ...(r.manageUrl !== undefined ? { manageUrl: r.manageUrl } : {}),
        }),
      );
    case "fingerprint_required":
      return oauth(403, "fingerprint_required");
    case "hardware_mismatch":
      return oauth(409, "hardware_mismatch");
    case "rate_limited":
      return oauth(429, "rate_limited", undefined, {
        retryAfter: r.retryAfter,
      });
    case "license_owned":
    case "key_entry_limit":
    case "unauthorized":
    case "not_entitled":
      return oauth(403, "not_entitled");
    case "unavailable":
      return oauth(503, "unavailable");
    case "not_found":
    case "license_choice_required":
      return oauth(409, ErrorCode.LicenseChoiceRequired);
  }
}
