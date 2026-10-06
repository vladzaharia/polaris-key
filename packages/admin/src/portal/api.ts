import { returnUrl } from "./carriedKey.js";

export interface PortalAccount {
  id: string;
  name: string;
  email: string;
}

export interface PortalMe {
  account: PortalAccount;
  csrf: string;
}

/** The sign-in providers the login card can show (PORTAL.md §4.1), in display order. */
export type PortalProvider = "apple" | "google" | "steam";

export interface PortalCapabilities {
  auth: {
    oidc: boolean;
    magic: boolean;
    /**
     * The single sign-on provider's display name. Not sent by today's Worker (G11): the card
     * falls back to "Continue with single sign-on".
     */
    oidcName?: string;
    /**
     * Apple, Google and Steam for this context (G11, S-16). Not sent by today's Worker: the
     * provider row renders only when the list is present and non-empty.
     */
    providers?: PortalProvider[];
  };
  /**
   * The product named by `?product=`, for the login card's context header (G1/G28). Not sent by
   * today's Worker: without it the card shows no header rather than a slug.
   */
  product?: { slug: string; name: string; developerName?: string | null };
  modules: {
    licensing: boolean;
    claim: boolean;
    releases: boolean;
  };
}

export interface PortalEntitlement {
  key: string;
  label: string;
  value: unknown;
}

export interface PortalLicenseSummary {
  id: string;
  product: string;
  productName: string;
  productBranding?: unknown;
  name: string;
  email: string;
  status: "active" | "disabled" | string;
  tier: string | null;
  activatedAt: number;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
  identityProvider: "manual" | "oidc" | string;
  usable: boolean;
  keyCount: number;
  activeKeyCount: number;
  deviceCount: number;
  entitlements: PortalEntitlement[];
}

