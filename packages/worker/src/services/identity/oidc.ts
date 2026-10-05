/// <reference types="@cloudflare/workers-types" />

// Product OIDC — the Identity service's sign-in engine (design spec §2.1, D-14).
//
// Each product has one server-selected OIDC provider (platform default or custom) plus
// product-scoped group mapping/provisioning. A browser sign-in mints/locates a license for the
// identity; generic provisioning hooks turn verified claims into entitlements + secrets. The
// CLI/loopback flow polls for a per-device token. ID tokens are verified against the issuer
// JWKS via jose (asymmetric algs only).
//
// ── THE ROUTE MOVE (§R1) ────────────────────────────────────────────────────────────────────
//
// Every surface here now answers under `/<p>/identity/auth/…`; `routes.ts` is the sub-router.
// The old top-level spellings are GONE — not aliased. Nothing external ships them: an SDK reads
// its URLs out of `/.well-known/polaris.json`, and the one place a path was ever pinned is an
// operator's IdP redirect-URI registration, which is per-product configuration an operator
// re-registers (`oidc_config.redirect_uris_json` moves with it — see `beginAuthFlow`).
//
// The redundant `/<p>/auth/login` spelling of `/auth/start` is deleted outright rather than
// carried over: a compatibility alias for a path nobody can still be calling is a second code
// path for free.

