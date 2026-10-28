/// <reference types="@cloudflare/workers-types" />

/**
 * The token-exchange grant of `POST /<p>/identity/token` (I-13.4; WIRE-CONTRACT-V5 §12.11.3): an
 * app that holds a platform ID token (Google, Apple) trades it, with a nonce and a proof by its
 * device key, for the same answers `authorization_code` gives: a device token, a pending grant
 * (`choose`), or `403 interstitial_required`.
 *
 * ── THE ORDER ───────────────────────────────────────────────────────────────────────────────
 *
 *   shape checks, the device's rate limit, the `exchange` proof (it needs no state, so a caller
 *   without the key cannot spend a nonce), the held-key rule, THEN the nonce is taken (spent by
 *   the first attempt that reaches it, pass or fail), then the provider token is verified, then
 *   the lookup. The lookup walks the token's tenant scopes through `signIn(…, {linkedOnly})`: it
 *   finds a link and never creates an account, and never goes by email, so an address in the token
 *   joins nothing (the owner's rule: "never by email match").
 *
 * ── NO ORACLE ───────────────────────────────────────────────────────────────────────────────
 *
 * Every refusal of the proof, the key, the nonce or the provider token is ONE `400 invalid_grant`
 * with one body (`refused()`), whichever check failed. The message of a verifier error is never
 * logged or audited: it names the check, and next to a caller it would be the oracle the single
 * body removes. The audit carries the provider kind and the outcome only; the token is never
 * stored, logged or audited.
 *
 * ── NO LINK ─────────────────────────────────────────────────────────────────────────────────
 *
 * A verified token with no link answers `403 interstitial_required` (`no_link`) with a
 * `linkHandle` (`lh_` and 43 base64url characters, 600 s, kind `exchange-link`, bound to the
 * product, the device and the key). The regular sign-in follows, and the link offer (I-43) spends
 * the handle so the app never asks the provider for a second token. The handle holds the verified
 * identity for that time, so it is as sensitive as the token it replaces.
 */

import type { ConfirmSignIn } from "@polaris-key/protocol/identity";
import {
  CHOICE_GRANT_TTL_SECONDS,
  EXCHANGE_ISSUED_TOKEN_TYPE,
  EXCHANGE_SUBJECT_TOKEN_TYPE,
  LINK_HANDLE_TTL_SECONDS,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { OidcNetworkError } from "../../../core/oidc/client.js";
import { sha256B64url } from "../../../platform/hash.js";
import { hashKey, randomId } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { ErrorCode, errorResponse } from "../../../core/errors.js";
import { appendAudit } from "../../../core/audit.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { isValidClientDeviceId } from "../../../core/devices.js";
import {
  agreeKeyHeldElsewhere,
  deviceSignKey,
} from "../../../core/devices/keys.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import {
  artefactRef,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { getProduct } from "../../../core/products/store.js";
import { getDevice } from "../../../core/devices/store.js";
import { loadProductPublic } from "../../../core/products.js";
import { json } from "../../../core/errors.js";
import { signIn } from "../accounts/signIn.js";
import { termsAccepted } from "../accounts/terms.js";
import { productTerms } from "../productTerms.js";
import { readPlatformSignIn } from "../platformSignIn.js";
import { verifyNativeToken, type NativeIdentity } from "../providers/native.js";
import { resolveScope } from "./authorize.js";
import {
  consumeExchangeNonce,
  signKeyThumbprint,
  type ExchangeNonceRecord,
} from "./nonce.js";
import { bindAndAnswer, oauth, TOKEN_DEVICE_RATE } from "./token.js";
import { issueGrant } from "./grant.js";
import { clientRecordFor } from "./client.js";
import { consentState } from "./routes.js";

/** What the store holds for a live link handle (I-43 spends it). */
export interface ExchangeLinkRecord {
  product: string;
  deviceId: string;
  /** Base64url SHA-256 of the raw signing key the exchange was proven with. */
  keyThumbprint: string;
  kind: NativeIdentity["kind"];
  issuerKey: string;
  subject: string;
  tenantScopes: string[];
  email: string | null;
  /** Narrowed by `providerVouchesForEmail`, never the raw claim. */
  emailVerified: boolean;
  issuedAt: number;
  /**
   * The subject bound on the device when the handle was issued, if any. A link by handle needs the
   * device to carry the same subject (I-43.2): a handle never follows the device to another person.
   */
  boundSubject?: string | null;
}

/** The store address of a link handle. */
export async function exchangeLinkRef(
  env: Env,
  product: string,
  handle: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "exchange-link",
    `${product}:${await hashKey(handle, env.KEY_HASH_PEPPER)}`,
  );
}

