/// <reference types="@cloudflare/workers-types" />

/**
 * Device attestation (P6-02): the two Core routes that raise a device to the `attested` trust
 * level (`core/deviceTrust.ts`).
 *
 *   POST /<p>/devices/attest/challenge   → `{challenge, requestHash, expiresAt, play?}`
 *   POST /<p>/devices/attest             ← `{kind: "app-attest", keyId, attestation, challenge}`
 *                                          or `{kind: "play-integrity", token, challenge}`
 *                                        → `{trustLevel: "attested", kind, attestedAt}`
 *
 * Both authenticate with the device bearer token, under the same rule as `/devices/report`: when
 * the License service is on the device's licence must be usable. Neither changes a signed
 * document or the device token — the level lives on the device row only.
 *
 * ── THE CHALLENGE ───────────────────────────────────────────────────────────────────────────
 *
 * 32 random bytes, base64url, stored in KV for five minutes under the product and bound to the
 * device id. The attest route consumes it BEFORE verifying (delete-on-read), so a challenge is
 * spent whether the attestation passes or not. `requestHash` is the one value the client feeds
 * the platform API: `base64url(SHA-256("pkey-attest/1:<product>:<deviceId>:<challenge>"))`.
 * App Attest's `clientDataHash` is `SHA-256(UTF-8(requestHash))`; a standard Play Integrity
 * request passes `requestHash` verbatim. The Worker recomputes it from the stored binding, so a
 * challenge issued to one device cannot be redeemed by another, nor on another product.
 *
 * KV is eventually consistent and has no compare-and-delete: two redemptions of one challenge at
 * the same instant may both read it. Both still need a genuine attestation bound to the same
 * device and challenge, so the residual is a duplicated verdict, not a forged one
 * (THREAT-MODEL.md, "Device trust levels").
 *
 * ── RATE LIMITS ─────────────────────────────────────────────────────────────────────────────
 *
 * Per device, failing CLOSED: `attestChallenge` 10/hour and `attest` 4/hour (a reinstall's
 * re-attest plus retries). Play Integrity's default quota is 10,000 decodes a day per app; the
 * per-device budget keeps one device from spending it, and the token exchange is cached.
 *
 * ── FAILURES ────────────────────────────────────────────────────────────────────────────────
 *
 *   400 bad_request              malformed body
 *   401 unauthorized             no usable device token
 *   409 attestation_unavailable  the product is not set up for this kind (no Team ID or App
 *                                Store/TestFlight outlet; no pinned Play credential)
 *   422 attestation_rejected     a used, expired or foreign challenge, or a verdict that failed
 *                                any check — one code, the reason kept for the audit trail
 *   503 attestation_unavailable  Google could not be reached or refused our credential
 *
 * A refused verdict is recorded on the device (`attestation_json`) and never changes its level.
 *
 * ── CUSTODY ─────────────────────────────────────────────────────────────────────────────────
 *
 * This module is the one Core file allowed to import `core/outletTokens.ts` besides Distribution
 * (outletCredentialReach.test.ts): decoding an integrity token needs an OAuth token for the
 * product's pinned `google-service-account` credential. It never opens the credential itself and
 * never learns its value; it asks for a token at the Play Integrity scope only.
 */

import { claimOnce } from "./atomicClaim.js";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import type { ServiceHooks } from "./hooks.js";
import { bearer } from "../http.js";
import { appendAudit, setDeviceTrust, type DeviceRow } from "../repo.js";
import { randomId } from "../crypto.js";
import { pk } from "../kv.js";
import { ErrorCode, json, methodNotAllowed, wireError } from "./errors.js";
import { rateLimitOk } from "./rateLimit.js";
import { licenseUsable, validateDeviceToken } from "./devices.js";
import { trustPolicyOf } from "./deviceTrust.js";
import { decodeBase64Any, verifyAppAttestation } from "./appAttest.js";
import { sha256, sha256B64url } from "../platform/hash.js";
import { randomToken } from "../platform/random.js";
import { checkPlayVerdict, PLAY_INTEGRITY_SCOPE } from "./playIntegrity.js";
import { googleAccessTokenFor, type FetchImpl } from "./outletTokens.js";
import {
  platformAppleTeamId,
  platformPlayIntegrityProjectNumber,
} from "./platformStoreSettings.js";
import { isRedirect, readCappedText } from "./readCapped.js";