import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "./idToken.js";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
// R9-01: the manifest validator's issuer rule, applied again at the SINK. Ingest-only
// validation would leave every `oidc_config` row written before it landed (or by any future
// writer that bypasses `parseManifest`) able to steer the token POST that carries this
// product's client secret. Imported from the shared package rather than through Release, whose
// `manifest.ts` merely re-exports it — a service may not import a sibling.
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import { representabilityIssue } from "@polaris-key/catalog";
import {
  bearer,
  hashKey,
  platformOidcConfig,
  secret,
  brandedHtmlSecurityHeaders,
  randomId,
  type Db,
  type Env,
} from "../../core/platform.js";
import {
  openProductSecret,
  type Product,
  type ProductPublic,
} from "../../core/products.js";
import { renderBrandPage } from "../../core/brandHtml.js";
import { errorResponse, json, methodNotAllowed } from "../../core/errors.js";
import {
  clientIp,
  clientNetwork,
  rateLimitOk,
  type RateLimit,
} from "../../core/rateLimit.js";
import {
  appendAudit,
  claimEnrolledLicense,
  getLicense,
  countActiveDevices,
  getLicenseBySub,
  getTier,
  insertLicense,
  moveDevices,
  seatActiveSince,
  type LicenseRow,
} from "../../core/data.js";
import { allowsOidcDefault } from "../../core/fingerprint.js";
import {
  authorizeDevice,
  licenseDeviceLimit,
  tierFingerprintMode,
  tierExpiresAt,
} from "../../core/authz.js";
import { licenseUsable, validateDeviceToken } from "../../core/devices.js";
import { createBrowserSession } from "./browserSession.js";
import {
  artefactRef,
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../core/singleUse.js";

const FLOW_TTL_SECONDS = 600;
/** The poll cadence advertised by `/identity/auth/device/start`, enforced server-side (R8-02). */
const DEVICE_POLL_INTERVAL_SECONDS = 2;

interface OidcConfigRow {
  product: string;
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
  redirect_uris_json: string | null;
  group_role_map_json: string | null;
}

interface ResolvedOidcConfig {
  row: OidcConfigRow;
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

interface ProvisioningRow {
  product: string;
  claim: string;
  entitlement_key: string | null;
  entitlement_value_json: string | null;
  secret_key: string | null;
  secret_url_template: string | null;
  allowed_hosts_json: string | null;
}

export interface OidcIdentity {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  claims: Record<string, unknown>;
}

interface FlowRecord {
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
   *  this is set — the poll surfaces must not be able to skip the confirmation (R8-01). */
  confirmedAt?: number;
  /** Stamped by the first callback that claims this state. A state is single-use: a second
   *  callback must never be able to rebind `licenseId` under a waiting poller (R8-04). */
  consumedAt?: number;
  /** Set on a flow `/device/start` began. Such a flow redeems ONLY through `/device/poll`, with
   *  the secret device code: `state` rides on the authorize URL the confirmation POST 303s to,
   *  and the device id can be on the page, so on `/identity/auth/poll` the pair would be a
   *  redemption handle for anyone who holds the user code (R8-02, P1-06). */
  viaDeviceCode?: boolean;
  /** A device-code flow's verified identity, stored by the callback INSTEAD of activating it
   *  (P1-07). Activation happens at `/device/poll`, where the device-code holder decides whether
   *  the device's anonymous enrolled licence is attached; until then no licence row is created,
   *  claimed or changed. */
  identity?: OidcIdentity;
  /** Stamped the first time `/device/poll` answered `confirm`, i.e. the device was shown the
   *  signed-in identity. An attach decision is honoured only after this (P1-07). */
  identityShownAt?: number;
}

interface DeviceFlowRecord {
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

// ── helpers ──────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    toAB(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function getOidcConfig(
  db: Db,
  product: string,
): Promise<OidcConfigRow | null> {
  return db.first<OidcConfigRow>(
    "SELECT * FROM oidc_config WHERE product = ?",
    product,
  );
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
 * **Unset means not enforced.** That is a deliberate, documented fail-open: enforcing an empty
 * allowlist would take every already-configured custom-OIDC product offline on the deploy that
 * ships this code, with no operator action and no warning. The follow-up that makes it fail
 * closed *for new configs only* has to live at the ingest paths (`release/linkRepo.ts`,
 * `release/resync.ts`), which can tell a first write from a re-sync; see
 * the R9 audit findings. The platform issuer is exempt: it is a Worker
 * secret, not a repo-supplied value.
 */
function issuerHostAllowed(env: Env, issuer: string): boolean {
  const raw = secret(env, "OIDC_ISSUER_ALLOWLIST");
  if (!raw) return true;
  const hosts = raw
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return true;
  try {
    return hosts.includes(new URL(issuer).host.toLowerCase());
  } catch {
    return false;
  }
}

async function resolveOidcConfig(
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
async function getProvisioning(
  db: Db,
  product: string,
): Promise<ProvisioningRow[]> {
  return db.all<ProvisioningRow>(
    "SELECT * FROM provisioning_config WHERE product = ?",
    product,
  );
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

/** RFC 8628 §6.1's recommended user-code alphabet (20 consonants). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
/** Retries on an index collision before giving up (a collision among live codes is ~1e-10). */
const USER_CODE_ATTEMPTS = 5;

/** A fresh user code, normalised (no separator). Rejection sampling keeps it unbiased:
 *  240 is the largest multiple of 20 that fits in a byte. */
export function generateUserCode(): string {
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    for (const b of randomBytes(USER_CODE_LENGTH * 2)) {
      if (b >= 240) continue;
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/** `WDJBMJHT` → `WDJB-MJHT`, the display (and `userCode` wire) form. */
export function formatUserCode(normalised: string): string {
  return `${normalised.slice(0, 4)}-${normalised.slice(4)}`;
}

/**
 * What a human typed (or a QR code carried) → the canonical code, or `null` when it cannot be
 * one. Upper-case; spaces and hyphens dropped; anything outside the alphabet, or the wrong
 * length, is invalid — never "corrected", so a lookup only ever happens for a well-formed code.
 */
export function normalizeUserCode(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 64) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Single-use store address of the user-code index: normalised user code → the flow's
 * `deviceCode`. Written with `ifAbsent`, so two flows can never claim one live user code.
 *
 * R12-04: a user code is a short-lived bearer handle for the confirmation page, so the address
 * is its peppered hash — a listing yields nothing a visitor could type. The value is the
 * device code, which never leaves the server on this path.
 */
export async function deviceUserKey(
  env: Env,
  product: string,
  normalisedUserCode: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-user",
    `${product}:${await hashKey(normalisedUserCode, env.KEY_HASH_PEPPER)}`,
  );
}

/** Drop a flow's user-code index. Records written before the independent code existed carry a
 *  prefix-derived code that does not normalise, and never had an index. */
async function deleteUserCodeIndex(
  env: Env,
  product: string,
  userCode: string,
): Promise<void> {
  const code = normalizeUserCode(userCode);
  if (code) await deleteArtefact(env, await deviceUserKey(env, product, code));
}

function safeReturnTo(req: Request, raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const here = new URL(req.url);
    if (parsed.origin !== here.origin) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Whether the computed `redirectUri` is permitted by the product's `redirect_uris_json`
 * allowlist. When the column is unset we cannot enforce, so we allow (the IdP still
 * enforces its own registered-redirect check); when it IS set, the computed URI MUST be a
 * member — otherwise an attacker-chosen host/path could exfiltrate the authorization code.
 */
function redirectUriAllowed(oidc: OidcConfigRow, redirectUri: string): boolean {
  if (!oidc.redirect_uris_json) return true;
  let allowed: unknown;
  try {
    allowed = JSON.parse(oidc.redirect_uris_json);
  } catch {
    return false;
  }
  return Array.isArray(allowed) && allowed.includes(redirectUri);
}

/** Parse a JSON config column, failing CLOSED (undefined) instead of throwing. A malformed
 *  column is an operator mistake, not a reason to take the whole sign-in path down with an
 *  uncaught SyntaxError (R8-06). */
function parseJsonColumn<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Parse a stored flow record, treating a corrupt value exactly like a missing one (R11-06).
 *
 * Every caller already has a well-defined answer for "this flow does not exist" — `expired`,
 * `unknown state`, `timeout`. A truncated or garbled KV value is indistinguishable from that
 * for every purpose the handler has, so it should take the same branch rather than escape as
 * an uncaught `SyntaxError` and 500 a sign-in path.
 */
function parseFlowRecord<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Whether a verified claim genuinely enables a provisioning hook. Truthiness is NOT enough:
 *  an IdP that emits `"false"`, `"0"`, `"null"`, `0`, `[]` or `{}` must not grant an
 *  entitlement, so we require a real boolean `true` or a meaningful string (R8-05c). */
function claimEnables(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "null";
}

/** Apply one or more abuse ceilings to an unauthenticated OIDC surface. Returns a 429 to
 *  return, or null when the call is within every limit. Poll/callback surfaces pass a second
 *  bucket keyed on the flow so a single state cannot be hammered from a botnet (R8-10). */
async function rateLimited(
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

// ── identity mapping + provisioning ──────────────────────────────────────────
/** Apply provisioning hooks (verified claim -> entitlement + secret) into a payload.
 *  `now` (epoch seconds) is stamped as `updatedAt` on every entry written. */
export async function applyProvisioning(
  db: Db,
  product: string,
  identity: OidcIdentity,
  payload: ManagedPayload,
  now: number,
): Promise<void> {
  const hooks = await getProvisioning(db, product);
  for (const h of hooks) {
    const claimVal = identity.claims[h.claim];
    if (!claimEnables(claimVal)) continue;
    if (h.entitlement_key) {
      let value: ManagedEntry["value"] = true;
      if (h.entitlement_value_json) {
        const parsed = parseJsonColumn<ManagedEntry["value"]>(
          h.entitlement_value_json,
        );
        // A hook row we cannot parse is a hook we do not trust: skip it entirely. So is one
        // whose value no signed document could carry (plans/P3-01.md §2.2): the manifest
        // validator refuses such a value at sync, so only a row stored before it lands here,
        // and the signer guard would otherwise refuse this licence's documents.
        if (parsed === undefined || representabilityIssue(parsed) !== null)
          continue;
        value = parsed;
      }
      payload.entitlements[h.entitlement_key] = {
        state: "enforced",
        value,
        updatedAt: now,
      };
    }
    if (h.secret_key && h.secret_url_template) {
      // Global replace: a template may reference {claim} more than once, and leaving a
      // literal placeholder in a "secret" ships a broken URL to the client (R8-06).
      // `encodeURIComponent` throws on a lone surrogate, which a provider's claim may carry;
      // such a hook is skipped like any other it cannot honour, rather than failing sign-in.
      let encodedClaim: string;
      try {
        encodedClaim = encodeURIComponent(String(claimVal));
      } catch {
        continue;
      }
      const url = h.secret_url_template.replaceAll("{claim}", encodedClaim);
      // Host allowlist (defense against templated-secret injection). Fails CLOSED: a missing
      // or malformed allowlist drops the secret rather than emitting any host (R8-06).
      const allowed = parseJsonColumn<string[]>(h.allowed_hosts_json);
      if (!Array.isArray(allowed)) continue;
      try {
        if (!allowed.includes(new URL(url).host)) continue;
      } catch {
        continue;
      }
      payload.secrets[h.secret_key] = {
        state: "hidden",
        value: url,
        updatedAt: now,
      };
    }
  }
}

/** Why the auto-issue policy entitles an identity: a group in the product's `groupRoleMap` (the
 *  first mapped group the identity holds, preferring one that names a tier), or the product's
 *  `oidcDefault` auto-issue rule. Discover shows it as the offer's reason (PX-W10, G24). */
export type AutoIssueGrantVia =
  | { kind: "group"; group: string }
  | { kind: "default" };

/** What the auto-issue policy grants an identity: the tier, its expiry, and why. */
export interface AutoIssueGrant {
  tierId: string | null;
  expiresAt: number | null;
  via: AutoIssueGrantVia;
}

/** The tier an identity is entitled to under the product's group map, or its `oidcDefault`
 *  policy: `{ tierId, expiresAt, via }`, or `{ error: "not-entitled" }`. Read-only. This is THE
 *  auto-issue policy function: sign-in mints with it (`activateFromIdentity`) and Discover lists
 *  with it (`previewIdentityIssue`), so the two cannot disagree about who gets what. */
async function identityTier(
  db: Db,
  product: Pick<ProductPublic, "slug" | "autoIssue">,
  identity: Pick<OidcIdentity, "groups">,
  now: number,
): Promise<AutoIssueGrant | { error: string }> {
  const oidc = await getOidcConfig(db, product.slug);
  // A malformed map grants nothing (fail closed) instead of throwing out of sign-in (R8-06).
  const map =
    parseJsonColumn<Record<string, { role: string; tier?: string }>>(
      oidc?.group_role_map_json,
    ) ?? {};

  let entitledBy: string | null = null;
  let tierGroup: string | null = null;
  let tierId: string | null = null;
  for (const g of identity.groups) {
    const m = map[g];
    if (m) {
      if (entitledBy === null) entitledBy = g;
      if (m.tier && !tierId) {
        tierId = m.tier;
        tierGroup = g;
      }
    }
  }
  let via: AutoIssueGrantVia;
  if (entitledBy !== null) {
    via = { kind: "group", group: tierGroup ?? entitledBy };
  } else {
    // No mapped group. If the product opts into an OIDC default tier, any authenticated user
    // lands on the free tier instead of a hard 403; with the policy unset this is byte-for-byte
    // the previous behaviour.
    if (allowsOidcDefault(product.autoIssue) && product.autoIssue.tierId) {
      tierId = product.autoIssue.tierId;
      via = { kind: "default" };
    } else {
      return { error: "not-entitled" };
    }
  }

  let expiresAt: number | null = null;
  if (tierId) {
    expiresAt = tierExpiresAt(await getTier(db, product.slug, tierId), now);
  }
  return { tierId, expiresAt, via };
}

/** Would `activateFromIdentity` refuse this identity? The same two refusals, read-only: no
 *  entitlement, or an existing licence that is not usable. The device-code callback answers the
 *  browser with this, because it defers the activation itself to `/device/poll` (P1-07). */
async function identityRefusal(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  now: number,
): Promise<string | null> {
  const tier = await identityTier(db, product, identity, now);
  if ("error" in tier) return tier.error;
  const existing = await getLicenseBySub(db, product.slug, identity.sub);
  if (existing && !licenseUsable(existing, now)) return "license-unusable";
  return null;
}

/** The licence overrides `activateFromIdentity` writes for `identity`: its provisioning hooks
 *  applied to an empty payload. Read-only. */
async function provisionedOverrides(
  db: Db,
  product: Pick<ProductPublic, "slug">,
  identity: OidcIdentity,
  now: number,
): Promise<ManagedPayload> {
  const overrides: ManagedPayload = {
    config: {},
    secrets: {},
    entitlements: {},
  };
  await applyProvisioning(db, product.slug, identity, overrides, now);
  return overrides;
}

/** The device limit `row` will carry once `activateFromIdentity` has activated `identity` onto
 *  it. A claim (`claimEnrolledLicense`) and the existing-licence update both rewrite `tier_id`,
 *  `expires_at` and `overrides_json` to the identity's mapped tier and provisioned overrides,
 *  so the limit the row holds NOW (an enroll tier, a stale tier from an earlier sign-in, an
 *  admin `deviceLimit` override) is not the one it will have after the attach. Read-only: the
 *  P1-07 attach measures its seat bound with this (R1-07). */
async function postActivationDeviceLimit(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  row: LicenseRow,
  tier: { tierId: string | null; expiresAt: number | null },
  now: number,
): Promise<number> {
  const overrides = await provisionedOverrides(db, product, identity, now);
  return licenseDeviceLimit(
    db,
    product,
    {
      ...row,
      tier_id: tier.tierId,
      expires_at: tier.expiresAt,
      overrides_json: JSON.stringify(overrides),
    },
    now,
  );
}

/**
 * The first-load auto-issue, DRY RUN (PX-W10, docs/design/PORTAL.md G24): what
 * `activateFromIdentity` would mint for `identity` on this product, computed by the same two
 * read-only steps it starts with (the policy, `identityTier`, and the provisioning hooks,
 * `provisionedOverrides`) and writing nothing. `{ error: "not-entitled" }` when the policy grants
 * nothing; `existing` is the licence the identity already holds here, which the caller treats as
 * "already held" rather than as an offer.
 */
export async function previewIdentityIssue(
  db: Db,
  product: ProductPublic,
  identity: OidcIdentity,
  now: number,
): Promise<
  | (AutoIssueGrant & {
      overrides: ManagedPayload;
      existing: LicenseRow | null;
    })
  | { error: string }
> {
  const grant = await identityTier(db, product, identity, now);
  if ("error" in grant) return grant;
  return {
    ...grant,
    overrides: await provisionedOverrides(db, product, identity, now),
    existing: await getLicenseBySub(db, product.slug, identity.sub),
  };
}

/** Find or mint a license for an identity. Returns the licenseId, or an error if the
 *  identity's groups don't grant entitlement. Idempotent on the OIDC subject. */
export async function activateFromIdentity(
  db: Db,
  // Never signs, so the public projection is enough: the portal's Discover claim (PX-W10) holds
  // one, and minting through this exact function is what makes it the auto-issue path.
  product: ProductPublic,
  identity: OidcIdentity,
  now: number,
  /** The license the caller's device is already using, when it presented one. An anonymous
   *  enrolled license found here is merged into the identity rather than abandoned. The sign-in
   *  callback never passes it, because a device-code flow is confirmed with the public user code
   *  (P1-06). The one HTTP route that does is `/device/poll`, and only on the device-code
   *  holder's explicit opt-in after the player accepted the signed-in identity on the device,
   *  for the licence the flow's own device holds a token on (P1-07). */
  opts: { enrolledLicenseId?: string | null } = {},
): Promise<
  { licenseId: string; merged?: "claimed" | "migrated" } | { error: string }
> {
  const tier = await identityTier(db, product, identity, now);
  if ("error" in tier) return tier;
  const { tierId, expiresAt } = tier;

  const overrides = await provisionedOverrides(db, product, identity, now);

  // The enrolled license this device is currently on, if it is genuinely a claimable
  // anonymous one. Anything else (an admin or OIDC license) is left alone.
  const enrolled = opts.enrolledLicenseId
    ? await getLicense(db, product.slug, opts.enrolledLicenseId)
    : null;
  const claimable =
    enrolled && enrolled.origin === "enroll" && enrolled.sub === null
      ? enrolled
      : null;

  const existing = await getLicenseBySub(db, product.slug, identity.sub);

  // Case 1 — a claimable enrolled license and no identity license yet: attach the identity to
  // the SAME row. Devices, overrides, and the client's local state all survive; the user
  // simply becomes known.
  if (claimable && !existing) {
    await claimEnrolledLicense(
      db,
      product.slug,
      claimable.id,
      {
        sub: identity.sub,
        name: identity.name ?? null,
        email: identity.email ?? null,
        groupsJson: JSON.stringify(identity.groups),
        tierId,
        expiresAt,
      },
      now,
    );
    await db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify(overrides),
      product.slug,
      claimable.id,
    );
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.merge",
      target_kind: "license",
      target_id: claimable.id,
      parent_id: null,
      summary: `Claimed the auto-issued license for ${identity.email ?? identity.sub}`,
    });
    return { licenseId: claimable.id, merged: "claimed" };
  }

  // Case 2 — a claimable enrolled license AND an existing identity license: migrate the
  // devices onto the identity's license and retire the enrolled row, so the user keeps their
  // machines but ends up on the license that already holds their entitlements.
  if (claimable && existing && licenseUsable(existing, now)) {
    await moveDevices(db, product.slug, claimable.id, existing.id);
    // R3-05: `enroll_hwid` is deliberately NOT cleared. The retired row keeps occupying
    // `idx_licenses_enroll_hwid`, which is the only guard on "one free license per machine";
    // clearing it let the same machine enrol again immediately and repeat the merge with a
    // second identity, without limit.
    await db.run(
      `UPDATE licenses SET status = 'disabled', modified_by = 'oidc',
         modified_at = ? WHERE product = ? AND id = ?`,
      now,
      product.slug,
      claimable.id,
    );
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.merge",
      target_kind: "license",
      target_id: existing.id,
      parent_id: claimable.id,
      summary: `Migrated devices from auto-issued license ${claimable.id}`,
    });
  }

  if (existing) {
    if (!licenseUsable(existing, now)) return { error: "license-unusable" };
    await db.run(
      `UPDATE licenses SET name = ?, email = ?, groups_json = ?, tier_id = ?,
         expires_at = ?, overrides_json = ?, modified_by = ?, modified_at = ?
       WHERE product = ? AND id = ?`,
      identity.name ?? null,
      identity.email ?? null,
      JSON.stringify(identity.groups),
      tierId,
      expiresAt,
      JSON.stringify(overrides),
      "oidc",
      now,
      product.slug,
      existing.id,
    );
    return {
      licenseId: existing.id,
      ...(claimable ? { merged: "migrated" as const } : {}),
    };
  }

  const licenseId = randomId("lic");
  await insertLicense(db, {
    product: product.slug,
    id: licenseId,
    status: "active",
    sub: identity.sub,
    name: identity.name ?? null,
    email: identity.email ?? null,
    groups_json: JSON.stringify(identity.groups),
    tier_id: tierId,
    activated_at: now,
    expires_at: expiresAt,
    max_offline_days: null,
    overrides_json: JSON.stringify(overrides),
    channels_json: null,
    min_version: null,
    max_version: null,
    // S-16 G14: without this the column defaults to 'admin' (migrations/0011).
    origin: "oidc",
    modified_by: "oidc",
    modified_at: now,
  });
  return { licenseId };
}

/** Authorize a device for a license and mint a per-device token. */
export async function authorizeAndMint(
  env: Env,
  db: Db,
  product: Product,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<string> {
  const row = await getLicense(db, product.slug, licenseId);
  if (!row) throw new Error("license not found");
  // I-05: bound by a sign-in. The product-OIDC licence is `sub`-keyed and attached to no account
  // (plans/I-04.md §8 Q6), so no pairwise subject is set here; passthrough sign-in (I-08) does.
  const result = await authorizeDevice(env, db, product, row, deviceId, now, {
    boundBy: "signin",
  });
  if ("error" in result) throw new Error(result.error);
  return result.token;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
async function beginAuthFlow(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  returnTo?: string,
  deviceId?: string,
  viaDeviceCode = false,
): Promise<
  | {
      ok: true;
      state: string;
      authorizeUrl: string;
      redirectUri: string;
    }
  | Response
> {
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) return oidc;
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  // §R1: the callback moved under the service namespace with the rest of Identity. This is the
  // value the IdP must have REGISTERED — `redirectUriAllowed` below refuses anything else the
  // moment `redirect_uris_json` is set — so an operator upgrading a product with a custom (or
  // strictly-configured platform) IdP re-registers `…/<p>/identity/auth/callback` and updates
  // the `oidc.redirectUris` block in its `.pkey/product` manifest. Pre-launch, so there is
  // no dual-registration window to keep: one spelling, computed in exactly one place.
  const redirectUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/callback`;
  if (!redirectUriAllowed(oidc.row, redirectUri)) {
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  const flow: FlowRecord = { verifier, nonce, redirectUri, returnTo, deviceId };
  if (viaDeviceCode) flow.viaDeviceCode = true;
  await putArtefact(
    env,
    await flowKey(env, product.slug, state),
    JSON.stringify(flow),
    FLOW_TTL_SECONDS,
  );

  const authorize = new URL(`${oidc.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", oidc.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return {
    ok: true,
    state,
    authorizeUrl: authorize.toString(),
    redirectUri,
  };
}

/** GET /<product>/identity/auth/start — begin PKCE, redirect to the IdP authorize endpoint. */
export async function handleAuthStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    { bucket: "authStart", id: clientIp(req), limit: 60, windowSec: 60 },
  );
  if (limited) return limited;
  const rawReturnTo = new URL(req.url).searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo);
  if (rawReturnTo && !returnTo)
    return errorResponse(400, "bad_request", "return_to not allowed");
  const flow = await beginAuthFlow(req, env, db, product, returnTo);
  if (flow instanceof Response) return flow;
  return new Response(null, {
    status: 302,
    headers: { location: flow.authorizeUrl },
  });
}

/** POST /<product>/identity/auth/device/start — begin desktop/CLI sign-in, return a poll handle. */
export async function handleAuthDeviceStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    { bucket: "authDeviceStart", id: clientIp(req), limit: 60, windowSec: 60 },
  );
  if (limited) return limited;
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const url = new URL(req.url);
  const deviceId =
    (typeof body.deviceId === "string" && body.deviceId) ||
    req.headers.get(HEADER_DEVICE) ||
    url.searchParams.get("device");
  if (!deviceId) return errorResponse(400, "bad_request", "missing device id");
  const deviceName =
    typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 120)
      : undefined;
  const flow = await beginAuthFlow(
    req,
    env,
    db,
    product,
    undefined,
    deviceId,
    true,
  );
  if (flow instanceof Response) return flow;
  const deviceCode = b64url(randomBytes(16));
  // The user code is independent of the device code (RFC 8628 §6.1). A live collision would
  // point two flows at one code, so the index slot is claimed atomically (`ifAbsent`) and an
  // occupied one means "draw again". The device record is written right after; until then the
  // index resolves to nothing and the entry page answers "not valid or expired".
  let claimed = false;
  let code = "";
  for (let i = 0; i < USER_CODE_ATTEMPTS && !claimed; i++) {
    code = generateUserCode();
    claimed = await putArtefact(
      env,
      await deviceUserKey(env, product.slug, code),
      deviceCode,
      FLOW_TTL_SECONDS,
      { ifAbsent: true },
    );
  }
  if (!claimed) return errorResponse(503, "unavailable", "try again");
  const userCode = formatUserCode(code);
  const deviceRecord: DeviceFlowRecord = {
    state: flow.state,
    deviceId,
    userCode,
    authorizeUrl: flow.authorizeUrl,
    deviceName,
  };
  await putArtefact(
    env,
    await deviceFlowKey(env, product.slug, deviceCode),
    JSON.stringify(deviceRecord),
    FLOW_TTL_SECONDS,
  );
  // The page a human types the code into, and the same page with the code pre-filled for a QR
  // code or a clickable link (RFC 8628 §3.2, §3.3.1). Neither carries the device code: that is
  // the poll credential and stays between this server and the polling client.
  const verificationUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/device`;
  return json({
    status: "pending",
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${userCode}`,
    expiresIn: FLOW_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    pollUrl: `${new URL(req.url).origin}/${product.slug}/identity/auth/device/poll`,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The CSRF token the confirmation form posts back, from either an HTML form body or JSON. */