/** The one refusal of every check on the proof, the key, the nonce and the provider token. */
const refused = (): Response => oauth(400, ErrorCode.InvalidGrant);

const FIELD_MAX = 4096;

export async function handleExchange(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  form: Map<string, string>;
  settings?: SettingsRegistry | undefined;
}): Promise<Response> {
  const { req, env, db, product, now, form, settings } = ctx;
  if (form.get("client_id") !== product.slug)
    return oauth(401, ErrorCode.InvalidClient);
  const subjectToken = form.get("subject_token");
  const nonce = form.get("nonce");
  const deviceKey = form.get("device_key");
  const proof = form.get("proof");
  const choice = form.get("license_choice") ?? "app";
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (
    form.get("subject_token_type") !== EXCHANGE_SUBJECT_TOKEN_TYPE ||
    !subjectToken ||
    !nonce ||
    !deviceKey ||
    !proof ||
    (choice !== "app" && choice !== "card") ||
    !deviceId ||
    !isValidClientDeviceId(deviceId) ||
    [subjectToken, nonce, deviceKey, proof].some((v) => v.length > FIELD_MAX)
  )
    return oauth(400, ErrorCode.InvalidRequest);
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

  // The proof first: it needs no state, so a caller without the key cannot spend a nonce.
  if (
    !(await verifyDeviceProof({
      purpose: "exchange",
      product: product.slug,
      deviceId,
      value: `${nonce}.${deviceKey}`,
      tokenHash: await sha256B64url(subjectToken),
      signKey: deviceKey,
      sig: proof,
    }))
  )
    return refused();
  // A device that already has a registered signing key must present that key.
  const held = await deviceSignKey(db, product.slug, deviceId);
  if (held !== null && held !== deviceKey) return refused();
  const spent: ExchangeNonceRecord | null = await consumeExchangeNonce(
    env,
    product.slug,
    nonce,
    deviceId,
    deviceKey,
  );
  if (!spent) return refused();

  const row = await getProduct(db, product.slug);
  if (!row) return refused();
  let id: NativeIdentity;
  try {
    id = await verifyNativeToken(
      subjectToken,
      nonce,
      await readPlatformSignIn(db, row),
      env as unknown as Readonly<Record<string, unknown>>,
    );
  } catch (e) {
    // The provider being unreachable says nothing about the token; every other failure is the
    // one refusal, with the message dropped.
    if (e instanceof OidcNetworkError) return oauth(503, "unavailable");
    return refused();
  }

  const found = await findLinkedAccount(env, db, product.slug, id, now);
  if (found === "refused") return refused();
  const base = {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: null,
    actor_name: null,
    actor_email: null,
    action: "signin.exchange",
    target_kind: "device",
    target_id: deviceId,
    parent_id: null,
  };
  const url = `${new URL(req.url).origin}/${product.slug}/identity/authorize`;

  if (!found) {
    const handle = `lh_${randomToken(32)}`;
    const record: ExchangeLinkRecord = {
      product: product.slug,
      deviceId,
      keyThumbprint: await signKeyThumbprint(deviceKey),
      kind: id.kind,
      issuerKey: id.issuerKey,
      subject: id.subject,
      tenantScopes: id.tenantScopes,
      email: id.email,
      emailVerified: id.emailVerified,
      issuedAt: now,
      boundSubject:
        (await getDevice(db, product.slug, deviceId))?.subject ?? null,
    };
    await putArtefact(
      env,
      await exchangeLinkRef(env, product.slug, handle),
      JSON.stringify(record),
      LINK_HANDLE_TTL_SECONDS,
      { ifAbsent: true },
    );
    await appendAudit(db, {
      ...base,
      summary: `Native ${id.kind} sign-in found no link`,
    });
    return noStore(
      errorResponse(403, "interstitial_required", undefined, {
        reason: "no_link",
        url,
        linkHandle: handle,
        expiresIn: LINK_HANDLE_TTL_SECONDS,
      }),
    );
  }

  // An agreement key another device holds is refused before anything is bound.
  if (await agreeKeyHeldElsewhere(db, product.slug, spent.agreeKey, deviceId))
    return refused();

  const terms = await productTerms(
    { env, db, ...(settings ? { registry: settings } : {}) },
    product.slug,
  );
  if (
    terms &&
    !(await termsAccepted(db, found.accountId, product.slug, terms.version))
  ) {
    await appendAudit(db, {
      ...base,
      summary: `Native ${id.kind} sign-in needs the terms`,
    });
    return noStore(
      errorResponse(403, "interstitial_required", undefined, {
        reason: "terms",
        url,
      }),
    );
  }

  // L-1: no consent row for this product, or its scope changed, is never a token. The person sees
  // what the app asks and answers with `choice/complete` (§12.11.3 rule 1).
  const pub = await loadProductPublic(db, product.slug);
  if (!pub) return refused();
  const consent = await consentState(
    env,
    db,
    pub,
    found.accountId,
    now,
    settings,
  );
  if (consent.firstTime || consent.changed) {
    let grant: string;
    try {
      grant = await issueGrant(
        env,
        {
          product: product.slug,
          accountId: found.accountId,
          subject: found.subject,
          deviceId,
          scope: resolveScope(undefined, product) ?? [],
          keys: { signKey: deviceKey, agreeKey: spent.agreeKey },
          consent: { scopeHash: consent.scopeHash },
        },
        now,
      );
    } catch {
      return oauth(503, "unavailable");
    }
    await appendAudit(db, {
      ...base,
      summary: `Native ${id.kind} sign-in needs the person's consent`,
    });
    const client = await clientRecordFor(
      env,
      db,
      pub,
      "native",
      now,
      undefined,
    );
    const body: ConfirmSignIn = {
      status: "confirm",
      grant,
      expiresIn: CHOICE_GRANT_TTL_SECONDS,
      consent: {
        client: {
          appName: client.appName,
          developerName: client.developerName,
          iconUrl: client.iconUrl,
          nameVerified: client.nameVerified,
        },
        as: { provider: id.kind, email: id.email },
        items: consent.items,
        scopeHash: consent.scopeHash,
        firstTime: consent.firstTime,
        changed: consent.changed,
      },
    };
    return noStore(json(body));
  }

  const answered = await bindAndAnswer(
    { req, env, db, product, now },
    {
      accountId: found.accountId,
      subject: found.subject,
      email: found.email,
      deviceId,
      // What the person consented to, never more: a narrowed consent stays narrowed.
      scope: (resolveScope(undefined, product) ?? []).filter((c) =>
        (consent.claims ?? []).includes(c),
      ),
      licenseChoice: choice,
      choice: null,
      deviceName: form.get("device_name") ?? undefined,
      audit: {
        action: "signin.exchange",
        summary: `Signed in a device through a native ${id.kind} token`,
      },
      keys: { signKey: deviceKey, agreeKey: spent.agreeKey },
      heldSignKey: held,
      silentSingle: true,
    },
  );
  return answered.status === 200 ? withIssuedType(answered) : answered;
}

