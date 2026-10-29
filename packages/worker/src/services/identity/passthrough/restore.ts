/// <reference types="@cloudflare/workers-types" />

/**
 * The restore grant of `POST /<p>/identity/token` (I-49.7; WIRE-CONTRACT-V5 §12.11.8): a new device
 * of a person who was signed in redeems the restore key its platform backup carried, once, and is
 * signed in with no click. Security-bearing: read `restore/store.ts` first.
 *
 * ── THE ORDER (§12.11.8, steps 1 to 10) ──────────────────────────────────────────────────────
 *
 *   1  the gate: the caller (`token.ts`) answers `unsupported_grant_type` with the launch gate or the
 *      product setting off (with Identity off the route answers 404, as every identity route does),
 *      before this file runs, so nothing is read or consumed;
 *   2  the shape of the parameters, then the limits (10 a minute per client network, 5 per device);
 *   3  the proof (purpose `restore`, value `<restore_id>.<device_key>`, line 6 the SHA-256 of the
 *      secret): it needs no state, so a caller without the device key reaches no row;
 *   4  the device's held signing key equals `device_key`;
 *   5+6 `consumeRestoreKey`: found by id AND product `client_id` names, the peppered HMAC compared
 *      in constant time (computed for a missing row too), then one compare-and-set delete on id,
 *      product and hash. A wrong secret, or another product's key, consumes nothing;
 *   7  the subject resolves to an active account through merge aliases, not on the erasure ledger;
 *      the enrolling device is still authorized and signed in as that account; a security notice can
 *      reach the account; the account's 5 a day (429) is counted last;
 *   8  an `agree_key` another device of the product holds is refused;
 *   9  the product's terms are accepted, then the person's consent for the product stands;
 *   10 `bindAndAnswer` (the silent single path), the device's keys registered `via: "restore"`.
 *
 * ── NO ORACLE ───────────────────────────────────────────────────────────────────────────────
 *
 * Every refusal from step 2's shape to step 8 is ONE `400 invalid_grant` (`refused()`), whichever
 * check failed: the body is byte-identical and carries no description. The limits (429), a store
 * failure (503), the terms (`interstitial_required`) and the later answers of §12.11.3 are the
 * documented exceptions, and they come after the key is proven. Nothing here logs or audits a
 * secret, an id or a verifier message.
 */

import type {
  RestoreConfirmSignIn,
  RestoreInterstitialRequiredBody,
} from "@polaris-key/protocol/identity";
import { CHOICE_GRANT_TTL_SECONDS } from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { sha256B64url } from "../../../platform/hash.js";
import { ErrorCode, errorResponse, json } from "../../../core/errors.js";
import { appendAudit } from "../../../core/audit.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { isValidClientDeviceId } from "../../../core/devices.js";
import {
  agreeKeyHeldElsewhere,
  deviceSignKey,
  isValidAgreeKey,
} from "../../../core/devices/keys.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { loadProductPublic } from "../../../core/products.js";
import { getDevice } from "../../../core/devices/store.js";
import { resolveSubject } from "../../../core/accounts/accountSubjects.js";
import { securityNoticeDeliverable } from "../../../core/notify/send.js";
import { randomId } from "../../../platform/crypto.js";
import { deviceHolder } from "../attach.js";
import { getAccountRow } from "../accounts/repo.js";
import { termsAccepted } from "../accounts/terms.js";
import { productTerms } from "../productTerms.js";
import {
  consumeRestoreKey,
  RESTORE_ID_PATTERN,
  RESTORE_SECRET_PATTERN,
} from "../restore/store.js";
import { resolveScope } from "./authorize.js";
import {
  consentedScope,
  consentView,
  type NativeGrantContext,
} from "./silent.js";
import { clientRecordFor } from "./client.js";
import { issueGrant } from "./grant.js";
import { consentState } from "./routes.js";
import { noStore, withIssuedType } from "./exchange.js";
import { bindAndAnswer, oauth } from "./token.js";

/** The grant: 10 a minute per client network, 5 per device; both fail closed. */
export const RESTORE_NET_RATE = {
  bucket: "identityRestore",
  limit: 10,
  windowSec: 60,
};
export const RESTORE_DEVICE_RATE = {
  bucket: "identityRestoreDevice",
  limit: 5,
  windowSec: 60,
};

/** The account's cap: 5 a day, counted once the key's account is known; fails closed. */
export const RESTORE_ACCOUNT_RATE = {
  bucket: "identityRestoreAccount",
  limit: 5,
  windowSec: 86_400,
};

/** The one refusal from the shape to the agree-key check. */
const refused = (): Response => oauth(400, ErrorCode.InvalidGrant);

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{86}$/;

