// @polaris-key/protocol/identity — Identity on the wire. Types and constants only, no runtime,
// no crypto. Created by PX-W17 (plans/PX-W17.md §2); PX-W13 adds §12.7, passthrough request
// metadata (plans/PX-W13.md §2); I-08 and I-09 add their sections beside it (I-09: the account
// contract, the pairwise-subject pattern, the claim refusals).
//
// Identity is a per-product service: one Polaris Key account per person, platform-wide, and a
// product's `identity` toggle gates only sign-in THROUGH that product. With it off, device and
// JSON routes under `/<p>/identity/*` answer `not_found` and `POST /<p>/devices/register`
// keeps its single `registration_closed` body; only a person sees `identity_disabled`
// (WIRE-CONTRACT-V4 §12.8). PX-W9 adds §12.2, key entry: the counter's member, the
// `key_entry_limit` refusal body and the signed-out key preview (plans/PX-W9.md §2).
//
// Nothing here is signed. The device label is display data that no server decision reads
// (§12.7.1); the request handle, the client record and the app-consent view are same-origin
// portal JSON (§12.7.2, §12.7.3). `PROTOCOL_VERSION` stays 4.

/**
 * The `error` query value of the friendly sign-in card, and the code of the portal passthrough
 * context's `403`: a browser navigation to an app-sign-in entry of an Identity-off product is
 * answered `303 Location: <origin>/signin?product=<slug>&error=identity_disabled`.
 */
export const IDENTITY_DISABLED_ERROR_PARAM = "identity_disabled";

/**
 * §12.7.1: the most code points a normalised device label keeps. Code points, not UTF-16 units:
 * Godot strings are UTF-32 and every runner compares code points.
 */
export const DEVICE_LABEL_MAX_CODEPOINTS = 64;

/**
 * §12.7.1 step 1: the code points a device label maps to U+0020 before anything else (the C0
 * whitespace controls, NEL, NBSP, the line and paragraph separators and the ideographic space).
 * Inclusive `[first, last]` ranges.
 */
export const DISPLAY_TEXT_SPACE: readonly (readonly [number, number])[] = [
  [0x0009, 0x000d],
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x2028, 0x2029],
  [0x3000, 0x3000],
];

/**
 * §12.7.1 step 2: the code points a device label drops — the C0 and C1 controls, the Arabic letter
 * mark, the zero-width and directional marks, the bidi embeddings and overrides, the invisible
 * operators, the bidi isolates and the BOM. The manifest rule `invalid_display_text` refuses a
 * display name that holds any of them. Inclusive `[first, last]` ranges.
 */
export const DISPLAY_TEXT_STRIP: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/** §12.7.2: an opaque sign-in request handle, `rq_` and 16 random bytes in base64url. */
export const REQUEST_HANDLE_PATTERN = "^rq_[A-Za-z0-9_-]{22}$";

/** §12.7.2: how long a request handle lives, equal to the sign-in flow's own lifetime. */
export const REQUEST_HANDLE_TTL_SECONDS = 600;

/** The kind of client a sign-in request came from (§12.7.2). */
export type ClientKind = "web" | "native" | "device";

/**
 * The server-side view of the app asking to sign the person in (§12.7.2). Built from data the
 * Worker already holds; never from a query parameter.
 */
export interface ClientRecord {
  product: string;
  kind: ClientKind;
  /** The listing name, else the product name. The product slug when `nameVerified` is false. */
  appName: string;
  developerName: string | null;
  /** Same-origin `/media/<product>/icon`, or null. */
  iconUrl: string | null;
  /**
   * The product's art for the landscape passport (PX-33): same-origin `/media/<product>/header?v=…`.
   * Absent when the product has none; never personalised, display data only.
   */
  artUrl?: string;
  /** The product's registered `web.origins`. */
  origins: string[];
  /** The services the person's sign-in reaches. */
  services: { license: boolean; cloudSync: boolean };
  /** False when the render-time display-name check failed: render the neutral frame. */
  nameVerified: boolean;
}

