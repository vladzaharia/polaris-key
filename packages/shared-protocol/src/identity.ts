// @polaris-key/protocol/identity — Identity on the wire. Types and constants only, no runtime,
// no crypto. Created by PX-W17 (plans/PX-W17.md §2); PX-W13 adds §12.7, passthrough request
// metadata (plans/PX-W13.md §2); I-08 and I-09 add their sections beside it (I-09: the account
// contract, the pairwise-subject pattern, the claim refusals).
//
// Identity is a per-product service: one Polaris Key account per person, platform-wide, and a
// product's `identity` toggle gates only sign-in THROUGH that product. With it off, device and
// JSON routes under `/<p>/identity/*` answer `not_found` and `POST /<p>/devices/register`
// keeps its single `registration_closed` body; only a person sees `identity_disabled`
// (WIRE-CONTRACT-V4 §12.8).
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