async function readConfirmToken(req: Request): Promise<string | null> {
  const text = await req.text().catch(() => "");
  if (!text) return null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = parseJsonColumn<Record<string, unknown>>(text);
    return typeof body?.csrf === "string" ? body.csrf : null;
  }
  return new URLSearchParams(text).get("csrf") || null;
}

/** POST half of device verification: mark the flow user-confirmed and hand the browser on to
 *  the IdP. Requires the CSRF token minted on the confirmation page's render, so neither a
 *  prefetch nor a cross-site form can confirm a flow (or read `state`/`nonce`) on the visitor's
 *  behalf. Shared by `/device/verify` (device code in the URL) and `/device` (user code). */
async function confirmDeviceFlow(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  token: string | null,
  now: number,
): Promise<Response> {
  if (!sameOriginPost(req))
    return errorResponse(403, "forbidden", "confirmation failed");
  if (!record.csrf || !token || token !== record.csrf)
    return errorResponse(403, "forbidden", "confirmation failed");

  // The confirmation is an authorization input for the poll surfaces, so it is recorded on
  // the flow the pollers actually read, not only on the device record (R8-01). The flow must
  // still exist (checked first, so an expired flow spends nothing).
  const stateKey = await flowKey(env, product.slug, record.state);
  const deviceKey = await deviceFlowKey(env, product.slug, deviceCode);
  const flowRaw = await getArtefact(env, stateKey);
  if (!flowRaw || !parseFlowRecord<FlowRecord>(flowRaw))
    return errorResponse(404, "not_found", "device code expired");
  // Spend the CSRF token atomically (single-use): of two racing POSTs carrying it, one
  // confirms and the other is refused like any stale token.
  const spent = await updateArtefact(env, deviceKey, {
    expect: { csrf: token },
    set: { confirmedAt: now },
    unset: ["csrf"],
  });
  if (!spent.ok) return errorResponse(403, "forbidden", "confirmation failed");
  const stamped = await updateArtefact(env, stateKey, {
    set: { confirmedAt: now },
  });
  if (!stamped.ok)
    return errorResponse(404, "not_found", "device code expired");
  // A confirmed flow is done with its user code: nobody else who learns the code (a stream, a
  // photographed QR code, a guess) can re-render the page, re-mint the CSRF token or read the
  // authorize URL after the human has confirmed.
  await deleteUserCodeIndex(env, product.slug, record.userCode);
  return new Response(null, {
    status: 303,
    headers: {
      location: record.authorizeUrl,
      // The authorize URL carries `state` and `nonce`: keep it out of the Referer chain and
      // out of every cache (R8-02).
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** Refuse a cross-site POST to a device-flow page.
 *
 *  Fetch Metadata decides when the browser sends it: only `same-origin` passes. Without it, an
 *  absent `Origin`, this origin, or the literal `"null"` pass. `"null"` is not optional: both
 *  device pages are served with `referrer-policy: no-referrer`, and under that policy the Fetch
 *  standard serialises a same-origin form POST's `Origin` as `null`. With the single-use CSRF
 *  token minted on the page's render, this guards only against cross-site forgery of SOMEONE
 *  ELSE'S flow. It does not stop a flow's starter, who can mint the token for their own code
 *  and POST it with no `Origin` (curl): that is the open R1-07 / R8-03 residual (no binding
 *  between the confirming browser and the IdP callback) — see THREAT-MODEL.md "Remote
 *  phishing". */
function sameOriginPost(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !origin || origin === "null" || origin === new URL(req.url).origin;
}

/** Headers for the device-flow HTML pages: the branded-page bundle, no Referer, no caching.
 *  `formTarget` widens `form-action` by exactly one origin — the IdP the confirmation POST
 *  303s to — because browsers apply `form-action` to every redirect a form submission follows,
 *  so `'self'` alone would block the hand-off the confirmation button exists to make. */
function deviceHtmlHeaders(formTarget?: string): Headers {
  // R1-09: `index.ts`'s `secureResponse` backstop would supply this policy anyway, but a
  // handler that emits HTML should not depend on the dispatcher — a direct call (a test, or a
  // future internal caller) must be hardened too. `brandedHtmlSecurityHeaders` preserves the
  // `referrer-policy` set here.
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      // A device-flow URL can hold a device or user code: never let it ride along as a
      // Referer, and never let a shared cache keep the page (R8-02).
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    }),
  );
  let idp: string | null = null;
  try {
    if (formTarget) idp = new URL(formTarget).origin;
  } catch {
    idp = null;
  }
  if (idp && idp !== "null") {
    headers.set(
      "content-security-policy",
      headers
        .get("content-security-policy")!
        .replace("form-action 'self'", `form-action 'self' ${idp}`),
    );
  }
  return headers;
}

/** Mint a fresh single-use CSRF token onto the record and render the confirmation page: the
 *  product, the device label and the user code, and one button. `hidden` are the extra fields
 *  the form posts back alongside `csrf` — the user code on `/device`, nothing on `/verify`
 *  (whose action URL already carries the device code). */
async function renderDeviceConfirmation(
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  action: string,
  hidden: Record<string, string>,
): Promise<Response> {
  const csrf = b64url(randomBytes(16));
  record.csrf = csrf;
  // An update, never a put: it cannot resurrect a record a poll redeemed meanwhile.
  const minted = await updateArtefact(
    env,
    await deviceFlowKey(env, product.slug, deviceCode),
    { set: { csrf } },
  );
  if (!minted.ok) return errorResponse(404, "not_found", "device code expired");
  // Never the raw device id: with `state` it is half of what `/identity/auth/poll` checks, so
  // the page would hand it to anyone who holds the user code (R8-02, P1-06).
  const deviceLabel = record.deviceName || "Unnamed device";
  const hiddenInputs = Object.entries(hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const html = renderBrandPage({
    title: `Authorize ${product.name}`,
    eyebrow: "Device activation",
    heading: `Authorize ${product.name}`,
    body:
      `<p>An app is asking to activate this device. Check that the code and device match what the app shows before signing in.</p>` +
      `<dl><dt>Code</dt><dd class="code">${escapeHtml(record.userCode)}</dd>` +
      `<dt>Device</dt><dd>${escapeHtml(deviceLabel)}</dd>` +
      `<dt>Product</dt><dd>${escapeHtml(product.slug)}</dd></dl>` +
      `<form method="post" action="${escapeHtml(action)}">${hiddenInputs}` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<button class="button" type="submit">Continue to sign in</button></form>`,
  });
  return new Response(html, {
    status: 200,
    headers: deviceHtmlHeaders(record.authorizeUrl),
  });
}

/** The code-entry form: one text field, posted back to `/device`. `error` renders the single
 *  generic "not valid or expired" line — the page never says WHICH (RFC 8628 §5.1). */
function renderDeviceEntry(
  product: Product,
  action: string,
  status: 200 | 404,
): Response {
  const error =
    status === 404
      ? `<p class="alert" role="alert">That code is not valid or has expired. Check the code on your device and try again.</p>`
      : "";
  const html = renderBrandPage({
    title: `Connect a device to ${product.name}`,
    eyebrow: "Device activation",
    heading: `Connect a device to ${product.name}`,
    body:
      `<p class="muted">Enter the code shown on your device.</p>${error}` +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<label for="user_code">Code</label>` +
      `<input id="user_code" name="user_code" type="text" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX">` +
      `<button class="button" type="submit">Continue</button></form>`,
  });
  return new Response(html, { status, headers: deviceHtmlHeaders() });
}

/** The user code and CSRF token from an entry-route POST. `csrf` is `undefined` when the field
 *  is ABSENT (the entry form: look the code up and render the confirmation) and a string —
 *  possibly empty — when present (the confirmation form: confirm, and 403 unless it matches). */
async function readEntryForm(
  req: Request,
): Promise<{ userCode: string | null; csrf: string | undefined }> {
  const text = await req.text().catch(() => "");
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    // Only a JSON object is a form: `1`, `"x"`, `true` or `null` would make the `in` below throw
    // (an uncaught 500 on an unauthenticated route), so any other shape reads as an empty form.
    const parsed = parseJsonColumn<unknown>(text);
    const body = (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {}
    ) as Record<string, unknown>;
    return {
      userCode: typeof body.user_code === "string" ? body.user_code : null,
      csrf: Object.hasOwn(body, "csrf")
        ? typeof body.csrf === "string"
          ? body.csrf
          : ""
        : undefined,
    };
  }
  const form = new URLSearchParams(text);
  return {
    userCode: form.get("user_code"),
    csrf: form.has("csrf") ? (form.get("csrf") ?? "") : undefined,
  };
}

/**
 * `GET`/`POST /<product>/identity/auth/device` — the RFC 8628 user-code page, the
 * `verificationUri` a device-code client shows (`verificationUriComplete` adds `?user_code=`).
 *
 *   - `GET` with no `user_code`: the entry form (one field, POSTs back here).
 *   - `GET ?user_code=`, or a `POST` with `user_code` and NO `csrf` field: look the code up and
 *     render the confirmation page with a fresh single-use CSRF token. Its form posts
 *     `user_code` + `csrf` back here — never the device code.
 *   - `POST` with `user_code` and a `csrf` field: `confirmDeviceFlow` (Origin check, CSRF check,
 *     stamp `confirmedAt`, 303 to the IdP).
 *   - an unknown, expired or malformed code: the entry form again with one generic line, 404.
 *
 * The secret device code never appears in a URL, a page or a form on this path: anyone holding
 * it plus the device id could race the real device for the token once the user confirms. The
 * code → device-code lookup stays server-side, through the peppered `deviceUserKey` index.
 * What a user-code holder DOES get — `state`, in the authorize URL the confirmation 303s to —
 * redeems nothing: `/identity/auth/poll` refuses a device-code flow (`viaDeviceCode`). Once the
 * flow is confirmed the code stops resolving here at all.
 */
export async function handleAuthDeviceEntry(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  // Per client network only: the IPv4 address, or the IPv6 /64 (one host holds a whole /64, so
  // a per-address key would be free to rotate — R10-04b). A product-wide bucket would let one
  // attacker exhaust it and lock every player out of sign-in; 20^8 codes over a 600 s lifetime
  // is what bounds blind guessing (THREAT-MODEL.md, "Brute force").
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceEntry",
    id: clientNetwork(req),
    limit: 30,
    windowSec: 60,
  });
  if (limited) return limited;
  const url = new URL(req.url);
  const action = `${url.origin}/${product.slug}/identity/auth/device`;

  let rawCode: string | null;
  let csrf: string | undefined;
  if (req.method === "POST") {
    if (!sameOriginPost(req))
      return errorResponse(403, "forbidden", "confirmation failed");
    const form = await readEntryForm(req);
    rawCode = form.userCode ?? url.searchParams.get("user_code");
    csrf = form.csrf;
  } else {
    rawCode = url.searchParams.get("user_code");
  }
  if (!rawCode?.trim() && csrf === undefined)
    return renderDeviceEntry(product, action, 200);

  const userCode = normalizeUserCode(rawCode);
  const deviceCode = userCode
    ? await getArtefact(env, await deviceUserKey(env, product.slug, userCode))
    : null;
  const raw = deviceCode
    ? await getArtefact(env, await deviceFlowKey(env, product.slug, deviceCode))
    : null;
  const parsed = raw ? parseFlowRecord<DeviceFlowRecord>(raw) : null;
  // A confirmed flow no longer answers to its user code (the index is deleted on confirmation;
  // this also covers a request that read the index just before that delete).
  const record = parsed && !parsed.confirmedAt ? parsed : null;
  if (!userCode || !deviceCode || !record) {
    // A confirmation POST for a code that has gone away is still a refused confirmation.
    if (csrf !== undefined)
      return errorResponse(403, "forbidden", "confirmation failed");
    return renderDeviceEntry(product, action, 404);
  }

  if (csrf !== undefined)
    return confirmDeviceFlow(req, env, product, deviceCode, record, csrf, now);
  return renderDeviceConfirmation(env, product, deviceCode, record, action, {
    user_code: formatUserCode(userCode),
  });
}

