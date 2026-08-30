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
import {
  activeCatalog,
  isManagedSecretKey,
  parsePayload,
  sealManagedValue,
  type ManagedPayload,
} from "../../core/payload.js";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
// R9-01: the manifest validator's issuer rule, applied again at the SINK. Ingest-only
// validation would leave every `oidc_config` row written before it landed (or by any future
// writer that bypasses `parseManifest`) able to steer the token POST that carries this
// product's client secret. Imported from the shared package rather than through Release, whose
// `manifest.ts` merely re-exports it — a service may not import a sibling.
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import {
  bearer,
  hashKey,
  platformOidcConfig,
  secret,
  staticHtmlSecurityHeaders,
  randomId,
  type Db,
  type Env,
} from "../../core/platform.js";
import { openProductSecret, type Product } from "../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../core/errors.js";
import { clientIp, rateLimitOk, type RateLimit } from "../../core/rateLimit.js";
import {
  appendAudit,
  claimEnrolledLicense,
  getDeviceByTokenHash,
  getLicense,
  getLicenseBySub,
  getTier,
  insertLicense,
  moveDevices,
} from "../../core/data.js";
import { allowsOidcDefault } from "../../core/fingerprint.js";
import { authorizeDevice, tierExpiresAt } from "../../core/authz.js";
import { licenseUsable, validateDeviceToken } from "../../core/devices.js";
import {
  clearFlowCookie,
  flowBindingMatches,
  mintFlowBinding,
} from "../../core/oidcFlow.js";
import { safeReturnUrl } from "../../core/returnTo.js";
import { createBrowserSession } from "./browserSession.js";

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
  /** `hashKey` of the `__Host-pkey_flow` cookie value handed to the browser that STARTED this
   *  flow (A3-06). Present on the browser-redirect flow only — a device/loopback flow is
   *  legitimately finished in a different browser. See `core/oidcFlow.ts`. */
  flowHash?: string;
  /** The device that started a device-code/loopback flow. Carried so sign-in can see which
   *  license that device is already running on and claim it if it's an auto-issued one. */
  deviceId?: string;
  /**
   * `hashKey` of the device token that PROVED ownership of `deviceId` at start (A3-01).
   *
   * `deviceId` is `X-PKey-Device`, "a client-chosen string with no uniqueness requirement"
   * (`core/devices.ts`), disclosed to every portal co-owner and to the console, and for the
   * browser realm literally derivable (`browser:<licenseId>`). It is an IDENTIFIER, never
   * evidence of a relationship to a licence — so the claim/migrate path in
   * `activateFromIdentity` keys off this hash instead, and a start that could not prove itself
   * simply carries none.
   */
  deviceTokenHash?: string;
  licenseId?: string;
  error?: string;
  /** Stamped when the human confirms the device-code flow. A device flow may only mint after
   *  this is set — the poll surfaces must not be able to skip the confirmation (R8-01). */
  confirmedAt?: number;
  /** Stamped by the first callback that claims this state. A state is single-use: a second
   *  callback must never be able to rebind `licenseId` under a waiting poller (R8-04). */
  consumedAt?: number;
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
 * `docs/security/findings/R9-injection.md`. The platform issuer is exempt: it is a Worker
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
      clientSecret = await openProductSecret(
        db,
        env,
        product.slug,
        row.client_secret_secret,
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
 * KV keys for an in-flight product sign-in (B7-03 / A3-B1).
 *
 * The `state` and the device code used to BE the key names, so listing the HOT namespace handed
 * over live credentials from metadata alone — with the PKCE `verifier` and the flow's bound
 * licence sitting in the value next to them. R12-04 fixed exactly one of the five named sites
 * (`admin/auth.ts`); these are two more, and they take the same treatment: the key is
 * `hashKey(credential, KEY_HASH_PEPPER)`, so a key name is no longer a usable `state` (or device
 * code) and cannot be reversed into one without the pepper. The product prefix stays in front of
 * the hash — tenant isolation is a property of the key SHAPE (R5), not of the credential.
 */
async function flowKey(
  env: Env,
  product: string,
  state: string,
): Promise<string> {
  return `p:${product}:flow:${await hashKey(state, env.KEY_HASH_PEPPER)}`;
}

async function deviceFlowKey(
  env: Env,
  product: string,
  code: string,
): Promise<string> {
  return `p:${product}:device-flow:${await hashKey(code, env.KEY_HASH_PEPPER)}`;
}

/**
 * The human-readable code shown on the confirmation page — minted with its OWN entropy (A3-03).
 *
 * It used to be `deviceCode.slice(0, 8).toUpperCase()`, i.e. a case-folded prefix of the secret
 * device code. Anyone who could see the code a user was asked to read aloud (a shoulder, a
 * screenshot, a support ticket) held 48 bits of the credential that redeems the flow. The two
 * values answer different questions and now have independent lifetimes: `deviceCode` is a
 * secret, `userCode` is a display string.
 *
 * The alphabet drops the characters that are ambiguous when read or typed (`I`/`1`, `O`/`0`,
 * `S`/`5`, `B`/`8`, `U`/`V`), which is the whole reason RFC 8628 §6.1 asks for a distinct user
 * code. 8 characters over 27 symbols is ~38 bits, against a flow that lives 600 seconds behind a
 * rate-limited verification surface — and the user code is not the redemption credential in any
 * case, `deviceCode` is.
 */
const USER_CODE_ALPHABET = "ACDEFGHJKLMNPQRTWXYZ2346789";

function mintUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }
  return out;
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
/**
 * Apply provisioning hooks (verified claim -> entitlement + secret) into a payload.
 * `now` (epoch seconds) is stamped as `updatedAt` on every entry written.
 *
 * `env` is here for R12-02. The secret this writes is a real product secret — a subscription
 * URL with a verified claim interpolated into it — and it lands in `licenses.overrides_json`,
 * the same column `applyOverrides` seals before writing. It used to land there in PLAINTEXT,
 * because sealing was added at the console path and this writer was never brought along; a
 * read-only D1 dump therefore yielded every OIDC-provisioned secret in the clear while the
 * admin-authored value for the very same catalog key was ciphertext. Same column, same key,
 * same rule.
 */