function noStore(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
}

/** A `TokenResponse` gains `issued_token_type`; a `choose` body (§12.5.1) is left as it is. */
async function withIssuedType(res: Response): Promise<Response> {
  const body = (await res.clone().json()) as Record<string, unknown>;
  if (body.status !== undefined) return res;
  const out = new Response(
    JSON.stringify({ ...body, issued_token_type: EXCHANGE_ISSUED_TOKEN_TYPE }),
    { status: res.status, headers: res.headers },
  );
  out.headers.delete("content-length");
  return out;
}

/**
 * The account a verified token is linked to, walking the tenant scopes in order: `null` when no
 * scope holds a link, `"refused"` when the account is unusable (disabled or being erased).
 */
async function findLinkedAccount(
  env: Env,
  db: Db,
  product: string,
  id: NativeIdentity,
  now: number,
): Promise<
  | { accountId: string; subject: string; email: string | null }
  | null
  | "refused"
> {
  for (const tenantScope of id.tenantScopes) {
    const r = await signIn(
      db,
      {
        issuerKey: id.issuerKey,
        tenantScope,
        subject: id.subject,
        kind: id.kind,
        // A developer-scoped link was stored unverified on purpose (it brings no licences and joins
        // nothing); a sign-in through it never touches the address or upgrades the flag.
        email: tenantScope === "" ? id.email : null,
        emailVerified: tenantScope === "" ? id.emailVerified : false,
        amr: [id.kind],
      },
      now,
      {
        env,
        linkedOnly: true,
        product: { slug: product, tenantScopes: id.tenantScopes },
      },
    );
    if (r.status === "signed_in") {
      if (r.account.status !== "active" || !r.subject) return "refused";
      return {
        accountId: r.account.id,
        subject: r.subject,
        email: r.account.primary_email,
      };
    }
    if (r.status === "refused" && r.reason === "account_disabled")
      return "refused";
  }
  return null;
}