/** GET /<product>/identity/auth/device/verify — render the confirmation page.
 *  POST /<product>/identity/auth/device/verify — confirm it. The GET is deliberately side-effect free:
 *  it used to accept `?confirm=1`, which made an `<img src>` enough to confirm a flow AND
 *  handed the caller `state` + `nonce` in the 302 (R8-02).
 *
 *  Kept for flows started before `/device` existed and for any client that builds this URL;
 *  `/device/start` no longer hands it out. */
export async function handleAuthDeviceVerify(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceVerify",
    id: clientIp(req),
    limit: 60,
    windowSec: 60,
  });
  if (limited) return limited;
  const url = new URL(req.url);
  const deviceCode = url.searchParams.get("device_code");
  if (!deviceCode) return errorResponse(400, "bad_request", "missing code");
  const deviceKey = await deviceFlowKey(env, product.slug, deviceCode);
  const raw = await getArtefact(env, deviceKey);
  if (!raw) return errorResponse(404, "not_found", "device code expired");
  const record = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!record) return errorResponse(404, "not_found", "device code expired");

  if (req.method === "POST") {
    const token = await readConfirmToken(req);
    return confirmDeviceFlow(req, env, product, deviceCode, record, token, now);
  }
  return renderDeviceConfirmation(
    env,
    product,
    deviceCode,
    record,
    url.toString(),
    {},
  );
}