export async function applyProvisioning(
  env: Env,
  db: Db,
  product: string,
  identity: OidcIdentity,
  payload: ManagedPayload,
  now: number,
): Promise<void> {
  const hooks = await getProvisioning(db, product);
  if (hooks.length === 0) return;
  // Resolved ONCE per call, not per hook: `isManagedSecretKey` is a catalog lookup, and
  // re-reading `product_schema` for every row would put an unbounded number of D1 reads on
  // the sign-in path for no new information.
  const catalog = await activeCatalog(db, product);
  for (const h of hooks) {
    const claimVal = identity.claims[h.claim];
    if (!claimEnables(claimVal)) continue;
    if (h.entitlement_key) {
      let value: ManagedEntry["value"] = true;
      if (h.entitlement_value_json) {
        const parsed = parseJsonColumn<ManagedEntry["value"]>(
          h.entitlement_value_json,
        );
        // A hook row we cannot parse is a hook we do not trust: skip it entirely.
        if (parsed === undefined) continue;
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
      const url = h.secret_url_template.replaceAll(
        "{claim}",
        encodeURIComponent(String(claimVal)),
      );
      // Host allowlist (defense against templated-secret injection). Fails CLOSED: a missing
      // or malformed allowlist drops the secret rather than emitting any host (R8-06).
      const allowed = parseJsonColumn<string[]>(h.allowed_hosts_json);
      if (!Array.isArray(allowed)) continue;
      try {
        if (!allowed.includes(new URL(url).host)) continue;
      } catch {
        continue;
      }
      // Seal exactly as `admin/lib/overrides.ts` does — same helper, same AAD, so the console
      // and the sign-in path write interchangeable envelopes for one catalog key and either
      // can rotate the other's value. The catalog-unavailable arm FAILS CLOSED (seal anyway),
      // which costs nothing: this bucket is `secrets`, `validatePayload` only lets a
      // `kind: "secret"` entry out of it, and `isManagedSecretKey` is true for every such
      // entry — so any value that could ever be DELIVERED is one the catalog would have told
      // us to seal. Refusing to classify is not a reason to write plaintext.
      const value =
        !catalog || isManagedSecretKey(catalog, h.secret_key)
          ? await sealManagedValue(env, product, h.secret_key, url)
          : url;
      payload.secrets[h.secret_key] = {
        state: "hidden",
        value,
        updatedAt: now,
      };
    }
  }
}

/**
 * Overlay a sign-in's provisioning output onto whatever is already stored on the licence.
 *
 * Provisioning owns the keys its hooks name and NOTHING else, so the stored entry survives for
 * every other key. `activateFromIdentity` used to start from an empty `ManagedPayload` and
 * `UPDATE licenses SET overrides_json = ?` with it, which meant every OIDC sign-in silently
 * discarded whatever an admin had set on that licence in the console — the operator's edit
 * lasted exactly until the user next signed in, with no error and no audit row. The provisioned
 * entries still WIN (they are spread last), because a hook re-evaluated against fresh verified
 * claims is the newer statement about the keys it owns.
 */
function overlayProvisioned(
  stored: ManagedPayload,
  provisioned: ManagedPayload,
): ManagedPayload {
  return {
    config: { ...stored.config, ...provisioned.config },
    secrets: { ...stored.secrets, ...provisioned.secrets },
    entitlements: { ...stored.entitlements, ...provisioned.entitlements },
  };
}

/** Find or mint a license for an identity. Returns the licenseId, or an error if the
 *  identity's groups don't grant entitlement. Idempotent on the OIDC subject. */
export async function activateFromIdentity(
  env: Env,
  db: Db,
  product: Product,
  identity: OidcIdentity,
  now: number,
  /** The license the caller's device is already using, when it presented one. An anonymous
   *  enrolled license found here is merged into the identity rather than abandoned. */
  opts: { enrolledLicenseId?: string | null } = {},
): Promise<
  { licenseId: string; merged?: "claimed" | "migrated" } | { error: string }
> {
  const oidc = await getOidcConfig(db, product.slug);
  // A malformed map grants nothing (fail closed) instead of throwing out of sign-in (R8-06).
  const parsedMap =
    parseJsonColumn<Record<string, { role: string; tier?: string }>>(
      oidc?.group_role_map_json,
    ) ?? {};
  // B4-02: a MAP, not the plain object. `map[g]` walked the prototype chain, so an IdP that
  // asserted a group literally named `constructor`, `toString`, `valueOf` or `__proto__`
  // matched `Object.prototype` and came out ENTITLED against a `group_role_map_json` that
  // named no such group. `new Map(Object.entries(...))` sees own enumerable keys only, so the
  // lookup answers about the operator's configuration and nothing else. (`m.tier` is then read
  // off a value the operator wrote, not off `Object.prototype`.)
  const map = new Map(Object.entries(parsedMap));

  let entitled = false;
  let tierId: string | null = null;
  for (const g of identity.groups) {
    const m = map.get(g);
    if (m && typeof m === "object") {
      entitled = true;
      if (m.tier && !tierId) tierId = m.tier;
    }
  }
  if (!entitled) {
    // No mapped group. If the product opts into an OIDC default tier, any authenticated user
    // lands on the free tier instead of a hard 403; with the policy unset this is byte-for-byte
    // the previous behaviour.
    if (allowsOidcDefault(product.autoIssue) && product.autoIssue.tierId) {
      entitled = true;
      tierId = product.autoIssue.tierId;
    } else {
      return { error: "not-entitled" };
    }
  }

  let expiresAt: number | null = null;
  if (tierId) {
    expiresAt = tierExpiresAt(await getTier(db, product.slug, tierId), now);
  }

  const provisioned: ManagedPayload = {
    config: {},
    secrets: {},
    entitlements: {},
  };
  await applyProvisioning(env, db, product.slug, identity, provisioned, now);

  /**
   * B2-01 — the issuer class that is producing `identity.email` on THIS sign-in, stamped onto
   * the row in the same statements that write the address.
   *
   * `AUTO_LINK_ENABLED_SQL` used to answer "may this licence auto-link into a portal account?"
   * at READ time, from the product's CURRENT `oidc_config.provider`. Nothing on the row recorded
   * which issuer had actually vouched for the address, so the containment was reversible by
   * editing the product: mint licences for a victim's address under your own custom issuer
   * (`email_verified: true` is yours to assert), then push a `.pkey/product` that lowers
   * `oidc.provider` from `custom` to `platform`, and every one of those rows retroactively
   * became auto-linkable — permanently, with no self-service removal. Recording the resolved
   * provider at WRITE time makes the decision a fact about the sign-in that happened rather than
   * about the manifest as it stands today.
   */
  const emailIssuerClass =
    (oidc?.provider ?? "platform") === "custom" ? "custom" : "platform";

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
        emailIssuerClass,
      },
      now,
    );
    await db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify(
        overlayProvisioned(parsePayload(claimable.overrides_json), provisioned),
      ),
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
         expires_at = ?, overrides_json = ?, email_issuer_class = ?,
         modified_by = ?, modified_at = ?
       WHERE product = ? AND id = ?`,
      identity.name ?? null,
      identity.email ?? null,
      JSON.stringify(identity.groups),
      tierId,
      expiresAt,
      JSON.stringify(
        overlayProvisioned(parsePayload(existing.overrides_json), provisioned),
      ),
      // Rewritten with `email`, not merely on insert: the address on this row is whatever the
      // LATEST sign-in asserted, so the class that vouches for it has to move with it (B2-01).
      emailIssuerClass,
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
    // A brand-new row has nothing to preserve, so the provisioning output IS the payload.
    overrides_json: JSON.stringify(provisioned),
    channels_json: null,
    min_version: null,
    max_version: null,
    email_issuer_class: emailIssuerClass,
    modified_by: "oidc",
    modified_at: now,
  });
  // B2-05b — the SELF-SERVICE mint gets an audit row, like every other way a licence comes into
  // existence. The two merge arms above have written `license.merge` since they landed, and
  // `enroll.ts` audits its auto-issue; the one path where a stranger turns a verified claim into
  // a brand-new licence row wrote nothing at all. That is the first link of the B2-01 chain
  // (mint under a tenant issuer, then auto-link into a victim's portal account), and with no row
  // here the chain had no trace anywhere in the platform. `emailIssuerClass` is recorded in the
  // summary because it is the fact that decides the second link.
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: identity.sub,
    actor_name: identity.name ?? null,
    actor_email: identity.email ?? null,
    action: "license.mint.oidc",
    target_kind: "license",
    target_id: licenseId,
    parent_id: null,
    summary: `Minted a license for ${identity.email ?? identity.sub} via ${emailIssuerClass} OIDC`,
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
  const result = await authorizeDevice(env, db, product, row, deviceId, now);
  if ("error" in result) throw new Error(result.error);
  return result.token;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
async function beginAuthFlow(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  opts: {
    returnTo?: string;
    deviceId?: string;
    deviceTokenHash?: string;
    /** Bind the flow to THIS browser (A3-06). Off for the device/loopback flow, which is
     *  legitimately finished somewhere else. */
    bindBrowser?: boolean;
  } = {},
): Promise<
  | {
      ok: true;
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      /** The `Set-Cookie` that carries the browser binding, when one was minted. */
      bindingCookie?: string;
    }
  | Response
> {
  const { returnTo, deviceId, deviceTokenHash, bindBrowser } = opts;
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
  const binding = bindBrowser ? await mintFlowBinding(env) : null;
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    returnTo,
    deviceId,
    deviceTokenHash,
    ...(binding ? { flowHash: binding.hash } : {}),
  };
  await env.HOT.put(
    await flowKey(env, product.slug, state),
    JSON.stringify(flow),
    { expirationTtl: FLOW_TTL_SECONDS },
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
    ...(binding ? { bindingCookie: binding.cookie } : {}),
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
  const returnTo = safeReturnUrl(req, rawReturnTo);
  if (rawReturnTo && !returnTo)
    return errorResponse(400, "bad_request", "return_to not allowed");
  const flow = await beginAuthFlow(req, env, db, product, {
    returnTo,
    // A3-06 — this is THE browser-redirect entry point, so the flow it writes is bound to the
    // browser that asked for it and the callback will not accept it from any other.
    bindBrowser: true,
  });
  if (flow instanceof Response) return flow;
  return new Response(null, {
    status: 302,
    headers: {
      location: flow.authorizeUrl,
      ...(flow.bindingCookie ? { "set-cookie": flow.bindingCookie } : {}),
    },
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

  /**
   * A3-01 — the ONLY thing that turns `deviceId` into an authorization input.
   *
   * `deviceId` arrives unauthenticated and is not a credential: `core/devices.ts` calls
   * `X-PKey-Device` "a client-chosen string with no uniqueness requirement", the portal lists
   * every device id to every co-owner of a licence, the console shows it, and in the browser
   * realm it is literally `browser:<licenseId>`. Downstream, `handleAuthCallback` used it to
   * look up a device row and hand its `license_id` to `activateFromIdentity` as
   * `enrolledLicenseId` — so anyone who could complete an OIDC sign-in and land entitled, while
   * naming ONE victim device id, took over the victim's licence row outright: `sub`, `name`,
   * `email`, `groups_json`, `tier_id` and `origin` all overwritten onto themselves, the victim's
   * live device token revoked, and — because `enroll_hwid` is deliberately retained (R3-05) —
   * the victim's machine permanently unable to re-enrol.
   *
   * So the device must PROVE the id. An already-enrolled client holds a `pkeyt_` device token;
   * presenting it (Authorization: Bearer, or `deviceToken` in the body) resolves through the
   * ordinary `validateDeviceToken` path, which also asserts the token belongs to exactly this
   * `deviceId`. Only then is a proof hash recorded on the flow.
   *
   * A start with no token, or with one that does not resolve, is NOT refused — that is the
   * genuinely-new-device case and it is the common one. It simply carries no proof, so the
   * callback contributes `enrolledLicenseId: null` and the sign-in gets an ordinary new or
   * existing licence of its own.
   */
  const presentedToken =
    (typeof body.deviceToken === "string" && body.deviceToken) || bearer(req);
  let deviceTokenHash: string | undefined;
  if (presentedToken) {
    const proof = await validateDeviceToken(
      env,
      db,
      product,
      presentedToken,
      Math.floor(Date.now() / 1000),
      { deviceId },
    );
    if (!("error" in proof)) deviceTokenHash = proof.tokenHash;
  }

  const flow = await beginAuthFlow(req, env, db, product, {
    deviceId,
    deviceTokenHash,
    // Deliberately NOT browser-bound: the device flow prints a URL a human may legitimately
    // open on a different machine entirely (A3-06). Its guards are the device binding and the
    // human confirmation `pollAuthFlow` enforces.
  });
  if (flow instanceof Response) return flow;
  const deviceCode = b64url(randomBytes(16));
  // A3-03: independent entropy, so the code the user reads aloud is not a prefix of the secret
  // one that redeems the flow.
  const userCode = mintUserCode();
  const deviceRecord: DeviceFlowRecord = {
    state: flow.state,
    deviceId,
    userCode,
    authorizeUrl: flow.authorizeUrl,
    deviceName,
  };
  await env.HOT.put(
    await deviceFlowKey(env, product.slug, deviceCode),
    JSON.stringify(deviceRecord),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  const origin = new URL(req.url).origin;
  const verificationUri = `${origin}/${product.slug}/identity/auth/device/verify?device_code=${encodeURIComponent(deviceCode)}`;
  return json({
    status: "pending",
    deviceCode,
    userCode,
    verificationUri,
    // A3-03: RFC 8628 §3.3.1 defines this as the verification URI **with the user code
    // included**, so the human does not have to transcribe it. It used to be emitted equal to
    // `verificationUri`, which made it a field that told the client nothing and told a reader
    // something false. Now it carries `user_code`, which the confirmation page displays back so
    // the user can check the two agree.
    verificationUriComplete: `${verificationUri}&user_code=${encodeURIComponent(userCode)}`,
    expiresIn: FLOW_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    pollUrl: `${origin}/${product.slug}/identity/auth/device/poll`,
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
 *  the IdP. Requires the CSRF token minted on the GET render, so neither a prefetch nor a
 *  cross-site form can confirm a flow (or read `state`/`nonce`) on the visitor's behalf. */
async function confirmDeviceFlow(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  url: URL,
  now: number,
): Promise<Response> {
  // Browsers always send Origin on a form POST; a cross-site submission is refused outright.
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin)
    return errorResponse(403, "forbidden", "confirmation failed");
  const token = await readConfirmToken(req);
  if (!record.csrf || !token || token !== record.csrf)
    return errorResponse(403, "forbidden", "confirmation failed");

  // The confirmation is an authorization input for the poll surfaces, so it is recorded on
  // the flow the pollers actually read, not only on the device record (R8-01).
  const stateKey = await flowKey(env, product.slug, record.state);
  const flowRaw = await env.HOT.get(stateKey);
  if (!flowRaw) return errorResponse(404, "not_found", "device code expired");
  const flow = parseFlowRecord<FlowRecord>(flowRaw);
  if (!flow) return errorResponse(404, "not_found", "device code expired");
  flow.confirmedAt = now;
  await env.HOT.put(stateKey, JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  record.confirmedAt = now;
  delete record.csrf; // single-use
  await env.HOT.put(
    await deviceFlowKey(env, product.slug, deviceCode),
    JSON.stringify(record),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
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

/** GET /<product>/identity/auth/device/verify — render the confirmation page.
 *  POST /<product>/identity/auth/device/verify — confirm it. The GET is deliberately side-effect free:
 *  it used to accept `?confirm=1`, which made an `<img src>` enough to confirm a flow AND
 *  handed the caller `state` + `nonce` in the 302 (R8-02). */
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
  const codeKey = await deviceFlowKey(env, product.slug, deviceCode);
  const raw = await env.HOT.get(codeKey);
  if (!raw) return errorResponse(404, "not_found", "device code expired");
  const record = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!record) return errorResponse(404, "not_found", "device code expired");

  if (req.method === "POST")
    return confirmDeviceFlow(req, env, product, deviceCode, record, url, now);

  const csrf = b64url(randomBytes(16));
  record.csrf = csrf;
  await env.HOT.put(codeKey, JSON.stringify(record), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  const deviceLabel = record.deviceName || record.deviceId;
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(product.name)}</title>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #0c0f17; color: #f8fafc;">
  <main style="max-width: 440px; margin: 12vh auto; padding: 32px;">
    <p style="color:#9aa4b2; margin:0 0 8px;">Polaris Key</p>
    <h1 style="font-size: 28px; margin:0 0 16px;">Authorize ${escapeHtml(product.name)}</h1>
    <p style="line-height:1.5; color:#cbd5e1;">A desktop app is asking to activate this device. Confirm the code and device before signing in.</p>
    <dl style="display:grid; grid-template-columns: 110px 1fr; gap:10px; margin:24px 0; color:#cbd5e1;">
      <dt>Code</dt><dd style="margin:0; color:#fff; font-weight:700; letter-spacing:.08em;">${escapeHtml(record.userCode)}</dd>
      <dt>Device</dt><dd style="margin:0;">${escapeHtml(deviceLabel)}</dd>
      <dt>Product</dt><dd style="margin:0;">${escapeHtml(product.slug)}</dd>
    </dl>
    <form method="post" action="${escapeHtml(url.toString())}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" style="display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 18px; border:0; border-radius:8px; background:#5b7cfa; color:#fff; font:inherit; font-weight:650; cursor:pointer;">Continue to sign in</button>
    </form>
  </main>
</body>`;
  return new Response(html, {
    status: 200,
    // R1-09: `index.ts`'s `secureResponse` backstop would supply this policy anyway, but a
    // handler that emits HTML should not depend on the dispatcher — a direct call (a test, or
    // a future internal caller) must be hardened too. `staticHtmlSecurityHeaders` preserves
    // the `referrer-policy` set here.
    headers: staticHtmlSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        // The address bar holds the device code: never let it ride along as a Referer, and
        // never let a shared cache keep the page (R8-02).
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      }),
    ),
  });
}