export interface PortalKey {
  hash: string;
  /**
   * The key's last 4 characters (PORTAL.md §4.17 masked display). Not stored by today's Worker
   * (G7, PX-W5): without it the mask is `pkey_<slug>_…`.
   */
  last4?: string;
  status: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PortalDevice {
  deviceId: string;
  status: string;
  firstSeen: number;
  lastSeen: number;
  label: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
  ua: string | null;
}

export interface PortalLicenseDetail extends PortalLicenseSummary {
  keys: PortalKey[];
  devices: PortalDevice[];
}

export interface PortalArtifact {
  artifactId: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  /** Distribution's delivery access for the release's deliverable (P2b-04). */
  access: "public" | "authenticated" | "licensed" | "entitled" | string;
  canDownload: boolean;
  /** Why not, when the per-product downloads view (PX-W2) said; `/api/releases` never does. */
  reason?: PortalFileReason | null;
}

export interface PortalRelease {
  product: string;
  productName: string;
  releaseId: string;
  version: string;
  title: string | null;
  notes: string | null;
  publishedAt: number | null;
  sourceUrl: string | null;
  artifacts: PortalArtifact[];
}

// ── Library and product views (PX-W1; docs/design/PORTAL.md G1, G5, G16) ──────────────────

/** A product's status from its best licence (§5.3, the statuses the Worker decides today). */
export type PortalStatus =
  | "suspended"
  | "expired"
  | "device_limit"
  | "expires_soon"
  | "active";

/** A product's presentation; art is always a same-origin `/media/…` URL or null. */
export interface PortalPresentation {
  name: string;
  developerName: string | null;
  tintColor: string | null;
  website: string | null;
  iconUrl: string | null;
  headerUrl: string | null;
  support: { url: string | null; email: string | null } | null;
}

/** One licence with its seats (G5). */
export interface PortalLicenseSeats {
  id: string;
  tier: string | null;
  status: PortalStatus;
  licenseStatus: string;
  activatedAt: number | null;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  deviceLimit: number;
  activeSeatCount: number;
  deviceCount: number;
  dormantCount: number;
}

/** `GET /api/library`: one item per product, plus the Discover count once the Worker lists offers. */
export interface PortalLibrary {
  products: PortalLibraryItem[];
  /**
   * How many products this account could add from Discover (G24). Absent until the Worker can
   * list offers (PX-W10): Discover then stays out of the nav, as the spec's fallback says.
   */
  discoverCount?: number;
}

export interface PortalLibraryItem extends PortalPresentation {
  product: string;
  status: PortalStatus;
  license: PortalLicenseSeats;
  licenseCount: number;
  addedAt: number | null;
}

export interface PortalProductDevice {
  deviceId: string;
  label: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  /** Past the dormancy window: holds no seat. */
  dormant: boolean;
}

export interface PortalProduct extends PortalPresentation {
  product: string;
  /** Each service's own toggle (e.g. `identity`); a section shows only for a service that is on. */
  services: Record<string, boolean>;
  status: PortalStatus;
  addedAt: number | null;
  /**
   * Where the focused flows may return to (PX-10): the product's declared origins and app
   * schemes. Absent on an older Worker, which means no return is followed.
   */
  returnTo?: { origins: string[]; schemes: string[] };
  /** Best first. */
  licenses: Array<
    PortalLicenseSeats & {
      entitlements: PortalEntitlement[];
      devices: PortalProductDevice[];
      /**
       * Where the licence came from (PX-W6, G8): `source` `store` with the store of the earliest
       * active purchase, else `developer`, `sign_in` or `free`. Null with License off; absent on
       * an older Worker. The portal reads only the store name (never order ids).
       */
      purchase?: { source: string; store: string | null } | null;
    }
  >;
}

// ── Downloads and store links (PX-W2; G2, G4) ──────────────────────────────────────────────

/** Why a file can't be downloaded by this account (the Worker's codes, never copy). */
export type PortalFileReason =
  | "license_inactive"
  | "not_entitled"
  | "not_hosted";

/** One file of a release, marked for this account by the token mint's own predicates. */
export interface PortalDownloadFile {
  releaseId: string;
  artifactId: string;
  version: string;
  name: string;
  buildId: string | null;
  platform: string | null;
  arch: string | null;
  format: string | null;
  role: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  minOs: string | null;
  canDownload: boolean;
  reason: PortalFileReason | null;
}

export interface PortalRecommendation {
  platform: string;
  label: string;
  releaseId: string;
  version: string;
  /** `files[0]` runs on every arch of the platform. */
  universal: boolean;
  /** `false`: an older covered release (an update window that ended, §5.4). */
  latest: boolean;
  files: PortalDownloadFile[];
}

export interface PortalStoreLink {
  id: string;
  kind: string;
  outletId: string;
  platforms: string[];
  label: string;
  url: string | null;
  deepLink: string | null;
  command: string | null;
  activateUrl: string | null;
  live: boolean;
  version: string | null;
}

export interface PortalDownloads {
  product: { slug: string; name: string };
  channel: string;
  /** `false`: no downloads here (every list is then empty). */
  available: boolean;
  access: string | null;
  detected: {
    platform: string | null;
    arch: string | null;
    touchAmbiguous: boolean;
  };
  latest: {
    releaseId: string;
    version: string;
    title: string | null;
    publishedAt: number | null;
  } | null;
  recommended: PortalRecommendation | null;
  platforms: Array<{
    platform: string;
    label: string;
    recommended: PortalRecommendation | null;
    files: PortalDownloadFile[];
  }>;
  extras: PortalDownloadFile[];
  stores: PortalStoreLink[];
}

// ── Package access (F-21; PORTAL.md §4.20, §4.21, G13) ───────────────────────────────────

/** One private (non-public) feed a licensee may mint a token for. */
export interface PortalPackageFeed {
  ecosystem: string;
  accessMode: string;
  /** The feed's base URL on the registry host, when Distribution knows it. */
  baseUrl: string | null;
}

/** One token as the portal lists it: never the plaintext or the hash. */
export interface PortalRegistryToken {
  tokenId: string;
  label: string;
  /** The plaintext's last four characters. */
  hint: string;
  scopes: string[];
  /** `null` = every feed of the product. */
  ecosystems: string[] | null;
  presentation: "header" | "url";
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: "active" | "expired" | "revoked";
}

/** `GET /api/licenses/<p>/<id>/registry-tokens`: the Package access card's state. */
export interface PortalPackageAccess {
  /** An enabled, non-public feed exists: only then is the card shown. */
  available: boolean;
  licenseUsable: boolean;
  registryOrigin: string | null;
  username: string;
  feeds: PortalPackageFeed[];
  tokens: PortalRegistryToken[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    urlDefaultDays: number;
    perLicense: number;
  };
}

export interface PortalMintTokenInput {
  label: string;
  ecosystem?: string | null;
  presentation?: "header" | "url";
  expiresInDays?: number;
}

// ── Activate preview (PX-W5; G22) ──────────────────────────────────────────────────────────

export type PortalPreviewVerdict =
  | "addable"
  | "already_yours"
  | "license_owned"
  | "email_mismatch"
  | "portal_off"
  | "unknown";

/** What adding a key would do, before it is added (one evaluator with the claim). */
export interface PortalKeyPreview {
  verdict: PortalPreviewVerdict;
  product: {
    slug: string;
    name: string;
    developerName: string | null;
    iconUrl: string | null;
    headerUrl: string | null;
  } | null;
  license?: {
    id?: string;
    tier: string | null;
    tierLabel: string | null;
    status: string;
    usable: boolean;
    expiresAt: number | null;
    deviceLimit: number | null;
  };
  platforms?: string[];
  /** `email_mismatch` only: `m•••@proton.me`. */
  maskedEmail?: string;
}

// ── Discover (PX-W10; G24, G25) ─────────────────────────────────────────────────────────────

/**
 * Why the account can add a product (owner decision Q-6: always shown). An open set: today
 * `free_with_account` or `group:<group>`; later policies add their own codes, which the page
 * words generically until it knows them.
 */
export type PortalDiscoverReason = string;

/** What adding the product would give the account, from the same policy as the claim. */
export interface PortalDiscoverTerms {
  tier: string | null;
  tierLabel: string | null;
  deviceLimit: number;
  /** The expiry a licence minted now would carry; `null` = never expires. */
  expiresAt: number | null;
  /** The tier's policy length in days (`null` = lifetime). */
  expiryDays: number | null;
}

/** One offer of `GET /api/discover`. */
export interface PortalDiscoverOffer extends PortalPresentation {
  product: string;
  platforms: string[];
  offer: PortalDiscoverTerms;
  reason: PortalDiscoverReason;
}

/** `POST /api/discover/<p>/claim`: the licence, new (`added`) or already held. */
export interface PortalDiscoverClaim {
  added: boolean;
  product: string;
  license: {
    id: string;
    tier: string | null;
    tierLabel: string | null;
    status: string;
    usable: boolean;
    expiresAt: number | null;
    deviceLimit: number;
  };
}

/**
 * The email start's and the resend's one answer (I-07, PX-W4), the same whether or not mail went
 * out. The numbers are optional so an older Worker's bare `{ ok: true }` still reads.
 */
export interface PortalEmailSent {
  ok: true;
  /** Seconds the code and the link work. */
  expiresIn?: number;
  codeLength?: number;
  /** Seconds before "Send a new code" is accepted (the card's countdown). */
  resendIn?: number;
}

export class PortalApiError extends Error {
  /** A refusal's numeric extras the card shows (`triesLeft` on a wrong sign-in code). */
  triesLeft?: number;
  /** Seconds to wait before asking again (a resend asked too soon, PX-W4). */
  retryAfter?: number;
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`portal api ${status}`);
    this.name = "PortalApiError";
  }
}

