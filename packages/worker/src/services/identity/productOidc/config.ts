/// <reference types="@cloudflare/workers-types" />

import { isSafeIssuerUrl } from "@polaris-key/manifest";
import { hashKey } from "../../../platform/crypto.js";
import { platformOidcConfig } from "../../../platform/platformOidc.js";
import { secret, type Env } from "../../../platform/env.js";
import type { Db } from "../../../db/types.js";
import { openProductSecret, type Product } from "../../../core/products.js";
import { errorResponse } from "../../../core/errors.js";
import { rateLimitOk, type RateLimit } from "../../../core/rateLimit.js";
import { type ChoiceNotice } from "../licenseChoice.js";
import { artefactRef, type ArtefactRef } from "../../../core/singleUse.js";
import {
  type OidcConfigRow,
  type OidcIdentity,
  getOidcConfig,
} from "../../../core/licensing/issue.js";

export const FLOW_TTL_SECONDS = 600;

/** The poll cadence advertised by `/identity/auth/device/start`, enforced server-side (R8-02). */
export const DEVICE_POLL_INTERVAL_SECONDS = 2;

export interface ResolvedOidcConfig {
  row: OidcConfigRow;
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

export interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  /** The device that started a device-code flow. `pollAuthFlow` mints only for this device.
   *  The callback deliberately does NOT use it to claim or migrate the license that device is
   *  on: the flow is confirmed with the public user code (P1-06 security fix). */
  deviceId?: string;
  licenseId?: string;
  error?: string;
  /** Stamped when the human confirms the device-code flow. A device flow may only mint after
   *  this is set — the poll must not be able to skip the confirmation (R8-01). */
  confirmedAt?: number;
  /** Stamped by the first callback that claims this state. A state is single-use: a second
   *  callback must never be able to rebind `licenseId` under a waiting poller (R8-04). */
  consumedAt?: number;
  /** Set on a flow `/device/start` began. Such a flow redeems ONLY through `/device/poll`, with
   *  the secret device code: `state` rides on the authorize URL the confirmation POST 303s to,
   *  and the device id can be on the page, so a `state`-keyed poll would have been a redemption
   *  handle for anyone who holds the user code (R8-02, P1-06). The one such surface,
   *  `/identity/auth/poll`, is retired; `/device/poll` is the only poll. */
  viaDeviceCode?: boolean;
  /** A device-code flow's verified identity, stored by the callback INSTEAD of activating it
   *  (P1-07). Activation happens at `/device/poll`, where the device-code holder decides whether
   *  the device's anonymous enrolled licence is attached; until then no licence row is created,
   *  claimed or changed. */
  identity?: OidcIdentity;
  /** Stamped the first time `/device/poll` answered `confirm`, i.e. the device was shown the
   *  signed-in identity. An attach decision is honoured only after this (P1-07). */
  identityShownAt?: number;
  /** I-26: set on a flow of a `provider: platform` product, the only kind the licence chooser
   *  can apply to. Such a flow gets a browser binder where a browser joins it. */
  binderEligible?: boolean;
  /** I-26: the hash of the `__Host-pk_lcb` cookie of the browser that started (`/auth/start`)
   *  or confirmed (the device page's POST) the flow. The chooser answers only that browser. */
  binder?: string;
  /** The label the device-code client sent (`deviceName`), for the chooser and its audit row. */
  deviceName?: string;
  /** I-26: the chooser is open. Nothing completes, and the poll answers `pending`, until the
   *  person's choice is recorded. */
  choiceOpen?: boolean;
  /** I-26: the account the chooser lists licences of. Server-side only; never on a page. */
  choiceAccount?: string;
  /** I-26: a browser flow's verified identity, kept for the activation a choice of the
   *  identity's own licence (or a new one) runs. Device-code flows keep theirs in `identity`. */
  choiceIdentity?: OidcIdentity;
  /** I-26: the hash of the single-use token the current chooser page carries. */
  choiceToken?: string;
  /** I-26: the Replace confirmation pending on the chooser (a licence and one of its devices). */
  choiceReplace?: { licenseId: string; deviceId: string };
  /** I-26: a one-line notice the next chooser render shows, then drops. */
  choiceNotice?: ChoiceNotice;
  /** I-17: the account the callback's claim signed this platform-IdP subject in to. The licence
   *  the flow activates later (the device-code poll, the chooser) attaches to it. Server-side
   *  only; never on a page. */
  claimAccount?: string;
}

