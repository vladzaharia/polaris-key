/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/token`, grant `authorization_code` (WIRE-CONTRACT-V4 §12.5; plans/I-27.md
 * §2.1, plans/I-08.md §3).
 *
 * The app redeems the code Continue handed it, with the PKCE verifier, and gets a device token.
 * The body is form-encoded (a JSON body is `invalid_request`), the answer is `no-store`, CORS
 * answers only the product's `web.origins` and never with credentials (`core/cors.ts`,
 * `identity/token` in `CORS_SERVICE_PATHS`). It needs `X-PKey-Device`; the device metadata
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
 * runs on is I-08b's choice answer.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Flat RFC 6749 §5.2 bodies for the grant's own refusals, and flat Polaris refusals beside them
 * (`not_entitled`, `device_limit`, `license_choice_required`, `429 rate_limited` with
 * `retryAfter`), the shape `license/activate` answers.
 */

import type { TokenResponse } from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { sha256B64url } from "../../../platform/hash.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import {
  ErrorCode,
  errorResponse,
  json,
  methodNotAllowed,
} from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { readBodyText, BodyTooLargeError } from "../../../core/cappedBody.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  accountForSubject,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import {
  deviceMetadata,
  isValidClientDeviceId,
  NO_LICENSE_ID,
  registerDeviceBinding,
  shapeDevice,
  shapeLicense,
} from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import { getLicense } from "../../../core/licensing/store.js";
import {
  bindSignedInDevice,
  rankAnchorCandidates,
} from "../../../core/licensing/anchor.js";
import { buildManageUrl } from "../../../core/licensing/manageUrl.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import { getAccountRow } from "../accounts/repo.js";
import { redeemAuthorizationCode } from "./code.js";

/** The token endpoint: 30 a minute per client network, 10 per device id; both fail closed. */
export const TOKEN_RATE = { bucket: "identityToken", limit: 30, windowSec: 60 };
export const TOKEN_DEVICE_RATE = {
  bucket: "identityTokenDevice",
  limit: 10,
  windowSec: 60,
};

/** The largest form body read. A code and a verifier are under 200 bytes. */
const MAX_FORM_BYTES = 4 * 1024;

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

const oauth = (
  status: number,
  error: string,
  description?: string,
  extra?: Record<string, unknown>,
): Response =>
  withNoStore(
    errorResponse(status, error, undefined, {
      ...(description ? { error_description: description } : {}),
      ...(extra ?? {}),
    }),
  );

function withNoStore(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
}

/** The form body as single-valued parameters, or `null` when it is not a plain form. */
async function readForm(req: Request): Promise<Map<string, string> | null> {
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  let raw: string;
  try {
    raw = await readBodyText(req, MAX_FORM_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(raw)) {
    if (out.has(k)) return null; // a repeated parameter is refused (RFC 6749 §3.1)
    out.set(k, v);
  }
  return out;
}

export async function handleToken(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
}): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "POST") return methodNotAllowed();
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

  const form = await readForm(req);
  if (!form)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "A form-encoded body is required.",
    );
  const grant = form.get("grant_type");
  if (!grant)
    return oauth(400, ErrorCode.InvalidRequest, "grant_type is required.");
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
  const presentedUri = form.get("redirect_uri");
  if (
    presentedUri !== undefined &&
    !constantTimeEqual(presentedUri, record.redirectUri)
  )
    return oauth(400, ErrorCode.InvalidGrant);

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

  const metadata = deviceMetadata(req);
  const label = normalizeDeviceLabel(form.get("device_name") ?? undefined);

  let token: string;
  let deviceRow: Awaited<ReturnType<typeof registerDeviceBinding>>["device"];
  let licenseId: string;
  if (record.choice) {
    const bound = await bindSignedInDevice(env, db, product, {
      accountId: account.id,
      subject,
      deviceId,
      choice: { kind: "license", licenseId: record.choice.licenseId },
      now,
      authorize: { ...metadata, label },
    });
    if (!bound.ok) {
      if (bound.reason === "authz") {
        const e = bound.error;
        if (e.error === "device_limit") {
          const lic = await getLicense(
            db,
            product.slug,
            record.choice.licenseId,
          );
          const manageUrl = lic
            ? await buildManageUrl(env, db, req, product, {
                kind: "device_limit",
                license: lic,
              })
            : undefined;
          return withNoStore(
            errorResponse(403, "device_limit", "device limit reached", {
              limit: e.limit,
              deviceCount: e.deviceCount,
              ...(manageUrl !== undefined ? { manageUrl } : {}),
            }),
          );
        }
        if (e.error === "fingerprint_required")
          return oauth(403, "fingerprint_required");
        if (e.error === "hardware_mismatch")
          return oauth(409, "hardware_mismatch");
        return oauth(403, "not_entitled");
      }
      if (bound.reason === "not_bindable") return oauth(403, "not_entitled");
      return oauth(409, ErrorCode.LicenseChoiceRequired);
    }
    if (!bound.token || !bound.device)
      return oauth(409, ErrorCode.LicenseChoiceRequired);
    token = bound.token;
    deviceRow = bound.device;
    licenseId = bound.licenseId;
  } else {
    // Nothing was chosen at Continue. If the account now holds a licence the person has not
    // chosen, or the device id already runs on one, the choice is still owed: never silent.
    if (product.services.license.enabled) {
      const offer = await rankAnchorCandidates(db, product, account.id, now, {
        deviceId,
      });
      if (offer.candidates.length > 0 || offer.keep)
        return oauth(409, ErrorCode.LicenseChoiceRequired);
    }
    const existing = await getDevice(db, product.slug, deviceId);
    if (existing && existing.license_id !== NO_LICENSE_ID)
      return oauth(409, ErrorCode.LicenseChoiceRequired);
    const registered = await registerDeviceBinding(
      env,
      db,
      product,
      deviceId,
      now,
      {
        existing,
        presented: null,
        metadata: { ...metadata, label },
        boundBy: "signin",
        subject,
      },
    );
    token = registered.token;
    deviceRow = registered.device;
    licenseId = NO_LICENSE_ID;
  }

  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: "signin.token",
    target_kind: "device",
    target_id: deviceId,
    parent_id: licenseId === NO_LICENSE_ID ? null : licenseId,
    summary: "Signed in a device through authorize",
  });

  const license =
    licenseId === NO_LICENSE_ID
      ? null
      : await getLicense(db, product.slug, licenseId);
  const body: TokenResponse = {
    access_token: token,
    token_type: "Bearer",
    scope: record.scope.join(" "),
    schemaVersion: product.schemaVersion,
    device: shapeDevice(deviceRow, deviceId),
    license: license ? shapeLicense(license) : null,
    subject,
  };
  return withNoStore(json(body));
}