function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  // Only a VERIFIED email is trusted: this value is persisted on the license, signed into the
  // config document's identity profile, and is what the portal auto-links accounts on. An
  // unverified claim is attacker-chosen, so we store nothing rather than that (R8-05b).
  //
  // Both are signed into the licence document's profile, so a value no signed document could
  // carry (a lone surrogate, plans/P3-01.md §2.2) is stored as null rather than refused: the
  // provider chose it, the user cannot fix it, and sign-in should still succeed.
  const verifiedEmail =
    payload.email_verified === true && typeof payload.email === "string"
      ? payload.email
      : undefined;
  const email =
    verifiedEmail !== undefined && representabilityIssue(verifiedEmail) === null
      ? verifiedEmail
      : undefined;
  const rawName =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (email ?? "");
  const name = representabilityIssue(rawName) === null ? rawName : "";
  return {
    // No String() coercion: a non-string `sub` is a type-confusion hazard (123 vs "123"), and
    // an empty one collapses every such identity onto a single license row (R8-05a). The
    // caller rejects the empty result — see handleAuthCallback.
    sub: typeof payload.sub === "string" ? payload.sub : "",
    email,
    name: name || undefined,
    groups,
    claims: payload,
  };
}

/** GET /<product>/identity/auth/callback — exchange the code, verify the ID token, mint a license. */
export async function handleAuthCallback(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state)
    return errorResponse(400, "bad_request", "missing code/state");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authCallback", id: clientIp(req), limit: 60, windowSec: 60 },
    { bucket: "authCallbackState", id: state, limit: 5, windowSec: 60 },
  );
  if (limited) return limited;
  const stateKey = await flowKey(env, product.slug, state);
  // Single-use state (R8-04). Claim the flow before any outbound call so a second callback
  // can never overwrite the license a poller is already waiting on; a replay gets exactly the
  // same generic answer as an unknown state. The claim is one atomic compare-and-set in the
  // single-use store (G15): of two racing callbacks, exactly one sees `consumedAt` absent.
  const claim = await updateArtefact(env, stateKey, {
    expect: { consumedAt: null },
    set: { consumedAt: now },
  });
  if (!claim.ok || !claim.payload)
    return errorResponse(400, "bad_request", "unknown state");
  const flow = parseFlowRecord<FlowRecord>(claim.payload);
  if (!flow) {
    await deleteArtefact(env, stateKey);
    return errorResponse(400, "bad_request", "unknown state");
  }
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) {
    await deleteArtefact(env, stateKey);
    return oidc;
  }
  // Defense in depth: the stored flow's redirect_uri must still be allow-listed.
  if (!redirectUriAllowed(oidc.row, flow.redirectUri)) {
    await deleteArtefact(env, stateKey);
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }

  const tokenRes = await fetch(
    `${oidc.issuer.replace(/\/$/, "")}/api/oidc/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: oidc.clientId,
        code_verifier: flow.verifier,
        ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}),
      }),
    },
  );
  if (!tokenRes.ok) {
    // Delete the flow rather than recording a reason — pollers must not be able to
    // enumerate IdP failure modes (D8). The poll surface returns a generic error.
    await deleteArtefact(env, stateKey);
    return errorResponse(502, "oidc_error", "token exchange failed");
  }
  let tokens: { id_token?: string };
  try {
    tokens = (await tokenRes.json()) as { id_token?: string };
  } catch {
    await deleteArtefact(env, stateKey);
    return errorResponse(502, "oidc_error", "token response invalid");
  }
  if (!tokens.id_token) {
    await deleteArtefact(env, stateKey);
    return errorResponse(502, "oidc_error", "no id_token");
  }

  const jwks = createRemoteJWKSet(
    new URL(`${oidc.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
  );
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer: oidc.issuer,
      audience: oidc.clientId,
      algorithms: ALLOWED_ID_TOKEN_ALGS,
      // Freshness is ours to enforce: `exp` is entirely the IdP's choice, so a token minted
      // long before this exchange must not be replayable into a sign-in (R8-05d).
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: ID_TOKEN_MAX_AGE,
    });
    claims = verified.payload as Record<string, unknown>;
    // Reject unconditionally on a missing or mismatched nonce — a token with no nonce must
    // never satisfy the binding to this flow (replay / token-injection defense).
    if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce)
      throw new Error("nonce mismatch");
  } catch {
    await deleteArtefact(env, stateKey);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // An identity with no subject is not an identity: `getLicenseBySub(…, "")` would match every
  // other subject-less row, so distinct people would share one license. Admin and portal both
  // reject this already (admin/auth.ts:216, portal/auth.ts:280) — so does the product flow now
  // (R8-05a). Same generic 401 as any other bad ID token.
  const identity = mapClaims(claims);
  if (!identity.sub) {
    await deleteArtefact(env, stateKey);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // The callback never claims, migrates or disables an existing license (P1-06 security fix).
  // The only flows that carry a device id are device-code flows (`/device/start`; a record
  // with `deviceId` but no `viaDeviceCode` predates the marker and is the same kind of flow),
  // and a device-code flow is confirmed with the PUBLIC user code — read off a stream, a photo
  // or guessed. Applying the device's enrolled license here let whoever confirmed first and
  // signed in under their own identity take the victim device's anonymous license (claim) or
  // retire it into theirs (migrate). So a device-code sign-in yields exactly what an ordinary
  // sign-in for that identity yields: its own license (`getLicenseBySub`) or a new one under
  // the existing group/default-tier policy. Attaching the device's anonymous license to the
  // account is P1-07's opt-in, applied at `/device/poll` by the device-code holder after the
  // player accepts the signed-in identity on the device. A browser-redirect flow carries no
  // device id and so never merged; its behaviour is unchanged.
  //
  // So a flow `/device/start` began does not activate here at all (P1-07). The callback checks,
  // read-only, that activation would succeed (so the browser still hears "not entitled" at
  // once), stores the verified identity on the flow and stops: no licence row is created,
  // claimed or changed until the device-code holder polls. That keeps the claim case possible
  // for the opt-in (an identity with no licence yet takes over the device's anonymous row in
  // place, instead of being handed a fresh row it would then have to abandon), and it keeps the
  // decision with the only party that holds the device code.
  if (flow.viaDeviceCode) {
    if (await identityRefusal(db, product, identity, now)) {
      await deleteArtefact(env, stateKey);
      return errorResponse(403, "forbidden", "not entitled");
    }
    flow.identity = identity;
    await updateArtefact(env, stateKey, { set: { identity } });
    return signedInPage();
  }
  const result = await activateFromIdentity(db, product, identity, now);
  if ("error" in result) {
    // Failed activation: drop the flow so the poller gets a generic error, not the reason.
    await deleteArtefact(env, stateKey);
    return errorResponse(403, "forbidden", "not entitled");
  }
  flow.licenseId = result.licenseId;
  if (flow.returnTo) {
    const license = await getLicense(db, product.slug, result.licenseId);
    if (!license) {
      await deleteArtefact(env, stateKey);
      return errorResponse(401, "unauthorized", "license unavailable");
    }
    const session = await createBrowserSession(
      env,
      db,
      product,
      license,
      now,
      req,
    );
    await deleteArtefact(env, stateKey);
    if (!session.ok) {
      return errorResponse(
        session.status,
        session.code,
        session.message,
        session.extra,
      );
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: flow.returnTo,
        "set-cookie": session.cookie,
      },
    });
  }
  await updateArtefact(env, stateKey, { set: { licenseId: flow.licenseId } });
  return signedInPage();
}

