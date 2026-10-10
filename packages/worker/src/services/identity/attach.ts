/// <reference types="@cloudflare/workers-types" />

/**
 * The account on the device wire (I-09; WIRE-CONTRACT-V4 §12.3, plans/I-09.md §2 and §7):
 *
 *     POST /<p>/identity/attach    {confirm}  add the device's licence to the signed-in account
 *     GET  /<p>/identity/subject              the pairwise subject signed in on the device
 *     POST /<p>/identity/signout              sign the device out of its account
 *
 * All three take the device's own credential, `Authorization: Bearer pkeyt_…` with the matching
 * `X-PKey-Device`, and nothing else: no cookie, no session, no account id or subject from the
 * request. CORS answers the product's `web.origins` without credentials (`core/cors.ts`), every
 * answer is `no-store`, and errors are the nested `PolarisErrorBody`. They exist only while the
 * product's Identity service is on; otherwise the registry answers `404 not_found`.
 *
 * ── WHO HOLDS AN ATTACH ─────────────────────────────────────────────────────────────────────
 *
 * The account an attach adds the licence to is the account of `devices.subject`, the binding a
 * completed sign-in wrote on THIS device (S-19 decision 4), read from the D1 row the token
 * validated, never from the KV mirror, the request or `licenses.account_id`. No binding is
 * `account_required`. The licence is the one the device already runs on: a device token reaches
 * exactly that licence, so a stolen token can attach or sign out nothing its device does not
 * already hold. The write is Identity's claim rule (`accounts/claim.ts`, `via: "device"`): first
 * claim wins through one compare-and-set statement, an owned licence never moves
 * (`license_owned`, which here carries no link), and a licence with a buyer email joins only an
 * account that verified that email unless the product sets `identity.keyEntry.claimByKey`
 * (`license_email_bound`). Attach never re-anchors the device and never changes a signed
 * document.
 *
 * ── SIGN-OUT ────────────────────────────────────────────────────────────────────────────────
 *
 * Core's clearing hook drops this device's binding only. It also releases the seat (deauthorizes
 * the device, so the token stops working) when the sign-in bound it (`bound_by = 'signin'`) to a
 * licence of the account signing out; a key- or enrol-bound device keeps its licence and token.
 * No other device is touched. An SDK flushes Cloud Sync before calling it (S-17 §5.4 rule 5).
 */

import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import type {
  AttachPreview,
  AttachResult,
  SignOutResponse,
  SubjectResponse,
} from "@polaris-key/protocol/identity";
import { bearer, randomId, type Db, type Env } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  wireError,
} from "../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import {
  DeviceTokenRotationLost,
  isValidClientDeviceId,
  licenseUsable,
  rotateDeviceToken,
  shapeDevice,
  shapeLicense,
  validateDeviceToken,
  type ValidDeviceToken,
} from "../../core/devices.js";
import {
  accountForSubject,
  PAIRWISE_SUBJECT_PATTERN,
  resolveSubject,
} from "../../core/accountSubjects.js";
import { clearDeviceSubjects } from "../../core/subjectHooks.js";
import { appendAudit, type LicenseRow } from "../../core/data.js";
import { portalOriginOf } from "../../core/manageUrl.js";
import { readBodyJson } from "../../core/cappedBody.js";
import { attachLicense, evaluateAttach } from "./accounts/claim.js";
import { getAccountRow } from "./accounts/repo.js";

/** Attach writes the licence's owner: 30 a minute per client network, failing closed. */
export const ATTACH_RATE = {
  bucket: "identityAttach",
  limit: 30,
  windowSec: 60,
};

/** Subject and sign-out: 60 a minute per client network, failing open (they mint nothing). */
export const ACCOUNT_RATE = {
  bucket: "identityAccount",
  limit: 60,
  windowSec: 60,
};

/** The device whose own token made the request, or the refusal to answer. */
async function deviceOf(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<{ deviceId: string; valid: ValidDeviceToken } | Response> {
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !isValidClientDeviceId(deviceId))
    return wireError(400, ErrorCode.BadRequest);
  const valid = await validateDeviceToken(env, db, product, bearer(req), now, {
    deviceId,
  });
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);
  return { deviceId, valid };
}

/**
 * The account signed in on the device: the binding's account, through merge aliases, while that
 * account is active. `null` when there is none.
 */
async function deviceHolder(
  db: Db,
  product: string,
  bound: string | null | undefined,
): Promise<{ accountId: string; subject: string } | null> {
  if (!bound || !PAIRWISE_SUBJECT_PATTERN.test(bound)) return null;
  const subject = await resolveSubject(db, product, bound);
  if (!subject) return null;
  const accountId = await accountForSubject(db, product, subject);
  if (!accountId) return null;
  const account = await getAccountRow(db, accountId);
  return account && account.status === "active" ? { accountId, subject } : null;
}