export interface DeviceFlowRecord {
  state: string;
  deviceId: string;
  userCode: string;
  authorizeUrl: string;
  deviceName?: string;
  confirmedAt?: number;
  /** Minted on the GET render and required by the POST confirmation, so the state-mutating
   *  half of device verification cannot be driven cross-site (R8-02). */
  csrf?: string;
  /** Last poll, for the advertised `interval` throttle (R8-02). */
  lastPollAt?: number;
}

/**
 * Operator allowlist of hosts a **repo-owned** (`provider: custom`) OIDC issuer may name, read
 * from the `OIDC_ISSUER_ALLOWLIST` var as a comma/whitespace-separated host list.
 *
 * This is the control that closes the *rest* of R9-01. `isSafeIssuerUrl` stops a manifest from
 * naming a private/loopback/link-local address or plain http, but it cannot stop
 * `https://exfil.attacker.example` — a public https host is indistinguishable from a real IdP
 * at the character level, and that host still receives a POST containing the product's OIDC
 * `client_secret`. Only an operator-curated host list distinguishes them.
 *
 * **Unset fails closed in production.** On the `prod` environment an unset or empty list refuses
 * every custom issuer, so a public https host can never receive the client secret by default;
 * operators list their custom issuers' hosts before deploying. Outside `prod` (staging, dev,
 * local and test Workers) an unset list is not enforced. The ingest check (`release/linkRepo.ts`)
 * fails closed everywhere for a new issuer. The platform issuer is exempt: it is a Worker secret,
 * not a repo-supplied value.
 */
export function issuerHostAllowed(env: Env, issuer: string): boolean {
  const raw = secret(env, "OIDC_ISSUER_ALLOWLIST");
  // In production an unset allowlist refuses every custom issuer rather than
  // letting any public https host receive the client secret.
  const prod = env.PKEY_ENVIRONMENT?.trim().toLowerCase() === "prod";
  if (!raw) return !prod;
  const hosts = raw
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return !prod;
  try {
    return hosts.includes(new URL(issuer).host.toLowerCase());
  } catch {
    return false;
  }
}

export async function resolveOidcConfig(
  env: Env,
  db: Db,
  product: Product,
): Promise<ResolvedOidcConfig | Response> {
  const row = await getOidcConfig(db, product.slug);
  if (!row) return errorResponse(404, "disabled", "oidc is disabled");
  if ((row.provider ?? "platform") === "custom") {
    if (!row.issuer || !row.client_id) {
      return errorResponse(500, "misconfigured", "custom oidc config missing");
    }
    // R9-01/R9-02, at the sink. `oidc_config.issuer` is written from a linked repo's
    // `.pkey/product` manifest, and it is the base of the token POST that carries this
    // product's client secret, of the JWKS fetch that decides which keys may sign an ID
    // token, and of the anonymous 302 out of `/<product>/identity/auth/start`. The manifest validator
    // now refuses a non-https or private/loopback/link-local/reserved issuer — this repeats
    // that check against what is actually in D1, so a row written before the validator gained
    // it (or by any writer that skips `parseManifest`) still cannot aim those requests.
    // Deliberately BEFORE `openProductSecret`: an unusable config must not unseal the secret.
    if (!isSafeIssuerUrl(row.issuer)) {
      return errorResponse(
        500,
        "misconfigured",
        "custom oidc issuer is not permitted",
      );
    }
    if (!issuerHostAllowed(env, row.issuer)) {
      return errorResponse(
        500,
        "misconfigured",
        "custom oidc issuer is not permitted",
      );
    }
    let clientSecret: string | undefined;
    if (row.client_secret_secret) {
      // A secret an operator marked for edge-minting is not an OIDC client secret (P0-12).
      clientSecret = await openProductSecret(
        db,
        env,
        product.slug,
        row.client_secret_secret,
        "general",
      );
      if (!clientSecret) {
        return errorResponse(
          500,
          "misconfigured",
          "oidc client secret unavailable",
        );
      }
    }
    return {
      row,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret,
    };
  }

  const platform = platformOidcConfig(env);
  if (!platform) {
    return errorResponse(
      500,
      "misconfigured",
      "platform oidc is not configured",
    );
  }
  // The platform issuer is operator-owned (a Worker secret), not repo-owned, so this is not
  // the R9-01 boundary — but the same request shapes hang off it, so it gets the same rule.
  if (!isSafeIssuerUrl(platform.issuer)) {
    return errorResponse(
      500,
      "misconfigured",
      "platform oidc issuer is not permitted",
    );
  }
  return {
    row,
    issuer: platform.issuer,
    clientId: platform.clientId,
    clientSecret: platform.clientSecret,
  };
}