export const ATTEST_CHALLENGE_TTL = 5 * 60;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** An attestation object is ~5–6 KB of base64; an integrity token a few KB. */
const MAX_ATTEST_BODY = 32 * 1024;
const MAX_DECODE_RESPONSE = 64 * 1024;
const PLAY_INTEGRITY_ORIGIN = "https://playintegrity.googleapis.com";

export const ATTEST_LIMITS = {
  challenge: { bucket: "attestChallenge", limit: 10, windowSec: 3600 },
  attest: { bucket: "attest", limit: 4, windowSec: 3600 },
} as const;

/** Injectable dependencies — TESTS ONLY. Production dispatch passes nothing. */
export interface AttestDeps {
  fetchImpl?: FetchImpl;
  /** Trust anchors for App Attest instead of the pinned Apple root. */
  appAttestRoots?: readonly Uint8Array[];
}

interface ChallengeRecord {
  deviceId: string;
  exp: number;
}

function challengeKey(product: string, challenge: string): string {
  return pk(product, "attest-challenge", challenge);
}

/** The binding a client feeds the platform API (see the header). */
export async function attestRequestHash(
  product: string,
  deviceId: string,
  challenge: string,
): Promise<string> {
  return sha256B64url(`pkey-attest/1:${product}:${deviceId}:${challenge}`);
}

async function authenticate(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<DeviceRow | null> {
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return null;
  if (product.services.license.enabled && !licenseUsable(valid.license, now))
    return null;
  return valid.device;
}

function unauthorized(): Response {
  return wireError(401, ErrorCode.Unauthorized);
}

function badRequest(message: string): Response {
  return wireError(400, ErrorCode.BadRequest, { message });
}

/** `POST /<p>/devices/attest/challenge`. */
export async function handleAttestChallenge(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const device = await authenticate(req, env, db, product, now);
  if (!device) return unauthorized();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...ATTEST_LIMITS.challenge, id: device.device_id },
      now,
    ))
  )
    return wireError(429, "rate_limited");

  const challenge = randomToken(32);
  const expiresAt = now + ATTEST_CHALLENGE_TTL;
  const rec: ChallengeRecord = { deviceId: device.device_id, exp: expiresAt };
  await env.HOT.put(
    challengeKey(product.slug, challenge),
    JSON.stringify(rec),
    {
      expirationTtl: ATTEST_CHALLENGE_TTL,
    },
  );
  const policy = trustPolicyOf(product);
  // A-16: an explicit project number wins; omitted, the platform's applies.
  const cloudProjectNumber = policy.playIntegrity
    ? (policy.playIntegrity.cloudProjectNumber ??
      (await platformPlayIntegrityProjectNumber(env, db)))
    : null;
  return json({
    challenge,
    requestHash: await attestRequestHash(
      product.slug,
      device.device_id,
      challenge,
    ),
    expiresAt,
    ...(cloudProjectNumber !== null ? { play: { cloudProjectNumber } } : {}),
  });
}

/** Consume a challenge: `true` only for one issued to this device that has not expired. */
async function consumeChallenge(
  env: Env,
  product: string,
  deviceId: string,
  challenge: string,
  now: number,
): Promise<boolean> {
  const key = challengeKey(product, challenge);
  const raw = await env.HOT.get(key);
  if (raw === null) return false;
  // The KV get/delete pair lets two concurrent attests both read the record; the
  // redemption is claimed in the single-use Durable Object so exactly one wins.
  if (!(await claimOnce(env, "attest-claim", key, 86_400))) return false;
  await env.HOT.delete(key);
  try {
    const rec = JSON.parse(raw) as Partial<ChallengeRecord>;
    return (
      rec.deviceId === deviceId && typeof rec.exp === "number" && now <= rec.exp
    );
  } catch {
    return false;
  }
}

type AttestBody =
  | {
      kind: "app-attest";
      keyId: string;
      attestation: string;
      challenge: string;
    }
  | { kind: "play-integrity"; token: string; challenge: string };