export async function handleRestoreGrant(
  ctx: NativeGrantContext,
): Promise<Response> {
  const { req, env, db, product, now, form, settings } = ctx;

  // ── 2: the network's limit, the shape, the device's limit ────────────────────────────────────
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...RESTORE_NET_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: RESTORE_NET_RATE.windowSec,
    });
  const restoreId = form.get("restore_id");
  const secret = form.get("restore_secret");
  const deviceKey = form.get("device_key");
  const agreeKey = form.get("agree_key");
  const proof = form.get("proof");
  const choice = form.get("license_choice") ?? "app";
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (
    form.get("client_id") !== product.slug ||
    !restoreId ||
    !RESTORE_ID_PATTERN.test(restoreId) ||
    !secret ||
    !RESTORE_SECRET_PATTERN.test(secret) ||
    !deviceKey ||
    !KEY_RE.test(deviceKey) ||
    !agreeKey ||
    !isValidAgreeKey(agreeKey) ||
    !proof ||
    !PROOF_RE.test(proof) ||
    (choice !== "app" && choice !== "card") ||
    !deviceId ||
    !isValidClientDeviceId(deviceId)
  )
    return refused();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...RESTORE_DEVICE_RATE, id: deviceId },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: RESTORE_DEVICE_RATE.windowSec,
    });

  // ── 3: the proof, stateless: nobody without the device key reaches a row ─────────────────────
  if (
    !(await verifyDeviceProof({
      purpose: "restore",
      product: product.slug,
      deviceId,
      value: `${restoreId}.${deviceKey}`,
      tokenHash: await sha256B64url(secret),
      signKey: deviceKey,
      sig: proof,
    }))
  )
    return refused();

  // ── 4: the device's held signing key ─────────────────────────────────────────────────────────
  const held = await deviceSignKey(db, product.slug, deviceId);
  if (held !== null && held !== deviceKey) return refused();

  // ── 5 and 6: look up and use the key once ────────────────────────────────────────────────────
  let used: { subject: string; deviceId: string } | null;
  try {
    used = await consumeRestoreKey(env, db, {
      product: product.slug,
      restoreId,
      secret,
      now,
    });
  } catch {
    return oauth(503, "unavailable");
  }
  if (!used) return refused();

  // ── 7: the subject is an active account, through merge aliases, not on the erasure ledger ───
  const holder = await deviceHolder(env, db, product.slug, used.subject, now);
  if (holder === "unavailable") return oauth(503, "unavailable");
  const account = holder ? await getAccountRow(db, holder.accountId) : null;
  if (!holder || !account) return refused();
  const { subject } = holder;

  // The device that enrolled the key is still signed in as this account. A purge or a removal that
  // missed this key (a deletion the revocation list does not name) leaves a key that does not work.
  const enrolled = await getDevice(db, product.slug, used.deviceId);
  if (
    !enrolled ||
    enrolled.status !== "authorized" ||
    !enrolled.subject ||
    (await resolveSubject(db, product.slug, enrolled.subject)) !== subject
  )
    return refused();

  // A notice must be deliverable before anything is bound: no address, no restore.
  let deliverable: boolean;
  try {
    deliverable = await securityNoticeDeliverable(
      env,
      db,
      account.id,
      account.primary_email,
      now,
    );
  } catch {
    return oauth(503, "unavailable");
  }
  if (!deliverable) return refused();

  // The account's own cap, counted once the key's account is known.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...RESTORE_ACCOUNT_RATE, id: account.id },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: RESTORE_ACCOUNT_RATE.windowSec,
    });

  // ── 8: an agreement key another device holds ─────────────────────────────────────────────────
  if (await agreeKeyHeldElsewhere(db, product.slug, agreeKey, deviceId))
    return refused();

  // ── 9: the terms, then the person's consent ──────────────────────────────────────────────────
  const base = {
    product: product.slug,
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    target_kind: "device",
    target_id: deviceId,
    parent_id: null,
  };
  const url = `${new URL(req.url).origin}/${product.slug}/identity/authorize`;
  const terms = await productTerms(
    { env, db, ...(settings ? { registry: settings } : {}) },
    product.slug,
  );
  if (
    terms &&
    !(await termsAccepted(db, account.id, product.slug, terms.version))
  ) {
    await appendAudit(db, {
      ...base,
      id: randomId("aud"),
      action: "signin.restore",
      summary: "Silent restore needs the terms",
    });
    return noStore(
      errorResponse(403, "interstitial_required", undefined, {
        reason: "terms",
        url,
      } satisfies Omit<RestoreInterstitialRequiredBody, "error">),
    );
  }
  const pub = await loadProductPublic(db, product.slug);
  if (!pub) return refused();
  const consent = await consentState(env, db, pub, account.id, now, settings);
  const keys = { signKey: deviceKey, agreeKey };
  if (consent.firstTime || consent.changed) {
    let grant: string;
    try {
      grant = await issueGrant(
        env,
        {
          product: product.slug,
          accountId: account.id,
          subject,
          deviceId,
          scope: resolveScope(undefined, product) ?? [],
          keys,
          consent: { scopeHash: consent.scopeHash },
          via: "restore",
        },
        now,
      );
    } catch {
      return oauth(503, "unavailable");
    }
    await appendAudit(db, {
      ...base,
      id: randomId("aud"),
      action: "signin.restore",
      summary: "Silent restore needs the person's consent",
    });
    const client = await clientRecordFor(
      env,
      db,
      pub,
      "native",
      now,
      undefined,
    );
    // A restore proves a key, not a provider token: the view names no provider and no address.
    const body: RestoreConfirmSignIn = {
      status: "confirm",
      grant,
      expiresIn: CHOICE_GRANT_TTL_SECONDS,
      consent: consentView(client, consent, { provider: null, email: null }),
    };
    return noStore(json(body));
  }

  // ── 10: bind (the silent single path) and register the keys ──────────────────────────────────
  const answered = await bindAndAnswer(
    { req, env, db, product, now },
    {
      accountId: account.id,
      subject,
      email: account.primary_email,
      deviceId,
      scope: consentedScope(product, consent),
      licenseChoice: choice,
      choice: null,
      deviceName: form.get("device_name") ?? undefined,
      audit: {
        action: "signin.restore",
        summary: "Signed in a device by silent restore",
      },
      keys,
      heldSignKey: held,
      silentSingle: true,
      via: "restore",
    },
  );
  return answered.status === 200 ? withIssuedType(answered) : answered;
}