/** `GET /api/signin/requests/:handle` (§12.7.2). */
export interface SignInRequestView {
  request: string;
  client: ClientRecord;
  /** The device's normalised label (§12.7.1), reported by the device; null when it sent none. */
  deviceLabel: string | null;
  /** The device-code user code, on a `device` request. */
  userCode: string | null;
  /** Epoch seconds. */
  expiresAt: number;
  /**
   * I-08 (§12.4), on a request that came through `authorize`: its `purpose`, licence-choice mode,
   * the scope the app asked for (as resolved) and the two hints. Hints prefill the card (the email
   * field, the name step) and verify nothing.
   */
  purpose?: AuthorizePurpose;
  licenseChoice?: AuthorizeLicenseChoice;
  scope?: string[];
  loginHint?: string | null;
  nameHint?: string | null;
}

/** One line of what an app gets when the person continues (§12.7.3). */
export type ConsentItem =
  | {
      kind: "license";
      /** The licence the device would anchor on (a dry run that writes nothing), or null. */
      anchor: {
        name: string;
        tierName: string | null;
        /** `perpetual`, or the licence's end as epoch seconds. */
        term: "perpetual" | number;
        seat: { position: number; limit: number } | null;
      } | null;
      /** How many other licences and grants the account holds for this product (0 under `legacy`). */
      more: number;
    }
  | { kind: "cloudSync" }
  | { kind: "profile"; claims: string[] };

