/**
 * The WebAuthn half of passkeys (I-16; S-16 §5.4 items 7, 14 and 17): the relying party, the
 * policy, the challenge records, and the two verifications, over `@simplewebauthn/server` (which
 * runs on WebCrypto, so it runs under workerd: `test-workerd/passkeys.test.ts`).
 *
 * ── THE POLICY ──────────────────────────────────────────────────────────────────────────────
 *
 *   - **One relying party: the console host.** `rp.id` is the host of `CONSOLE_ORIGIN`
 *     (`key.plrs.im` in production; the request's own origin where it is unset, as for every
 *     portal link), and a ceremony is served only on that origin. Both verifications pin the
 *     exact origin (`https://key.plrs.im`, no subdomain, no port) and the SHA-256 of the RP id in
 *     the authenticator data, so an assertion made for a look-alike site is refused here.
 *   - **User verification required** at registration and at sign-in (a biometric or the device
 *     PIN, the UV flag), and user presence: a passkey is a whole sign-in on its own, never a
 *     second factor, so it must prove the person, not just the device.
 *   - **Discoverable credentials only** (`residentKey: required`), so the card can offer them
 *     before anyone types an address (conditional UI) and the sign-in names no account up front.
 *   - **Algorithms** EdDSA, ES256 and RS256; any other key is refused at registration.
 *   - **No attestation** is asked for (`none`): the person's own choice of authenticator is not
 *     ours to vet. A statement an authenticator sends anyway is still checked by the library.
 *   - **Challenges are single use**: 32 random bytes in I-02's single-use store for 5 minutes,
 *     taken by an atomic consume BEFORE anything is verified, so a response verifies at most once
 *     and a failed attempt needs a new challenge.
 *   - **Counters**: a counter that did not advance (when either side is non-zero) refuses the
 *     sign-in as a possible cloned authenticator; synced passkeys report 0 and are unaffected.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { hashKey } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { portalOriginOf } from "../../../core/licensing/manageUrl.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { cleanTransports, type PasskeyRow } from "./repo.js";

/** How long a ceremony (its challenge) lives: the browser's prompt timeout too. */
export const PASSKEY_CEREMONY_TTL_SECONDS = 5 * 60;
/** EdDSA, ES256, RS256 (COSE ids), in the order offered. */
export const PASSKEY_ALGORITHMS = [-8, -7, -257];
/** The name an authenticator shows for the relying party. */
export const PASSKEY_RP_NAME = "Polaris Key";

/** base64url, as WebAuthn's JSON forms carry it. */
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A credential id is at most 1023 bytes: 1364 base64url characters. */
const MAX_CREDENTIAL_ID = 1364;
/** A user handle is at most 64 bytes: 86 base64url characters. */
const MAX_USER_HANDLE = 86;
/** Generous caps on the other fields; a real browser sends far less. */
const MAX_CLIENT_DATA = 8 * 1024;
const MAX_AUTHENTICATOR_DATA = 8 * 1024;
const MAX_SIGNATURE = 2 * 1024;
const MAX_ATTESTATION_OBJECT = 64 * 1024;

export interface RelyingParty {
  /** The RP id: the console host (`key.plrs.im`). */
  id: string;
  /** The one origin a ceremony may come from (`https://key.plrs.im`). */
  origin: string;
  name: string;
}

/**
 * The relying party for this request, or `null` when the request did not arrive on the console
 * origin (a ceremony is never served anywhere else, so no other host can mint a challenge that a
 * key.plrs.im passkey would answer).
 */
export function passkeyRelyingParty(
  env: Env,
  req: Request,
): RelyingParty | null {
  const origin = portalOriginOf(env, req);
  if (!origin) return null;
  let here: URL;
  try {
    here = new URL(req.url);
  } catch {
    return null;
  }
  if (here.origin !== origin) return null;
  return { id: here.hostname, origin, name: PASSKEY_RP_NAME };
}

// ── Challenge records (I-02's single-use store) ─────────────────────────────────────────────

export interface SignInCeremony {
  v: 1;
  purpose: "signin";
  challenge: string;
  rpId: string;
  createdAt: number;
  returnTo?: string;
}