async function readAttestBody(req: Request): Promise<AttestBody | string> {
  let text: string;
  try {
    text = await readCappedText(
      new Response(req.body, {
        headers: { "content-length": req.headers.get("content-length") ?? "" },
      }),
      MAX_ATTEST_BODY,
      () => new Error("too large"),
    );
  } catch {
    return "body too large";
  }
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return "body must be an object";
    o = v as Record<string, unknown>;
  } catch {
    return "body is not JSON";
  }
  if (typeof o.challenge !== "string" || !CHALLENGE_RE.test(o.challenge))
    return "missing or malformed challenge";
  if (o.kind === "app-attest") {
    if (
      typeof o.keyId !== "string" ||
      o.keyId.length === 0 ||
      o.keyId.length > 64
    )
      return "missing or malformed keyId";
    if (typeof o.attestation !== "string" || o.attestation.length === 0)
      return "missing attestation";
    return {
      kind: "app-attest",
      keyId: o.keyId,
      attestation: o.attestation,
      challenge: o.challenge,
    };
  }
  if (o.kind === "play-integrity") {
    if (
      typeof o.token !== "string" ||
      o.token.length === 0 ||
      o.token.length > 16 * 1024
    )
      return "missing or malformed token";
    return { kind: "play-integrity", token: o.token, challenge: o.challenge };
  }
  return 'kind must be "app-attest" or "play-integrity"';
}

interface Outcome {
  attested: boolean;
  /** The verdict summary stored on the device: never a raw token or attestation object. */
  summary: Record<string, unknown>;
  /** A refusal answered instead of 422 (409/503: the product's setup, not the device). */
  unavailable?: { status: 409 | 503; message: string };
}

async function verifyAppAttest(
  body: Extract<AttestBody, { kind: "app-attest" }>,
  env: Env,
  db: Db,
  product: Product,
  hooks: ServiceHooks,
  requestHash: string,
  now: number,
  deps: AttestDeps,
): Promise<Outcome> {
  const policy = trustPolicyOf(product);
  const targets = await hooks.delivery()?.attestationTargets?.();
  // A-16: an explicit Team ID wins; omitted, the platform's Apple Team ID applies.
  const teamId = policy.appAttest
    ? (policy.appAttest.teamId ?? (await platformAppleTeamId(env, db)))
    : null;
  if (
    !policy.appAttest ||
    teamId === null ||
    !targets ||
    targets.appleBundleIds.length === 0
  )
    return {
      attested: false,
      summary: { kind: "app-attest", outcome: "unavailable" },
      unavailable: {
        status: 409,
        message:
          "App Attest is not set up for this product (an operator sets the Team ID; .pkey/distribution declares an app-store or testflight outlet)",
      },
    };
  const attestation = decodeBase64Any(body.attestation);
  if (!attestation || attestation.length > MAX_ATTEST_BODY)
    return {
      attested: false,
      summary: { kind: "app-attest", outcome: "rejected", reason: "malformed" },
    };
  const clientDataHash = await sha256(requestHash);
  const result = await verifyAppAttestation({
    attestation,
    keyId: body.keyId,
    clientDataHash,
    appIds: targets.appleBundleIds.map((b) => `${teamId}.${b}`),
    environment: policy.appAttest.environment,
    now,
    ...(deps.appAttestRoots ? { roots: deps.appAttestRoots } : {}),
  });
  if (!result.ok)
    return {
      attested: false,
      summary: {
        kind: "app-attest",
        outcome: "rejected",
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
      },
    };
  return {
    attested: true,
    summary: {
      kind: "app-attest",
      outcome: "attested",
      appId: result.appId,
      environment: result.environment,
      keyId: result.keyId,
      // Kept for later assertions (generateAssertion verification is a follow-up).
      publicKey: result.publicKey,
      counter: 0,
    },
  };
}

