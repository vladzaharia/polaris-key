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
  configured: boolean;
  /** The account features (attach, subject, sign-out, the account portal) are served. */
  account?: true;
  /** The product's effective `identity.keyEntry.limit` (§12.2 rule 5): the value enforced. */
  keyEntryLimit?: number;
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
    attach?: string;
    subject?: string;
    signout?: string;
    /** The product's page in the customer portal, `<origin>/#/p/<slug>` (`openAccount()`). */
    accountPortal?: string;
  };
}