async function limited(
  env: Env,
  product: Product,
  req: Request,
  rate: { bucket: string; limit: number; windowSec: number },
  now: number,
): Promise<boolean> {
  return !(await rateLimitOk(
    env,
    product.slug,
    { ...rate, id: clientNetwork(req) },
    now,
  ));
}

/** `POST /<p>/identity/attach {confirm}` (§12.3). */
export async function handleIdentityAttach(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (await limited(env, product, req, ATTACH_RATE, now))
    return wireError(429, "rate_limited");
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return auth;
  const { deviceId, valid } = auth;

  let confirm: unknown;
  try {
    const body = await readBodyJson(req);
    confirm =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { confirm?: unknown }).confirm
        : undefined;
  } catch {
    confirm = undefined;
  }
  if (typeof confirm !== "boolean") return wireError(400, ErrorCode.BadRequest);

  // A licence the device holds but can no longer use is the token route's 401, as everywhere.
  const license: LicenseRow | null =
    valid.device.license_id === "" ? null : valid.license;
  if (license && !licenseUsable(license, now))
    return wireError(401, ErrorCode.Unauthorized);
  // The holder: the account signed in on THIS device, never one the request names.
  const holder = await deviceHolder(db, product.slug, valid.device.subject);
  if (!holder) return wireError(403, ErrorCode.AccountRequired);
  if (!license) return wireError(404, ErrorCode.NotFound);

  // The claim rules, read-only: the preview refuses exactly what the attach would.
  const verdict = await evaluateAttach(db, holder.accountId, license, "device");
  switch (verdict.kind) {
    case "not_found":
      return wireError(404, ErrorCode.NotFound);
    case "license_owned":
      return wireError(403, ErrorCode.LicenseOwned);
    case "license_email_bound":
      return wireError(403, ErrorCode.LicenseEmailBound);
    case "auto_attach_blocked":
      // Only automatic attaches are blocked; a device attach is the person's explicit act.
      return wireError(403, ErrorCode.Forbidden);
    case "attachable":
    case "already_yours":
      break;
  }
  if (!confirm) {
    const preview: AttachPreview = {
      status: "confirm",
      license: { id: license.id, tierId: license.tier_id, name: license.name },
    };
    return json(preview);
  }

  const origin = portalOriginOf(env, req) ?? new URL(req.url).origin;
  const attached = await attachLicense(
    { db, env, now, origin },
    {
      accountId: holder.accountId,
      product: product.slug,
      licenseId: license.id,
      via: "device",
    },
  );
  if (!attached.ok) {
    // A concurrent claim by another account won the compare-and-set, or the licence went.
    if (attached.reason === "license_email_bound")
      return wireError(403, ErrorCode.LicenseEmailBound);
    if (attached.reason === "not_found")
      return wireError(404, ErrorCode.NotFound);
    return wireError(403, ErrorCode.LicenseOwned);
  }
  if (attached.attached) {
    // The licence's own history in the console: who (the subject, never the account id), from
    // which device, and how.
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: holder.subject,
      actor_name: null,
      actor_email: null,
      action: "license.attach",
      target_kind: "license",
      target_id: license.id,
      parent_id: null,
      summary: `Added to the account of ${holder.subject} from device ${deviceId} (via device)`,
    });
  }

  let token: string;
  try {
    token = await rotateDeviceToken(env, db, product, valid, now);
  } catch (e) {
    if (e instanceof DeviceTokenRotationLost)
      return wireError(401, ErrorCode.Unauthorized);
    throw e;
  }
  const result: AttachResult = {
    token,
    schemaVersion: product.schemaVersion,
    device: shapeDevice(valid.device, deviceId),
    license: shapeLicense(license),
    subject: holder.subject,
    ...(attached.attached ? { attached: "claimed" as const } : {}),
  };
  return json(result);
}

/** `GET /<p>/identity/subject` (§12.3). */
export async function handleIdentitySubject(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  if (await limited(env, product, req, ACCOUNT_RATE, now))
    return wireError(429, "rate_limited");
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return auth;
  const bound = auth.valid.device.subject ?? null;
  const subject =
    bound && PAIRWISE_SUBJECT_PATTERN.test(bound)
      ? await resolveSubject(db, product.slug, bound)
      : null;
  const body: SubjectResponse = { subject };
  return json(body);
}

/** `POST /<p>/identity/signout` (§12.3). */
export async function handleIdentitySignOut(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (await limited(env, product, req, ACCOUNT_RATE, now))
    return wireError(429, "rate_limited");
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return auth;
  // This device only: a sign-out never reaches another device of the account.
  const cleared = await clearDeviceSubjects(
    db,
    env,
    { kind: "device", product: product.slug, deviceId: auth.deviceId },
    "signout",
  );
  const body: SignOutResponse = {
    released: cleared.released.includes(`${product.slug}:${auth.deviceId}`),
  };
  return json(body);
}