export interface RegisterCeremony {
  v: 1;
  purpose: "register";
  challenge: string;
  rpId: string;
  createdAt: number;
  accountId: string;
  userHandle: string;
}

type Ceremony = SignInCeremony | RegisterCeremony;

/** The sign-in ceremony of the browser holding `secret` (the passkey flow cookie). */
export async function signInCeremonyRef(
  env: Env,
  secret: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "webauthn-challenge",
    await hashKey(`passkey-signin:${secret}`, env.KEY_HASH_PEPPER),
  );
}

/** The registration ceremony of one account session (its row key, `account_sessions.id_hash`):
 *  one at a time per session, a new one replacing the last. */
export async function registerCeremonyRef(
  env: Env,
  sessionIdHash: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "webauthn-challenge",
    await hashKey(`passkey-register:${sessionIdHash}`, env.KEY_HASH_PEPPER),
  );
}

export async function putCeremony(
  env: Env,
  ref: ArtefactRef,
  ceremony: Ceremony,
): Promise<void> {
  await putArtefact(
    env,
    ref,
    JSON.stringify(ceremony),
    PASSKEY_CEREMONY_TTL_SECONDS,
  );
}

/** Take (consume) the ceremony at `ref`: of any number of concurrent takers, one gets it. */
export async function takeCeremony<P extends Ceremony["purpose"]>(
  env: Env,
  ref: ArtefactRef,
  purpose: P,
): Promise<Extract<Ceremony, { purpose: P }> | null> {
  const raw = await consumeArtefact(env, ref);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Ceremony;
    if (record?.v !== 1 || record.purpose !== purpose) return null;
    if (typeof record.challenge !== "string" || record.challenge === "")
      return null;
    return record as Extract<Ceremony, { purpose: P }>;
  } catch {
    return null;
  }
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────

/** Sign-in options: discoverable credentials, user verification required. */
export function signInOptions(
  rp: RelyingParty,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "required",
    timeout: PASSKEY_CEREMONY_TTL_SECONDS * 1000,
  });
}

/** Registration options under the account's user handle, excluding the passkeys it has. */
export function registrationOptions(
  rp: RelyingParty,
  user: { handle: string; name: string; displayName: string },
  exclude: ReadonlyArray<{ id: string; transports: string[] }>,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: isoBase64URL.toBuffer(user.handle),
    userName: user.name,
    userDisplayName: user.displayName,
    timeout: PASSKEY_CEREMONY_TTL_SECONDS * 1000,
    attestationType: "none",
    excludeCredentials: exclude.map((c) => ({
      id: c.id,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
  });
}

// ── Response shapes ─────────────────────────────────────────────────────────────────────────

function b64(raw: unknown, max: number): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= max &&
    B64URL.test(raw)
  );
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** A browser's `PublicKeyCredential.toJSON()` from `navigator.credentials.get`, bounded; or null. */
export function parseAuthenticationResponse(
  raw: unknown,
): AuthenticationResponseJSON | null {
  const cred = record(raw);
  const res = record(cred?.response);
  if (!cred || !res) return null;
  if (cred.type !== "public-key") return null;
  if (!b64(cred.id, MAX_CREDENTIAL_ID) || cred.rawId !== cred.id) return null;
  if (!b64(res.clientDataJSON, MAX_CLIENT_DATA)) return null;
  if (!b64(res.authenticatorData, MAX_AUTHENTICATOR_DATA)) return null;
  if (!b64(res.signature, MAX_SIGNATURE)) return null;
  if (
    res.userHandle !== undefined &&
    res.userHandle !== null &&
    !b64(res.userHandle, MAX_USER_HANDLE)
  )
    return null;
  return {
    id: cred.id,
    rawId: cred.id,
    type: "public-key",
    response: {
      clientDataJSON: res.clientDataJSON,
      authenticatorData: res.authenticatorData,
      signature: res.signature,
      ...(typeof res.userHandle === "string"
        ? { userHandle: res.userHandle }
        : {}),
    },
    clientExtensionResults: {},
  };
}

