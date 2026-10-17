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
 * runs on needs the device's own token in `Authorization: Bearer`: with that proof the sign-in
 * binds the account to the device where it stands and answers the token the device already holds.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Flat RFC 6749 §5.2 bodies for the grant's own refusals, and flat Polaris refusals beside them
 * (`not_entitled`, `device_limit`, `license_choice_required`, `429 rate_limited` with
 * `retryAfter`), the shape `license/activate` answers.
 */

import {
  CHOICE_GRANT_TTL_SECONDS,
  type PendingSignIn,
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
  licenseUsable,
  NO_LICENSE_ID,
  registerDeviceBinding,
  shapeDevice,
  shapeLicense,
  validateDeviceToken,
} from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import type { DeviceRow } from "../../../core/repo.js";
import { getLicense } from "../../../core/licensing/store.js";
import { rankAnchorCandidates } from "../../../core/licensing/anchor.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import { getAccountRow } from "../accounts/repo.js";
import { redeemAuthorizationCode } from "./code.js";
import { acceptsKeys, licenseChoiceView, offerFor } from "./choice.js";
import { issueGrant } from "./grant.js";
import { bindChoice, type BindRefusal, type BindResult } from "./bind.js";

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

  const cx = { req, env, db, product, now };
  const who = { accountId: account.id, subject, email: account.primary_email };
  const deviceArgs = {
    id: deviceId,
    metadata,
    label,
    held:
      keepable && presented ? { token: presented, row: keepable.device } : null,
  };

  let bound: BindResult;
  if (record.choice) {
    // The person chose at Continue (a licence, a replace, or the one Continue minted for them).
    bound = await bindChoice(cx, who, deviceArgs, {
      kind: "license",
      licenseId: record.choice.licenseId,
      ...(record.choice.replaceDeviceId !== undefined
        ? { replaceDeviceId: record.choice.replaceDeviceId }
        : {}),
    });
  } else if (
    record.licenseChoice === "app" &&
    product.services.license.enabled
  ) {
    // App mode: the app runs the choice. If one is due, hand over the grant instead of a token.
    const choiceCx = { env, db, product, now };
    const offer = await offerFor(choiceCx, account.id, deviceId);
    const due =
      offer.candidates.length > 0 ||
      offer.keep ||
      (!offer.granted && acceptsKeys(product));
    if (due) {
      const grant = await issueGrant(
        env,
        {
          product: product.slug,
          accountId: account.id,
          subject,
          deviceId,
          scope: record.scope,
        },
        now,
      );
      const pending: PendingSignIn = {
        status: "choose",
        grant,
        expiresIn: CHOICE_GRANT_TTL_SECONDS,
        choices: await licenseChoiceView(choiceCx, req, account.id, {
          deviceId,
        }),
      };
      return withNoStore(json(pending));
    }
    bound = await bindWithoutChoice(
      cx,
      who,
      deviceArgs,
      keepable !== null,
      proven !== null,
    );
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
    parent_id: bound.licenseId === NO_LICENSE_ID ? null : bound.licenseId,
    summary: "Signed in a device through authorize",
  });
  return withNoStore(
    json(await tokenBody(db, product, deviceId, record.scope, subject, bound)),
  );
}

/**
 * The cases where no choice rides on the code. In card mode Continue refused the press if a choice
 * was owed, so one still owed here means the offer changed since (a licence appeared): never
 * silent. The device's own proof keeps its licence; with none to choose, the device is bound
 * licence-less.
 */
async function bindWithoutChoice(
  cx: { req: Request; env: Env; db: Db; product: Product; now: number },
  who: { accountId: string; subject: string; email: string | null },
  device: {
    id: string;
    metadata: ReturnType<typeof deviceMetadata>;
    label: string | null;
    held: { token: string; row: DeviceRow } | null;
  },
  keepable: boolean,
  proven: boolean,
): Promise<BindResult> {
  const { env, db, product, now } = cx;
  if (keepable && device.held)
    return bindChoice(cx, who, device, { kind: "keep" });
  if (product.services.license.enabled) {
    const offer = await rankAnchorCandidates(db, product, who.accountId, now, {
      deviceId: device.id,
    });
    if (offer.candidates.length > 0 || offer.keep)
      return { ok: false, refusal: { reason: "license_choice_required" } };
  }
  const existing = await getDevice(db, product.slug, device.id);
  if (existing && existing.license_id !== NO_LICENSE_ID)
    return { ok: false, refusal: { reason: "license_choice_required" } };
  // A licence-less device id that already holds a credential is taken over only by the device
  // that presents it: registering rotates the token, so without the proof a person with any
  // account could bind someone else's device id to theirs.
  if (existing?.token_hash && !proven)
    return { ok: false, refusal: { reason: "not_entitled" } };
  const registered = await registerDeviceBinding(
    env,
    db,
    product,
    device.id,
    now,
    {
      existing,
      presented: null,
      metadata: { ...device.metadata, label: device.label },
      boundBy: "signin",
      subject: who.subject,
    },
  );
  return {
    ok: true,
    token: registered.token,
    device: registered.device,
    licenseId: NO_LICENSE_ID,
  };
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
    license: license ? shapeLicense(license) : null,
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
    case "not_found":
    case "license_choice_required":
      return oauth(409, ErrorCode.LicenseChoiceRequired);
  }
}