/** `GET /api/signin/requests/:handle/consent` (§12.7.3): app consent, never the S-19 grants. */
export interface AppConsentView {
  request: string;
  /** Shown to the person only. */
  person: {
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  items: ConsentItem[];
  /** Lowercase hex SHA-256 of the canonical JSON `{claims, services, v: 1}`. */
  scopeHash: string;
  /** No app consent is recorded for this account and product yet. */
  firstTime: boolean;
  /** A consent is recorded, under a different `scopeHash`. */
  changed: boolean;
}

/** `POST /<p>/identity/auth/device/start`'s answer. `deviceName` echoes the stored label. */
export interface DeviceStartResponse {
  status: "pending";
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  pollUrl: string;
  /** The normalised label the Worker stored (§12.7.1), or null. Absent from an older Worker. */
  deviceName: string | null;
}

/** §12.10: the one `reason` a device-code poll's `error` carries. A person refused the flow. */
export const DEVICE_POLL_DENIED = "access_denied" as const;

/** §12.10: `POST /<p>/identity/auth/device/poll` at HTTP 200. */
export type DevicePollResponse =
  | { status: "pending" }
  | {
      status: "confirm";
      identity: { name?: string; email?: string };
      attachable: false;
    }
  | {
      status: "ready";
      token: string;
      schemaVersion: number;
      identity?: { name?: string; email?: string };
    }
  | { status: "timeout" }
  | { status: "error"; reason?: typeof DEVICE_POLL_DENIED };

/** §12.10: the same route at HTTP 429 (a state, not an error body). */
export interface DevicePollSlowDown {
  status: "slow_down";
  interval: number;
}

/** §12.10 rule 5: the same route at HTTP 503, with `Retry-After` (LEGACY FLAT, as its 400/401/429). */
export interface DevicePollUnavailable {
  error: "unavailable";
  message?: string;
}

// ── §12.2 Key entry (PX-W9) ─────────────────────────────────────────────────────────────────

/**
 * §12.2 rule 5: a licence's key entries on an Identity product. `used` is the count of recorded
 * entries and may exceed `limit` (races at the last entry, portal claims, a period with refusals
 * off); a client shows `max(0, limit - used)` left. Present on every key-entry 2xx and on
 * `key_entry_limit`, absent with Identity off.
 */
export interface KeyEntries {
  used: number;
  /** The product's effective `identity.keyEntry.limit`: 1 to 100, default 10. */
  limit: number;
}

/** §12.2 rule 1: where a key entry happened. */
export type KeyEntrySurface = "app" | "browser" | "portal";

/**
 * §12.2 step 4: the flat 403 of `POST /<p>/license/activate` and
 * `POST /<p>/identity/session/license` when the licence has no entries left and refusals are on.
 * Not an auth failure: a client keeps its state and offers `manageUrl` behind a user action.
 */
export interface KeyEntryLimitBody {
  error: "key_entry_limit";
  message?: string;
  /** The §5.3 refusal link (`<portal>/activate?product=<slug>`), absent while the portal is off. */
  manageUrl?: string;
  keyEntries: KeyEntries;
}

/**
 * §12.2 rule 8: whether the account upgrade the key preview leads to may be skipped. `forced` only
 * when the verdict is `addable`, refusals are on and `used >= limit`.
 */
export type KeyUpgrade = "skippable" | "forced";

/** §12.2 rule 8: the signed-out preview's verdict. `email_mismatch` stays a signed-in verdict. */
export type KeyPreviewVerdict = "addable" | "license_owned" | "portal_off";

/**
 * `POST /api/key/preview` (§12.2 rule 8): what a key would do, before anyone signs in. Read-only,
 * never counted. Never an email, a masked email, a licence id, devices or an account.
 */
export interface KeyPreview {
  /** The product's public presentation, as the signed-in activate preview shows it. */
  product: {
    slug: string;
    name: string;
    branding: unknown;
    developerName: string | null;
    iconUrl: string | null;
    headerUrl: string | null;
  };
  verdict: KeyPreviewVerdict;
  /** The licence's tier and term; `null` on `portal_off`. */
  license: {
    tierName: string | null;
    /** `perpetual`, or the licence's end as epoch seconds. */
    term: "perpetual" | number;
  } | null;
  /** `null` with Identity off and on `portal_off`. */
  keyEntries: KeyEntries | null;
  upgrade: KeyUpgrade;
}

// ── §12.2 step 3, §12.3 and §12.6: the account on the device wire (I-09) ─────────────────────

/**
 * §8: a pairwise subject, `ps_` and 16 random bytes in base64url. The one name a developer-facing
 * surface ever uses for an account, different for every product (S-16 §5.1). Declared in `/core`
 * since SP-54, because the licence document's `profile.user.subject` carries it too.
 */
export { PAIRWISE_SUBJECT_PATTERN } from "./core.js";

/**
 * §12.2 step 3: the flat 403 of `POST /<p>/license/activate` and
 * `POST /<p>/identity/session/license` when the key's licence is in an account and the device is
 * not enrolled on it (Identity on, `identity.keyEntryRefusals` on). `signInUrl` is
 * `<origin>/signin?product=<slug>`: it never carries the key and names no account. Not an auth
 * failure: a client keeps its state and offers sign-in behind a user action. On
 * `POST /<p>/identity/attach` the same code is nested and carries no `signInUrl`.
 */
export interface LicenseOwnedBody {
  error: "license_owned";
  message?: string;
  signInUrl: string;
}

/** §12.3: `POST /<p>/identity/attach`'s body. `false` previews; `true` attaches. */
export interface AttachRequest {
  confirm: boolean;
}

/**
 * §12.3: `POST /<p>/identity/attach` with `confirm: false`. The device's own licence, as the
 * confirm screen names it; nothing is written.
 */
export interface AttachPreview {
  status: "confirm";
  license: { id: string; tierId: string | null; name: string | null };
}

/**
 * §12.3: `POST /<p>/identity/attach` with `confirm: true`: the activation response (a rotated
 * `token`, `schemaVersion`, `device`, `license`) plus the subject signed in on the device.
 * `attached: "claimed"` when this call put the licence in the account; absent when it was already
 * there. The licence document does not change.
 */
export interface AttachResult {
  token: string;
  schemaVersion: number;
  device: Record<string, unknown>;
  license: Record<string, unknown>;
  /** The pairwise subject ({@link PAIRWISE_SUBJECT_PATTERN}) of the account signed in on the device. */
  subject: string;
  attached?: "claimed";
}

/** §12.3: `GET /<p>/identity/subject`. `null` when no account is signed in on the device. */
export interface SubjectResponse {
  subject: string | null;
}

/**
 * §12.3: `POST /<p>/identity/signout`. `released` is true when the sign-in had bound the device
 * to a licence of the signed-out account, which then deauthorized it: the token stops working.
 */
export interface SignOutResponse {
  released: boolean;
}

/**
 * §12.6: the Identity fragment of `/.well-known/polaris.json` while the product's Identity
 * service is on. `account`, `keyEntryLimit` and the four account endpoints are I-09's; I-08 adds
 * its own beside them. A client uses an endpoint only when it is present and never builds one.
 * With Identity off the fragment is `{enabled: false}` and nothing else.
 */
export interface IdentityDiscovery {
  enabled: true;
  /** True while the platform sign-in (`authorize`, `token`) is served; I-08 makes it always true. */
  configured: boolean;
  /** I-08 (§12.4): the authorization server's issuer, `<origin>/<p>/identity`; also the `iss` of RFC 9207. */
  issuer?: string;
  /** The account features (attach, subject, sign-out, the account portal) are served. */
  account?: true;
  /** The product's effective `identity.keyEntry.limit` (§12.2 rule 5): the value enforced. */
  keyEntryLimit?: number;
  /** I-13 (§12.11.6): present only when the product declares a platform sign-in kind. */
  exchange?: {
    kinds: ExchangeKind[];
    google?: { serverClientId: string };
  };
  /** I-40 (§12.11.5): nearby approval is served. */
  nearby?: true;
  endpoints: {
    session: string;
    sessionLicense: string;
    authStart: string;
    authCallback: string;
    authLogout: string;
    authDeviceStart: string;
    authDeviceEntry: string;
    authDeviceVerify: string;
    authDevicePoll: string;
    /** I-08 (§12.4): the OAuth-shaped authorize page. A client navigates to it and never builds it. */
    authorize?: string;
    /** I-08 (§12.5): the OAuth-shaped token endpoint (form-encoded, CORS for `web.origins`). */
    token?: string;
    /** I-08b (§12.5): the pending sign-in grant's four routes. Present only when the licence choice is served. */
    choiceLicenses?: string;
    choiceDevices?: string;
    choiceComplete?: string;
    choiceCancel?: string;
    /** I-13 (§12.11): the exchange's nonce, the link offer and the nearby approval routes. */
    nonce?: string;
    link?: string;
    nearbyStart?: string;
    nearbyApprove?: string;
    nearbyPoll?: string;
    attach?: string;
    subject?: string;
    signout?: string;
    /** The product's page in the customer portal, `<origin>/#/p/<slug>` (`openAccount()`). */
    accountPortal?: string;
  };
}

// ── I-08: app passthrough on an OAuth-shaped authorize and token (§12.4, §12.5) ─────────────────

/** §12.4: the scopes `authorize` grants. `openid` answers `invalid_scope` until I-21. */
export const AUTHORIZE_SCOPES = ["profile", "email", "cloudSync"] as const;
export type AuthorizeScope = (typeof AUTHORIZE_SCOPES)[number];

/** §12.4: `state` is 16 to 512 characters. */
export const AUTHORIZE_STATE_MIN = 16;
export const AUTHORIZE_STATE_MAX = 512;

/** §12.4: how long an authorization code lives, seconds. Single use. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** §12.4: the `purpose` extension: the card's copy ("sign in" or "add this device's license"). */
export type AuthorizePurpose = "signin" | "attach";

/** §12.4: the `license_choice` extension: who shows the licence choice, the card or the app (I-08b). */
export type AuthorizeLicenseChoice = "card" | "app";

/** §12.4: the parameters of `GET /<p>/identity/authorize`, as a client sends them. */
export interface AuthorizeParams {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope?: string;
  nonce?: string;
  login_hint?: string;
  name_hint?: string;
  purpose?: AuthorizePurpose;
  license_choice?: AuthorizeLicenseChoice;
}

/** §12.4: the errors a 302 back to the app carries in its `error` query. */
export type AuthorizeRedirectError =
  | "invalid_request"
  | "invalid_scope"
  | "access_denied"
  | "server_error";

/**
 * §12.5: a `200` from `POST /<p>/identity/token` (`authorization_code`). The activation response
 * under its OAuth names: `access_token` is the `pkeyt_` device token. Exactly these members; no
 * `expires_in` and no `refresh_token` before I-21.
 */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  /** The granted subset of the requested scope, space-delimited. */
  scope: string;
  schemaVersion: number;
  device: Record<string, unknown>;
  /** `null` on a device with no licence. */
  license: Record<string, unknown> | null;
  /** The pairwise subject ({@link PAIRWISE_SUBJECT_PATTERN}) of the account signed in on the device. */
  subject: string;
  /** I-08b (§12.5.1): the licence's key-entry count after a key entered through `choice/complete`. */
  keyEntries?: { used: number; limit: number };
}