/**
 * Single-use store address (`core/singleUse.ts`, I-02) of an in-flight product sign-in, by its
 * OIDC `state`.
 *
 * Flow records, device-code records and the user-code index live in the atomic single-use store
 * rather than KV (G15): every step that must happen once — the callback's claim of a `state`,
 * a confirmation's spend of its CSRF token, the poll interval, the final redemption — is one
 * atomic operation there (`updateArtefact`'s compare-and-set, or `consumeArtefact`), where KV's
 * `get` then `put`/`delete` let two racing requests both pass.
 *
 * R12-04: the `state` used to be the key name verbatim, so anyone who could LIST the store read
 * live `state` values straight out of the key names, with the PKCE `verifier` and `nonce`
 * sitting in the value beside them. The address is the `state`'s hash under `KEY_HASH_PEPPER`,
 * so a listing is inert: a key name is no longer a usable `state`, and without the pepper it
 * cannot be reversed into one. The product prefixes the id, so one product's address can never
 * name another's record.
 *
 * Exported for tests that plant or inspect a flow record; production code reaches it only
 * through the handlers below.
 */
export async function flowKey(
  env: Env,
  product: string,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "oidc-flow",
    `${product}:${await hashKey(state, env.KEY_HASH_PEPPER)}`,
  );
}

/**
 * Single-use store address of a device-code sign-in, by its `deviceCode`.
 *
 * R12-04: the device code is the poll credential (together with the device id), so it gets
 * the same peppered hash as `flowKey`. Every reader (verify, confirm and poll) derives the
 * address the same way, so a lookup by device code still works and a listing yields nothing
 * that can be polled.
 */
export async function deviceFlowKey(
  env: Env,
  product: string,
  code: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-flow",
    `${product}:${await hashKey(code, env.KEY_HASH_PEPPER)}`,
  );
}

// ── the RFC 8628 user code ──────────────────────────────────────────────────
//
// The code a human types on the entry page (`/<p>/identity/auth/device`). It is generated
// INDEPENDENTLY of the secret `deviceCode` — it used to be the device code's first eight
// characters, case-folded, so the "show the user" value leaked part of the poll credential and
// the only page a human could reach carried the whole device code in its URL (R8-02 residual).
//
// RFC 8628 §6.1's consonant alphabet: no vowels (no accidental words), no digits (no 0/O, 1/I
// confusion), case-insensitive on input. Eight characters is 20^8 ≈ 2.56e10 codes (~34.5 bits).

/**
 * Whether the computed `redirectUri` is permitted by the product's `redirect_uris_json`
 * allowlist. The computed URI MUST be a member — otherwise an attacker-chosen host/path could
 * exfiltrate the authorization code. An unset column fails closed (R8-07):
 * no shipped writer leaves it NULL, so a NULL is a damaged row, not a policy of "allow all".
 */
export function redirectUriAllowed(
  oidc: OidcConfigRow,
  redirectUri: string,
): boolean {
  if (!oidc.redirect_uris_json) return false;
  let allowed: unknown;
  try {
    allowed = JSON.parse(oidc.redirect_uris_json);
  } catch {
    return false;
  }
  return Array.isArray(allowed) && allowed.includes(redirectUri);
}

/** Apply one or more abuse ceilings to an unauthenticated OIDC surface. Returns a 429 to
 *  return, or null when the call is within every limit. Poll/callback surfaces pass a second
 *  bucket keyed on the flow so a single state cannot be hammered from a botnet (R8-10). */
export async function rateLimited(
  env: Env,
  product: Product,
  now: number,
  ...limits: RateLimit[]
): Promise<Response | null> {
  for (const rl of limits) {
    if (!(await rateLimitOk(env, product.slug, rl, now))) {
      return errorResponse(429, "rate_limited", "too many requests");
    }
  }
  return null;
}