const CSRF_HEADER = "X-PKey-Portal-CSRF";
let csrf = "";

export function setPortalCsrf(token: string): void {
  csrf = token;
}

/** This tab started an email sign-in that has not finished yet (I-07). */
let signInPending = false;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const mutating = init.method != null && init.method !== "GET";
  if (mutating) {
    headers.set(CSRF_HEADER, csrf);
    if (init.body) headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch {
    // Offline, DNS, a dropped connection: "Can't reach Polaris Key", never "signed out".
    throw new PortalApiError(0, "network");
  }
  if (!res.ok) {
    let code: string | undefined;
    let message: string | undefined;
    let triesLeft: number | undefined;
    let retryAfter: number | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        triesLeft?: unknown;
        retryAfter?: unknown;
      };
      code = body.error;
      message = body.message;
      if (typeof body.triesLeft === "number") triesLeft = body.triesLeft;
      if (typeof body.retryAfter === "number") retryAfter = body.retryAfter;
    } catch {
      // non-JSON response
    }
    const error = new PortalApiError(res.status, code);
    if (message) error.message = message;
    if (triesLeft !== undefined) error.triesLeft = triesLeft;
    if (retryAfter !== undefined) error.retryAfter = retryAfter;
    throw error;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const portalApi = {
  capabilities: (product?: string | null) =>
    call<PortalCapabilities>(
      product
        ? `/api/capabilities?product=${enc(product)}`
        : "/api/capabilities",
    ),
  me: () => call<PortalMe>("/api/me"),
  deleteMe: () =>
    call<{ ok: true; deleted: string }>("/api/me", { method: "DELETE" }),
  licenses: () => call<{ licenses: PortalLicenseSummary[] }>("/api/licenses"),
  license: (product: string, id: string) =>
    call<PortalLicenseDetail>(`/api/licenses/${enc(product)}/${enc(id)}`),
  /**
   * I-07's identifier-first email start: one email with a 6-digit code and a sign-in link
   * (SIGN-IN.md §3.4). `/api/magic/start` is the older alias of the same route.
   */
  startEmailSignIn: async (email: string) => {
    const out = await call<PortalEmailSent>("/api/signin/email/start", {
      method: "POST",
      // Never the carried license key (carriedKey.ts).
      body: JSON.stringify({ email, returnTo: returnUrl() }),
    });
    signInPending = true;
    return out;
  },
  /**
   * PX-W4: "Send a new code" for this tab's email sign-in. The Worker mails the same address
   * (and keeps where the sign-in was headed), asks for no new security check, and retires the
   * previous code and link; starting again would need a fresh Turnstile token and leave the old
   * link alive.
   */
  resendSignInCode: async () => {
    const out = await call<PortalEmailSent>("/api/signin/email/resend", {
      method: "POST",
    });
    signInPending = true;
    return out;
  },
  /** Redeems the emailed code for this browser's sign-in (the Worker sets the session cookie). */
  verifySignInCode: async (code: string) => {
    const out = await call<{ status: string; next?: string }>(
      "/api/signin/email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    );
    signInPending = false;
    return out;
  },
  /**
   * I-07: a sign-in link opened on another device only confirms THIS tab's sign-in; this tab
   * finishes it here (the Worker sets the session cookie). Asked only after this tab started
   * an email sign-in.
   */
  finishPendingSignIn: async (): Promise<boolean> => {
    if (!signInPending) return false;
    try {
      const out = await call<{ status: string }>("/api/signin/flow", {
        method: "POST",
      });
      if (out.status !== "pending") signInPending = false;
      return out.status === "signed_in";
    } catch {
      return false;
    }
  },
  claimKey: (key: string) =>
    call<{ ok: true; license: PortalLicenseSummary | null }>(
      "/api/claim/license-key",
      {
        method: "POST",
        body: JSON.stringify({ key }),
      },
    ),
  disconnectDevice: (product: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `/api/licenses/${enc(product)}/${enc(id)}/devices/${enc(deviceId)}`,
      { method: "DELETE" },
    ),
  library: () => call<PortalLibrary>("/api/library"),
  discover: () => call<{ offers: PortalDiscoverOffer[] }>("/api/discover"),
  /** "Add to library" (G25): mints through the auto-issue path; idempotent per product. */
  claimDiscover: (product: string) =>
    call<PortalDiscoverClaim>(`/api/discover/${enc(product)}/claim`, {
      method: "POST",
    }),
  product: (product: string) =>
    call<PortalProduct>(`/api/products/${enc(product)}`),
  downloads: (product: string) =>
    call<PortalDownloads>(`/api/products/${enc(product)}/downloads`),
  previewKey: (key: string) =>
    call<PortalKeyPreview>("/api/activate/preview", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  releases: () => call<{ releases: PortalRelease[] }>("/api/releases"),
  packageAccess: (product: string, id: string) =>
    call<PortalPackageAccess>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens`,
    ),
  mintRegistryToken: (
    product: string,
    id: string,
    input: PortalMintTokenInput,
  ) =>
    call<{ ok: true; token: string; view: PortalRegistryToken }>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeRegistryToken: (product: string, id: string, tokenId: string) =>
    call<{ ok: true; view: PortalRegistryToken }>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    ),
  /** G23: email the account's own address a link to this product's download for `platform`. */
  emailDownload: (product: string, platform: string) =>
    call<{ ok: true }>(`/api/products/${enc(product)}/email-download`, {
      method: "POST",
      body: JSON.stringify({ platform }),
    }),
  downloadToken: (product: string, releaseId: string, artifactId: string) =>
    call<{ url: string }>(
      `/api/releases/${enc(product)}/${enc(releaseId)}/artifacts/${enc(artifactId)}/token`,
      { method: "POST" },
    ),
};