/** §12.5: the flat RFC 6749 §5.2 body, and the Polaris refusals that are flat beside it. */
export interface TokenError {
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "not_entitled"
    | "device_limit"
    | "license_owned"
    | "key_entry_limit"
    | "license_choice_required"
    | "interstitial_required"
    | "rate_limited";
  error_description?: string;
  message?: string;
  retryAfter?: number;
}

/** §12.4: `POST /api/signin/requests/:handle/continue`. */
export interface SignInContinueRequest {
  /** The consent the person gave: the claims granted (a subset of the request's scope). Absent grants all of it. */
  consent?: { claims: string[] };
  /** The licence the device runs on after sign-in. Required when the account holds licences for the product and the card chooses (I-08b: {@link LicenseChoiceInput}; `key` is not accepted here). */
  choice?: LicenseChoiceInput;
  /** The product's terms version the person accepted, when the product requires them. */
  terms?: string;
}

/** §12.4: the answer of Continue and Cancel; the card navigates to `redirect`. */
export interface SignInRedirect {
  redirect: string;
}

// ── I-08b: the licence choice (§12.4.1, §12.5.1; plans/I-04.md §C, §G) ───────────────────────────

/** How a licence reached the account, as the choice rows word it. */
export type LicenseChoiceOrigin =
  | "purchase"
  | "store"
  | "key"
  | "free"
  | "developer"
  | "signin";