/** A browser's `PublicKeyCredential.toJSON()` from `navigator.credentials.create`, bounded. */
export function parseRegistrationResponse(
  raw: unknown,
): RegistrationResponseJSON | null {
  const cred = record(raw);
  const res = record(cred?.response);
  if (!cred || !res) return null;
  if (cred.type !== "public-key") return null;
  if (!b64(cred.id, MAX_CREDENTIAL_ID) || cred.rawId !== cred.id) return null;
  if (!b64(res.clientDataJSON, MAX_CLIENT_DATA)) return null;
  if (!b64(res.attestationObject, MAX_ATTESTATION_OBJECT)) return null;
  return {
    id: cred.id,
    rawId: cred.id,
    type: "public-key",
    response: {
      clientDataJSON: res.clientDataJSON,
      attestationObject: res.attestationObject,
      transports: cleanTransports(
        res.transports,
      ) as AuthenticatorTransportFuture[],
    },
    clientExtensionResults: {},
  };
}

/** The user handle in an assertion, normalised for comparison (no padding). */
export function assertionUserHandle(
  response: AuthenticationResponseJSON,
): string | null {
  const h = response.response.userHandle;
  return typeof h === "string" && h !== "" ? h.replace(/=+$/, "") : null;
}

// ── Verification ────────────────────────────────────────────────────────────────────────────

export type AssertionVerdict =
  | {
      ok: true;
      counter: number;
      deviceType: "singleDevice" | "multiDevice";
      backedUp: boolean;
    }
  | { ok: false; reason: "invalid" | "counter" };

/** WebAuthn §7.2 step 22, as a rule: either counter non-zero and the new one not above the stored. */
export function counterRegressed(stored: number, next: number): boolean {
  return (next > 0 || stored > 0) && next <= stored;
}

/**
 * Verify a sign-in assertion against a stored passkey: the challenge this browser was given, the
 * exact origin, the RP id hash, user presence AND verification, the signature under the stored
 * key, then the counter.
 *
 * The counter rule is applied HERE, after the signature, rather than inside the library: the
 * library compares counters before it checks the signature, so its refusal cannot tell a cloned
 * authenticator (a valid signature with a stale counter) from a forgery. It is handed counter 0,
 * which disables only that comparison, and the identical rule (`counterRegressed`) then runs on
 * the counter of an assertion whose signature is proven.
 */
export async function verifyAssertion(input: {
  response: AuthenticationResponseJSON;
  challenge: string;
  rp: RelyingParty;
  passkey: PasskeyRow;
  transports: string[];
}): Promise<AssertionVerdict> {
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      expectedType: "webauthn.get",
      credential: {
        id: input.passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(input.passkey.public_key),
        counter: 0,
        transports: input.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const info = result.authenticationInfo;
  if (!result.verified || !info.userVerified || info.rpID !== input.rp.id) {
    return { ok: false, reason: "invalid" };
  }
  if (counterRegressed(input.passkey.sign_count, info.newCounter)) {
    return { ok: false, reason: "counter" };
  }
  return {
    ok: true,
    counter: info.newCounter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

export type RegistrationVerdict =
  | {
      ok: true;
      credentialId: string;
      /** The COSE public key, base64url. */
      publicKey: string;
      counter: number;
      transports: string[];
      aaguid: string;
      deviceType: "singleDevice" | "multiDevice";
      backedUp: boolean;
    }
  | { ok: false };

/**
 * Verify a registration: the challenge of this session's ceremony, the exact origin, the RP id
 * hash, user presence AND verification, an allowed algorithm, and any attestation statement. The
 * credential id stored is the one in the authenticator data, and it must be the id the browser
 * reported.
 */
export async function verifyRegistration(input: {
  response: RegistrationResponseJSON;
  challenge: string;
  rp: RelyingParty;
}): Promise<RegistrationVerdict> {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
    });
  } catch {
    return { ok: false };
  }
  if (!result.verified) return { ok: false };
  const info = result.registrationInfo;
  if (
    !info.userVerified ||
    info.rpID !== input.rp.id ||
    info.credential.id !== input.response.id
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    credentialId: info.credential.id,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports: cleanTransports(input.response.response.transports),
    aaguid: info.aaguid,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}