async function verifyPlay(
  body: Extract<AttestBody, { kind: "play-integrity" }>,
  env: Env,
  db: Db,
  product: Product,
  hooks: ServiceHooks,
  requestHash: string,
  now: number,
  deps: AttestDeps,
): Promise<Outcome> {
  const targets = await hooks.delivery()?.attestationTargets?.();
  const play = targets?.play;
  if (!play || play.packageName === null)
    return {
      attested: false,
      summary: { kind: "play-integrity", outcome: "unavailable" },
      unavailable: {
        status: 409,
        message:
          "Play Integrity is not set up for this product (a play outlet with a google-service-account credential pinned to its package)",
      },
    };
  const fetchImpl: FetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const upstream = (message: string): Outcome => ({
    attested: false,
    summary: { kind: "play-integrity", outcome: "unavailable" },
    unavailable: { status: 503, message },
  });

  let access: string | null;
  try {
    // A product on the platform's Play service account (A-16) gets its token through the pinned
    // platform path; the pin is the package being verified.
    access = await googleAccessTokenFor(
      env,
      db,
      product.slug,
      play.credentialId,
      play.packageName,
      [PLAY_INTEGRITY_SCOPE],
      "play:integrity",
      now,
      fetchImpl,
    );
  } catch {
    return upstream("could not obtain a Google token for Play Integrity");
  }
  if (!access) return upstream("the Play credential is not usable");

  const res = await fetchImpl(
    `${PLAY_INTEGRITY_ORIGIN}/v1/${encodeURIComponent(play.packageName)}:decodeIntegrityToken`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ integrity_token: body.token }),
    },
  );
  if (
    isRedirect(res) ||
    res.status >= 500 ||
    res.status === 401 ||
    res.status === 403 ||
    res.status === 429
  ) {
    await res.body?.cancel().catch(() => undefined);
    return upstream(`Play Integrity answered ${res.status}`);
  }
  if (!res.ok) {
    // 400: Google could not decode the token — the device's problem, not ours.
    await res.body?.cancel().catch(() => undefined);
    return {
      attested: false,
      summary: {
        kind: "play-integrity",
        outcome: "rejected",
        reason: "undecodable",
      },
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      await readCappedText(
        res,
        MAX_DECODE_RESPONSE,
        () => new Error("too large"),
      ),
    );
  } catch {
    return upstream("Play Integrity returned no JSON");
  }
  const verdict = checkPlayVerdict(decoded, {
    packageName: play.packageName,
    requestHash,
    now,
    allowTestingResponses:
      trustPolicyOf(product).playIntegrity?.allowTestingResponses === true,
  });
  const summary = verdict.summary
    ? {
        appRecognitionVerdict: verdict.summary.appRecognitionVerdict,
        deviceRecognitionVerdict: verdict.summary.deviceRecognitionVerdict,
        appLicensingVerdict: verdict.summary.appLicensingVerdict,
        versionCode: verdict.summary.versionCode,
        isTestingResponse: verdict.summary.isTestingResponse,
        verdictAt: Math.floor(verdict.summary.timestampMillis / 1000),
      }
    : {};
  if (!verdict.ok)
    return {
      attested: false,
      summary: {
        kind: "play-integrity",
        outcome: "rejected",
        reason: verdict.reason,
        packageName: play.packageName,
        ...summary,
      },
    };
  return {
    attested: true,
    summary: {
      kind: "play-integrity",
      outcome: "attested",
      packageName: play.packageName,
      ...summary,
    },
  };
}

/** `POST /<p>/devices/attest`. */
export async function handleAttest(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  hooks: ServiceHooks,
  deps: AttestDeps = {},
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const device = await authenticate(req, env, db, product, now);
  if (!device) return unauthorized();
  // Counted before the body is read or the challenge spent: a device out of budget learns
  // nothing and costs no decode.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...ATTEST_LIMITS.attest, id: device.device_id },
      now,
    ))
  )
    return wireError(429, "rate_limited");

  const body = await readAttestBody(req);
  if (typeof body === "string") return badRequest(body);

  if (
    !(await consumeChallenge(
      env,
      product.slug,
      device.device_id,
      body.challenge,
      now,
    ))
  )
    return wireError(422, "attestation_rejected", {
      message: "the challenge is unknown, used, expired or not this device's",
    });
  const requestHash = await attestRequestHash(
    product.slug,
    device.device_id,
    body.challenge,
  );

  const outcome =
    body.kind === "app-attest"
      ? await verifyAppAttest(
          body,
          env,
          db,
          product,
          hooks,
          requestHash,
          now,
          deps,
        )
      : await verifyPlay(body, env, db, product, hooks, requestHash, now, deps);

  if (outcome.unavailable)
    return wireError(outcome.unavailable.status, "attestation_unavailable", {
      message: outcome.unavailable.message,
    });

  await setDeviceTrust(db, product.slug, device.device_id, {
    attested: outcome.attested,
    at: now,
    json: JSON.stringify({ ...outcome.summary, at: now }),
  });
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: "system:trust",
    actor_name: "Device attestation",
    actor_email: null,
    action: outcome.attested ? "device.attest" : "device.attest.rejected",
    target_kind: "device",
    target_id: device.device_id,
    parent_id: null,
    summary: outcome.attested
      ? `${body.kind}: attested`
      : `${body.kind}: rejected (${String(outcome.summary.reason ?? "unknown")})`,
  });

  if (!outcome.attested)
    return wireError(422, "attestation_rejected", {
      message: "the attestation did not verify",
    });
  return json({ trustLevel: "attested", kind: body.kind, attestedAt: now });
}