/** One licence row of {@link LicenseChoiceView}. Display data: it authorises nothing. */
export interface LicenseChoice {
  id: string;
  tierName: string;
  name: string | null;
  origin: LicenseChoiceOrigin;
  /** `account` for a licence issued by signing in (no key); never a displayed type. */
  access: "seats" | "account";
  seats: { used: number; limit: number | null };
  /** The licence this device runs on ("On this device"). */
  current: boolean;
  /** Epoch seconds; `null` is perpetual. */
  expiresAt: number | null;
  state: "free" | "full" | "blocked";
  blockedReason?: "fingerprint_required";
  /** On a full row: whether Replace is offered. `null` on a row that is not full. */
  replace: { allowed: boolean; retryAfter: number | null } | null;
  /** The portal's focused flow, on the card only; `null` in app mode. */
  freeDeviceUrl: string | null;
}

/** `GET /api/signin/requests/:handle/licenses` and `POST /<p>/identity/choice/licenses`. */
export interface LicenseChoiceView {
  state: "choose" | "autoIssue" | "none";
  choices: LicenseChoice[];
  /** True only when the device runs on a usable licence that is not in `choices`. */
  keep: boolean;
  /** A licence id, `"keep"`, `"create"`, or `null`. */
  preselected: string | null;
  /** The explicit "Create a new license" row: offered only when every candidate is full. */
  create: { tierName: string; access: "account" } | null;
  /** The no-licence state: where to add a key or get one. */
  getLicense: {
    activateUrl: string;
    purchaseUrl: string | null;
    keyEntry: boolean;
  } | null;
}

/** `GET …/licenses/:licenseId/devices` and `POST /<p>/identity/choice/devices`. */
export interface ReplaceView {
  licenseId: string;
  seats: { used: number; limit: number | null };
  devices: {
    id: string;
    label: string | null;
    platform: string | null;
    deviceType: string | null;
    lastSeen: number;
    leastRecent: boolean;
    activeNow: boolean;
    thisBrowser: boolean;
  }[];
  replace: { allowed: boolean; retryAfter: number | null };
}

/** The person's explicit choice. `key` is accepted by `choice/complete` only (never by Continue). */
export type LicenseChoiceInput =
  | { kind: "license"; licenseId: string; replaceDeviceId?: string }
  | { kind: "keep" }
  | { kind: "create" }
  | { kind: "key"; key: string };

/** §12.5.1: the `200` of `POST /<p>/identity/token` when `license_choice=app` and a choice is due. */
export interface PendingSignIn {
  status: "choose";
  /** `sg_` + 43 base64url characters. Travels in a body, never a URL. */
  grant: string;
  expiresIn: number;
  choices: LicenseChoiceView;
}