/** The callback's "return to the app" page. */
function signedInPage(): Response {
  return new Response(
    renderBrandPage({
      title: "Signed in",
      heading: "You're signed in",
      body: `<p class="muted">You can close this tab and return to the app.</p>`,
    }),
    {
      status: 200,
      // R1-09 — see the device-authorization page above: set the policy at the sink as well
      // as in the dispatcher backstop.
      headers: brandedHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/** What a `/device/poll` asks for beyond "is it done yet" (P1-07). All three are absent on an
 *  ordinary poll, which then completes exactly as before: the identity's own licence, nothing
 *  merged. */
interface DevicePollAsk {
  /** Hold the flow at the signed-in identity (`confirm`) instead of minting, so the device can
   *  show it and the player can accept it first. */
  confirmIdentity: boolean;
  /** The player's decision, sent after the device was shown the identity: attach this device's
   *  anonymous enrolled licence to the account (`true`) or not (`false`). `null`: none sent. */
  attachLicense: boolean | null;
  /** The device token the poll carried (`Authorization: Bearer`), naming the licence to attach. */
  token: string | null;
}

const NO_ASK: DevicePollAsk = {
  confirmIdentity: false,
  attachLicense: null,
  token: null,
};

/** The name and verified e-mail of a signed-in identity, for the device to show. Never `sub`,
 *  groups or other claims. */
function shownIdentity(identity: OidcIdentity): {
  name?: string;
  email?: string;
} {
  return {
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.email ? { email: identity.email } : {}),
  };
}

/** The licence `token` holds for `deviceId` when it is one the opt-in may attach: a live token
 *  OF THAT DEVICE (`validateDeviceToken` with the device id), on an anonymous enrolled licence
 *  (`origin = 'enroll'`, no subject) that is usable now. Anything else attaches nothing.
 *
 *  Under R1-07 (the flow's starter phishes the authorize URL) the starter makes this decision,
 *  not the identity's owner, so the attach must never take the victim's licence past its
 *  device limit, on either arm:
 *  - claim (the identity has no licence yet): `claimEnrolledLicense` re-subjects the anonymous
 *    row with every authorized device still on it. It is offered only while those devices
 *    (dormant or not) fit the limit the row will carry AFTER the claim rewrites its tier and
 *    overrides to the identity's.
 *  - migrate (the identity has a usable licence): `moveDevices` re-points EVERY device on the
 *    anonymous licence at it without `authorizeDevice`'s seat check. It is offered only while
 *    the moved devices (dormant or not) plus the destination's seat-holding devices fit the
 *    limit the destination will carry AFTER `activateFromIdentity` rewrites its tier and
 *    overrides to the identity's mapped tier and provisioning.
 *  Both limits come from `postActivationDeviceLimit`. The attach can still fill the victim's
 *  free seats (see THREAT-MODEL, R1-07).
 *  Like the pre-count in `authorizeDevice`, this is a read, not a claim. Nothing is attachable
 *  onto a tier whose mint would refuse this device (fingerprint mode `strict`). */
async function attachableLicense(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  deviceId: string,
  identity: OidcIdentity,
  now: number,
): Promise<string | null> {
  if (!token) return null;
  const valid = await validateDeviceToken(env, db, product, token, now, {
    deviceId,
  });
  if ("error" in valid) return null;
  const license = valid.license;
  if (!license || license.origin !== "enroll" || license.sub !== null)
    return null;
  if (!licenseUsable(license, now)) return null;
  // The merge is committed BEFORE the mint (`activateFromIdentity`, then `authorizeAndMint`)
  // and nothing undoes it, so it is offered only when the mint can succeed. A device-code mint
  // presents no fingerprint, so a `strict` tier always refuses it (`fingerprint_required`): an
  // attach there would claim or retire the anonymous licence while the poll answers `error`,
  // and under R1-07 hand the starter's devices the victim's entitlements on a flow the Worker
  // refuses. Both a claim and a migrate end on the identity's tier (`activateFromIdentity`
  // rewrites an existing licence's `tier_id` to it), so that is the tier the mint resolves.
  const tier = await identityTier(db, product, identity, now);
  if ("error" in tier) return null;
  if ((await tierFingerprintMode(db, product, tier.tierId)) === "strict")
    return null;
  // `moving` has NO dormancy floor. A claim keeps every row on the licence and a migrate
  // (`moveDevices`) re-points every row, dormant ones included, the latter with
  // `seat_no = NULL`. A dormant device has given up its ordinal (`releaseDormantSeats`), so the
  // starter can fill that seat again with a new device; the dormant one then comes back without
  // claiming a seat (`validateDeviceToken` rebuilds its token record from the device row, and
  // nothing on that path calls `claimDeviceSeat`). Counting only recently seen devices would let
  // a starter stockpile dormant devices on its own anonymous licence and land all of them on the
  // victim's.
  const moving = await countActiveDevices(db, product.slug, license.id);
  const destination = await getLicenseBySub(db, product.slug, identity.sub);
  if (!destination) {
    const limit = await postActivationDeviceLimit(
      db,
      product,
      identity,
      license,
      tier,
      now,
    );
    if (limit <= 0 || moving > limit) return null;
    return license.id;
  }
  // An unusable destination makes `activateFromIdentity` refuse before it moves anything.
  if (!licenseUsable(destination, now)) return null;
  const limit = await postActivationDeviceLimit(
    db,
    product,
    identity,
    destination,
    tier,
    now,
  );
  // `held` keeps the floor: the destination's own dormant devices have given up their seats
  // under R3.
  const held = await countActiveDevices(
    db,
    product.slug,
    destination.id,
    seatActiveSince(now),
  );
  if (limit <= 0 || moving + held > limit) return null;
  return license.id;
}

async function pollAuthFlow(
  env: Env,
  db: Db,
  product: Product,
  state: string | null,
  deviceId: string | null,
  now: number,
  surface: "state" | "deviceCode",
  ask: DevicePollAsk = NO_ASK,
): Promise<Response> {
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing state/device");
  const stateKey = await flowKey(env, product.slug, state);
  const raw = await getArtefact(env, stateKey);
  if (!raw) return json({ status: "timeout" });
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return json({ status: "timeout" });
  // A device-code flow redeems only through `/device/poll`, with the device code. On the
  // `state` surface, `state` (on the authorize URL a user-code holder is 303'd to) plus the
  // device id would otherwise be a complete credential for the victim's token (R8-02, P1-06).
  // Nothing a `state`-surface poll sends reaches the deferred activation below either: it never
  // gets past this line (P1-07).
  if (surface === "state" && flow.viaDeviceCode)
    return json({ status: "error" });
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId && !flow.identity) return json({ status: "pending" });
  // `state` is a non-secret by construction (it rides on the authorize and callback URLs), so
  // it can never be the sole authorization input: the token is minted for the device that
  // STARTED the flow and only after the human confirmed it — the same two guards
  // handleAuthDevicePoll enforces, which this surface used to skip entirely (R8-01). The
  // answers are the existing generic ones, so a prober learns nothing new.
  if (!flow.deviceId || flow.deviceId !== deviceId)
    return json({ status: "error" });
  if (!flow.confirmedAt) return json({ status: "pending" });

  let licenseId = flow.licenseId;
  let attached: "claimed" | "migrated" | undefined;
  if (!licenseId) {
    // The deferred activation of a device-code flow (P1-07). Only the device-code surface gets
    // here (the `state` surface refused above), so only the device-code holder, polling as the
    // device the flow was started for, decides.
    const identity = flow.identity!;
    let enrolledLicenseId: string | null = null;
    if (ask.confirmIdentity || ask.attachLicense !== null) {
      const attachable = await attachableLicense(
        env,
        db,
        product,
        ask.token,
        deviceId,
        identity,
        now,
      );
      // The decision is honoured only once the device has been shown the identity, and an
      // attach only while there is something to attach; otherwise the device is (re)shown the
      // identity with what is attachable NOW, and nothing is minted or merged.
      if (
        ask.attachLicense === null ||
        !flow.identityShownAt ||
        (ask.attachLicense && !attachable)
      ) {
        if (!flow.identityShownAt) {
          flow.identityShownAt = now;
          await updateArtefact(env, stateKey, {
            expect: { identityShownAt: null },
            set: { identityShownAt: now },
          });
        }
        return json({
          status: "confirm",
          identity: shownIdentity(identity),
          attachable: attachable !== null,
        });
      }
      if (ask.attachLicense) enrolledLicenseId = attachable;
    }
    const result = await activateFromIdentity(db, product, identity, now, {
      enrolledLicenseId,
    });
    if ("error" in result) {
      // The callback checked this; it can still change underneath a waiting flow (the
      // identity's licence was disabled meanwhile). Same generic answer as every failure (D8).
      await deleteArtefact(env, stateKey);
      return json({ status: "error" });
    }
    licenseId = result.licenseId;
    attached = result.merged;
    // Recorded before minting, so a retried poll after a failed mint reuses this licence and
    // never runs the activation (or the merge) twice.
    flow.licenseId = licenseId;
    await updateArtefact(env, stateKey, { set: { licenseId } });
  }

  // Redeem the flow atomically BEFORE minting (G15): of two racing polls, exactly one takes the
  // record and mints; the other sees it gone and answers `timeout`, as it would a moment later.
  // A mint that then fails puts the record back (with its `licenseId`), so a retried poll
  // reuses that licence and never runs the activation (or the merge) twice.
  const redeemed = await consumeArtefact(env, stateKey);
  if (!redeemed) return json({ status: "timeout" });
  let token: string;
  try {
    token = await authorizeAndMint(env, db, product, licenseId, deviceId, now);
  } catch {
    const back = parseFlowRecord<FlowRecord>(redeemed) ?? flow;
    back.licenseId = licenseId;
    await putArtefact(
      env,
      stateKey,
      JSON.stringify(back),
      FLOW_TTL_SECONDS,
    ).catch(() => undefined);
    return json({ status: "error" });
  }
  return json({
    status: "ready",
    token,
    schemaVersion: product.schemaVersion,
    // Who the device is now signed in as, for it to show (P1-06's residual: a user-code holder
    // who confirmed and signed in as themselves binds the device to THEIR account, and the
    // player must be able to see that). Device-code flows only.
    ...(flow.identity ? { identity: shownIdentity(flow.identity) } : {}),
    ...(attached ? { attached } : {}),
  });
}

/** GET /<product>/identity/auth/poll?state=&device= — return a token once a device-bound flow
 *  completes. A flow `/device/start` began is refused here (generic `error`): it redeems only on
 *  `/device/poll`, with the device code (R8-02, P1-06). */
export async function handleAuthPoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authPoll", id: clientIp(req), limit: 120, windowSec: 60 },
    { bucket: "authPollState", id: state ?? "-", limit: 40, windowSec: 60 },
  );
  if (limited) return limited;
  return pollAuthFlow(
    env,
    db,
    product,
    state,
    url.searchParams.get("device"),
    now,
    "state",
  );
}