function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  // Only a VERIFIED email is trusted: this value is persisted on the license, signed into the
  // config document's identity profile, and is what the portal auto-links accounts on. An
  // unverified claim is attacker-chosen, so we store nothing rather than that (R8-05b).
  const email =
    payload.email_verified === true && typeof payload.email === "string"
      ? payload.email
      : undefined;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (email ?? "");
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

/**
 * The licence a flow's device has PROVEN it holds, or null (A3-01).
 *
 * Three conditions, all required: the flow recorded a device-token proof at start; that hash
 * still resolves to a device row on this product; and that row is the very `deviceId` the flow
 * names and is still authorized. Anything else — no proof, a revoked token, a device that has
 * since been re-bound to another licence, a `deviceId` that never proved itself — is `null`, and
 * `activateFromIdentity` then does what it does for any first-time sign-in.
 */
async function provenEnrolledLicense(
  db: Db,
  product: Product,
  flow: FlowRecord,
): Promise<string | null> {
  if (!flow.deviceId || !flow.deviceTokenHash) return null;
  const device = await getDeviceByTokenHash(
    db,
    product.slug,
    flow.deviceTokenHash,
  );
  if (!device || device.device_id !== flow.deviceId) return null;
  if (device.status !== "authorized") return null;
  return device.license_id || null;
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
  const key = await flowKey(env, product.slug, state);
  const raw = await env.HOT.get(key);
  if (!raw) return errorResponse(400, "bad_request", "unknown state");
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return errorResponse(400, "bad_request", "unknown state");
  // A3-06 — a flow that was started in a browser may only be finished in THAT browser. The
  // device/loopback flow is deliberately exempt (it carries no `flowHash` and never ends in a
  // `Set-Cookie`); a flow that WILL set a cookie has to be bound, so `flow.returnTo` forces the
  // check on even if the record somehow arrived without a hash. The answer is the same generic
  // "unknown state" the missing/replayed arms already return, so this adds no oracle.
  if (
    (flow.flowHash || flow.returnTo) &&
    !(await flowBindingMatches(req, env, flow.flowHash))
  ) {
    return errorResponse(400, "bad_request", "unknown state");
  }
  // Single-use state (R8-04). Claim the flow before any outbound call so a second callback
  // can never overwrite the license a poller is already waiting on; a replay gets exactly the
  // same generic answer as an unknown state.
  if (flow.consumedAt)
    return errorResponse(400, "bad_request", "unknown state");
  flow.consumedAt = now;
  await env.HOT.put(key, JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) {
    await env.HOT.delete(key);
    return oidc;
  }
  // Defense in depth: the stored flow's redirect_uri must still be allow-listed.
  if (!redirectUriAllowed(oidc.row, flow.redirectUri)) {
    await env.HOT.delete(key);
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
    await env.HOT.delete(key);
    return errorResponse(502, "oidc_error", "token exchange failed");
  }
  let tokens: { id_token?: string };
  try {
    tokens = (await tokenRes.json()) as { id_token?: string };
  } catch {
    await env.HOT.delete(key);
    return errorResponse(502, "oidc_error", "token response invalid");
  }
  if (!tokens.id_token) {
    await env.HOT.delete(key);
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
    await env.HOT.delete(key);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // An identity with no subject is not an identity: `getLicenseBySub(…, "")` would match every
  // other subject-less row, so distinct people would share one license. Admin and portal both
  // reject this already (admin/auth.ts:216, portal/auth.ts:280) — so does the product flow now
  // (R8-05a). Same generic 401 as any other bad ID token.
  const identity = mapClaims(claims);
  if (!identity.sub) {
    await env.HOT.delete(key);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // A3-01 — the enrolled licence a sign-in may claim, and the ONLY way to name one.
  //
  // A device-code/loopback flow carries the device id that started it, so that a device already
  // running on an auto-issued licence keeps its devices and local state instead of being
  // stranded on an orphan row. What it may NOT do is take that at the caller's word: this used
  // to be `getDevice(db, product, flow.deviceId).license_id`, with `flow.deviceId` a string the
  // unauthenticated start handler copied out of the request body. The licence a device holds is
  // resolved from the PROOF instead — the hash of a device token that `handleAuthDeviceStart`
  // watched `validateDeviceToken` resolve to this exact device id — and re-checked here, so a
  // device deauthorized or re-bound in between contributes nothing either.
  const enrolledLicenseId = await provenEnrolledLicense(db, product, flow);

  const result = await activateFromIdentity(env, db, product, identity, now, {
    enrolledLicenseId,
  });
  if ("error" in result) {
    // Failed activation: drop the flow so the poller gets a generic error, not the reason.
    await env.HOT.delete(key);
    return errorResponse(403, "forbidden", "not entitled");
  }
  flow.licenseId = result.licenseId;
  if (flow.returnTo) {
    const license = await getLicense(db, product.slug, result.licenseId);
    if (!license) {
      await env.HOT.delete(key);
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
    await env.HOT.delete(key);
    if (!session.ok) {
      return errorResponse(
        session.status,
        session.code,
        session.message,
        session.extra,
      );
    }
    // Two `Set-Cookie`s: the session the sign-in just earned, and the retirement of the
    // single-use flow binding it consumed. `Headers.append` is required — assigning the second
    // one would overwrite the first.
    const headers = new Headers({ location: flow.returnTo });
    headers.append("set-cookie", session.cookie);
    headers.append("set-cookie", clearFlowCookie());
    return new Response(null, { status: 302, headers });
  }
  await env.HOT.put(key, JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  return new Response(
    '<!doctype html><meta charset=utf-8><title>Signed in</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h1>You\'re signed in</h1><p>You can close this tab and return to the app.</p>',
    {
      status: 200,
      // R1-09 — see the device-authorization page above: set the policy at the sink as well
      // as in the dispatcher backstop.
      headers: staticHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

async function pollAuthFlow(
  env: Env,
  db: Db,
  product: Product,
  state: string | null,
  deviceId: string | null,
  now: number,
): Promise<Response> {
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing state/device");
  const key = await flowKey(env, product.slug, state);
  const raw = await env.HOT.get(key);
  if (!raw) return json({ status: "timeout" });
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return json({ status: "timeout" });
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId) return json({ status: "pending" });
  // `state` is a non-secret by construction (it rides on the authorize and callback URLs), so
  // it can never be the sole authorization input: the token is minted for the device that
  // STARTED the flow and only after the human confirmed it — the same two guards
  // handleAuthDevicePoll enforces, which this surface used to skip entirely (R8-01). The
  // answers are the existing generic ones, so a prober learns nothing new.
  if (!flow.deviceId || flow.deviceId !== deviceId)
    return json({ status: "error" });
  if (!flow.confirmedAt) return json({ status: "pending" });

  let token: string;
  try {
    token = await authorizeAndMint(
      env,
      db,
      product,
      flow.licenseId,
      deviceId,
      now,
    );
  } catch {
    return json({ status: "error" });
  }
  await env.HOT.delete(key);
  return json({ status: "ready", token, schemaVersion: product.schemaVersion });
}

/** GET /<product>/identity/auth/poll?state=&device= — return a token once the flow completes. */
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
  const codeKey = await deviceFlowKey(env, product.slug, state);
  const raw = await env.HOT.get(codeKey);
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
  deviceFlow.lastPollAt = now;
  await env.HOT.put(codeKey, JSON.stringify(deviceFlow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  if (!deviceFlow.confirmedAt) return json({ status: "pending" });
  const res = await pollAuthFlow(
    env,
    db,
    product,
    deviceFlow.state,
    deviceFlow.deviceId,
    now,
  );
  const bodyOut = (await res
    .clone()
    .json()
    .catch(() => null)) as { status?: string } | null;
  if (bodyOut?.status === "ready" || bodyOut?.status === "timeout") {
    await env.HOT.delete(codeKey);
  }
  return res;
}