/** Lifetime of a pending sign-in grant, seconds (§12.5.1). */
export const CHOICE_GRANT_TTL_SECONDS = 300;
/** View and device reads one grant answers (§12.5.1). */
export const CHOICE_GRANT_READS = 30;
/** `sg_` and 32 random bytes in base64url. */
export const CHOICE_GRANT_PATTERN = "^sg_[A-Za-z0-9_-]{43}$";

/** §12.5.1: the bodies of the four grant routes. */
export interface ChoiceLicensesRequest {
  grant: string;
}
export interface ChoiceDevicesRequest {
  grant: string;
  licenseId: string;
}
export interface ChoiceCompleteRequest {
  grant: string;
  choice: LicenseChoiceInput;
  /** §12.11.3: required on a grant issued with `status: "confirm"`; absent is `400 bad_request`. */
  consent?: { claims: string[] };
  deviceName?: string;
}
export interface ChoiceCancelRequest {
  grant: string;
}

// ── I-13: platform sign-in, the link offer and nearby approval (§12.11) ─────────────────────────

/** §12.11.3: the token-exchange grant (RFC 8693) on `POST /<p>/identity/token`. */
export const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
/** §12.11.3: the `subject_token_type`. */
export const EXCHANGE_SUBJECT_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:id_token";
/** §12.11.3: the `issued_token_type` of an exchange's `TokenResponse`. */
export const EXCHANGE_ISSUED_TOKEN_TYPE = "urn:polaris-key:token-type:device";

/** §12.11.1: what a `pkey-proof/1` signature is for. One proof, one purpose. */
export type DeviceProofPurpose =
  | "keys"
  | "nonce"
  | "exchange"
  | "link"
  | "nearby-start"
  | "nearby-poll"
  | "nearby-approve"
  | "vouch"
  | "restore";

/** §12.11.1: the first line of every proof. */
export const DEVICE_PROOF_VERSION = "pkey-proof/1";

/** §12.11.3: the platform identity providers an exchange accepts. */
export type ExchangeKind = "google" | "apple";

/** §12.11.2: `POST /<p>/identity/nonce`. Raw 32-byte public keys, base64url. */
export interface ExchangeNonceRequest {
  signKey: string;
  agreeKey: string;
}

/** §12.11.2: the answer. `nonce` is 32 random bytes in base64url (43 characters). */
export interface ExchangeNonceResponse {
  nonce: string;
  expiresIn: number;
}

/** Lifetime of an exchange nonce, seconds (§12.11.2). */
export const EXCHANGE_NONCE_TTL_SECONDS = 300;
/** `nonce` is 32 random bytes in base64url (§12.11.2). */
export const EXCHANGE_NONCE_PATTERN = "^[A-Za-z0-9_-]{43}$";

/** §12.11.3: the form parameters of the exchange grant. */
export interface ExchangeTokenParams {
  grant_type: typeof TOKEN_EXCHANGE_GRANT_TYPE;
  /** The product slug. */
  client_id: string;
  subject_token: string;
  subject_token_type: typeof EXCHANGE_SUBJECT_TOKEN_TYPE;
  nonce: string;
  /** The device's signing key, raw 32 bytes in base64url. */
  device_key: string;
  /** A `pkey-proof/1` signature, purpose `exchange` (§12.11.1). */
  proof: string;
  license_choice?: AuthorizeLicenseChoice;
  device_name?: string;
}

/** §12.11.3: a silent exchange's `200`: the §12.5 body plus the RFC 8693 token type. */
export interface ExchangeTokenResponse extends TokenResponse {
  issued_token_type: typeof EXCHANGE_ISSUED_TOKEN_TYPE;
}

/** §12.11.3 rule 1: what the person is asked to consent to, in the app's own form. */
export interface ExchangeConsentView {
  client: {
    appName: string;
    developerName: string | null;
    iconUrl: string | null;
    nameVerified: boolean;
  };
  /** `email` is the token's own address, so the app learns nothing it did not hold. */
  as: { provider: ExchangeKind; email: string | null };
  items: ConsentItem[];
  /** Lowercase hex SHA-256, as {@link AppConsentView.scopeHash}. */
  scopeHash: string;
  firstTime: boolean;
  changed: boolean;
}

/**
 * §12.11.3: a `200` when the link exists but consent for this product does not (or its
 * `scopeHash` changed). The grant is §12.5.1's; `choice/complete` then needs `consent`.
 */