/** POST /<product>/identity/auth/device/poll — poll a confirmed device sign-in flow. */
export async function handleAuthDevicePoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const state =
    typeof body.deviceCode === "string"
      ? body.deviceCode
      : typeof body.state === "string"
        ? body.state
        : null;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing deviceCode/deviceId");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authDevicePoll", id: clientIp(req), limit: 120, windowSec: 60 },
    { bucket: "authDevicePollCode", id: state, limit: 40, windowSec: 60 },
  );
  if (limited) return limited;
  const deviceKey = await deviceFlowKey(env, product.slug, state);
  const raw = await getArtefact(env, deviceKey);
  if (!raw) return json({ status: "timeout" });
  const deviceFlow = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!deviceFlow) return json({ status: "timeout" });
  if (deviceFlow.deviceId !== deviceId)
    return errorResponse(401, "unauthorized", "device mismatch");
  // The `interval` we advertise at /identity/auth/device/start is enforced, not decorative: a client
  // polling faster than the contract is told to slow down instead of being served (R8-02).
  if (
    deviceFlow.lastPollAt !== undefined &&
    now - deviceFlow.lastPollAt < DEVICE_POLL_INTERVAL_SECONDS
  ) {
    return json(
      { status: "slow_down", interval: DEVICE_POLL_INTERVAL_SECONDS },
      { status: 429 },
    );
  }
  // Taking the poll slot is a compare-and-set on the `lastPollAt` this poll read: of two polls
  // racing inside one interval, one proceeds and the other is told to slow down, so the
  // deferred activation below can never run twice side by side.
  const slot = await updateArtefact(env, deviceKey, {
    expect: { lastPollAt: deviceFlow.lastPollAt ?? null },
    set: { lastPollAt: now },
  });
  if (!slot.ok) {
    if (!slot.payload) return json({ status: "timeout" });
    return json(
      { status: "slow_down", interval: DEVICE_POLL_INTERVAL_SECONDS },
      { status: 429 },
    );
  }
  deviceFlow.lastPollAt = now;
  if (!deviceFlow.confirmedAt) return json({ status: "pending" });
  const res = await pollAuthFlow(
    env,
    db,
    product,
    deviceFlow.state,
    deviceFlow.deviceId,
    now,
    "deviceCode",
    {
      confirmIdentity: body.confirmIdentity === true,
      attachLicense:
        typeof body.attachLicense === "boolean" ? body.attachLicense : null,
      token: bearer(req),
    },
  );
  const bodyOut = (await res
    .clone()
    .json()
    .catch(() => null)) as { status?: string } | null;
  if (bodyOut?.status === "ready" || bodyOut?.status === "timeout") {
    await deleteArtefact(env, deviceKey);
    await deleteUserCodeIndex(env, product.slug, deviceFlow.userCode);
  }
  return res;
}