export interface ConfirmSignIn {
  status: "confirm";
  grant: string;
  expiresIn: number;
  consent: ExchangeConsentView;
}

/** §12.11.3 rule 4: why the exchange cannot finish in the app. */
export type InterstitialReason = "no_link" | "terms";

/**
 * §12.11.3: the flat `403` of the exchange. `linkHandle` (`lh_` and 43 base64url characters)
 * and `expiresIn` come with `no_link` only.
 */
export interface InterstitialRequiredBody {
  error: "interstitial_required";
  reason: InterstitialReason;
  url: string;
  linkHandle?: string;
  expiresIn?: number;
}

/** §12.11.3 rule 4: `lh_` and 32 random bytes in base64url. */
export const LINK_HANDLE_PATTERN = "^lh_[A-Za-z0-9_-]{43}$";
/** Lifetime of a link handle, seconds (§12.11.3). */
export const LINK_HANDLE_TTL_SECONDS = 600;

/** §12.11.4: how far a link reaches. `null` is unknown before a token. */
export type LinkReach = "global" | "developer";

/** §12.11.4: `GET /<p>/identity/link`. Empty without a live same-device step-up. */
export interface LinkOfferResponse {
  offer: { kind: ExchangeKind; reach: LinkReach | null }[];
}

/** §12.11.4: `POST /<p>/identity/link`, by handle or by a token of its own. */
export type LinkRequest =
  | { linkHandle: string; proof: string }
  | {
      subjectToken: string;
      nonce: string;
      signKey: string;
      agreeKey: string;
      proof: string;
    };

/** §12.11.4: the `200`. */
export interface LinkResponse {
  linked: { kind: ExchangeKind; reach: LinkReach };
}

/** §12.11.5: `POST /<p>/identity/nearby/start`, from the new device D. */
export interface NearbyStartRequest {
  signKey: string;
  agreeKey: string;
  deviceName?: string;
  /** Purpose `nearby-start`. */
  proof: string;
}

/** §12.11.5: the `201`. `request` is `nr_` and 22 base64url characters. */
export interface NearbyStartResponse {
  request: string;
  expiresIn: number;
  interval: number;
}

/** §12.11.5: `nr_` and 22 base64url characters. */
export const NEARBY_REQUEST_PATTERN = "^nr_[A-Za-z0-9_-]{22}$";
/** Lifetime of a nearby request, seconds (§12.11.5). */
export const NEARBY_REQUEST_TTL_SECONDS = 300;
/** The poll interval `start` answers and `poll` enforces, seconds (§12.11.5). */
export const NEARBY_POLL_INTERVAL_SECONDS = 3;

/** §12.11.5 rule 4: what M may choose on `approve`; no Replace, no `keep`, no `key`. */
export type NearbyChoiceInput =
  | { kind: "license"; licenseId: string }
  | { kind: "create" };

/** §12.11.5: `POST /<p>/identity/nearby/approve`, from the signed-in device M. */
export interface NearbyApproveRequest {
  request: string;
  signKey: string;
  agreeKey: string;
  decision: "approve" | "deny";
  /** `license` or `create` only; any other kind or member is `400 bad_request`. */
  choice?: NearbyChoiceInput;
  /** Purpose `nearby-approve`. */
  proof: string;
}

/** §12.11.5: the `200` of `approve`; a deny is `204` with no body. */
export type NearbyApproveResponse =
  | { status: "approved"; deviceLabel: string | null }
  | { status: "choose"; choices: LicenseChoiceView };

/** §12.11.5: `POST /<p>/identity/nearby/poll`, from D. */
export interface NearbyPollRequest {
  request: string;
  /** Purpose `nearby-poll`. */
  proof: string;
}

/**
 * §12.11.5: the poll's answers; the token itself is a {@link TokenResponse} and is answered once.
 * `DevicePollSlowDown` is the `429`; `DevicePollUnavailable` is the `503` (with `Retry-After`), and the
 * request is kept.
 */
export type NearbyPollResponse =
  | { status: "pending" }
  | { status: "timeout" }
  | { status: "error"; reason: typeof DEVICE_POLL_DENIED }
  | TokenResponse
  | DevicePollSlowDown
  | DevicePollUnavailable;
