import type {
  PortalEntitlement,
  PortalLicenseSeats,
  PortalPresentation,
  PortalStatus,
} from "./library.js";
import { call, download, enc } from "./transport.js";

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
  /** `entry`: an open product's library entry (PS-04), with no licences. */
  kind?: "license" | "entry";
  /** The person's product-specific support code, created only on their request. */
  supportCode?: string | null;
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
  /** The download page's install sources (Homebrew, Scoop, AltStore, F-Droid, Obtainium…),
   *  shown under each platform so an owner sees every channel (P0-48). An older Worker omits it. */
  installSources?: PortalInstallSource[];
}

/**
 * One install source (P0-48): a store link's shape, where `deepLink` is the app's own link (the
 * one to open) and `url` the source or repository URL to paste by hand (a browser shows JSON or a
 * 404 there, so it is never the link).
 */
export interface PortalInstallSource extends PortalStoreLink {
  /** F-Droid only: the repository's signing-certificate SHA-256, else `null`. */
  fingerprint: string | null;
  /** A QR code of the deep link as a `data:image/svg+xml` URI, for a phone to scan; or `null`. */
  qr: string | null;
}

// ── Package access (F-21; PORTAL.md §4.20, §4.21, G13) ───────────────────────────────────

/** One private (non-public) feed a licensee may mint a token for. */
export interface PortalPackageFeed {
  ecosystem: string;
  accessMode: string;
  /** The feed's base URL on the registry host, when Distribution knows it. */
  baseUrl: string | null;
  /** The feed's namespace settings (npm's `scope`), which the setup snippets name. */
  namespace?: Record<string, unknown>;
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

/** One personal token (`pkeyp_`) as Account → Packages lists it: never the plaintext or the hash. */
export interface PortalPersonalToken {
  id: string;
  label: string;
  /** The plaintext's last four characters. */
  hint: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: "active" | "expired" | "revoked";
}

/** A private feed one of the account's licences reaches. */
export interface PortalReadableFeed extends PortalPackageFeed {
  product: string;
  productName: string;
  /** A usable licence of the account in this product (the Godot URL token binds to it). */
  licenseId: string;
}

/** A licence-bound `pkeyr_` token of this account: made before personal tokens, or a Godot URL. */
export interface PortalLegacyToken {
  product: string;
  productName: string;
  licenseId: string;
  tokenId: string;
  label: string;
  hint: string;
  ecosystems: string[] | null;
  presentation: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: "active" | "expired" | "revoked";
}

/** `GET /api/me/tokens`: Account → Packages. */
export interface PortalPersonalTokens {
  registryOrigin: string | null;
  username: string;
  tokens: PortalPersonalToken[];
  feeds: PortalReadableFeed[];
  legacy: PortalLegacyToken[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    labelMax: number;
    perAccount: number;
  };
}

export interface PortalMintTokenInput {
  label: string;
  ecosystem?: string | null;
  presentation?: "header" | "url";
  expiresInDays?: number;
}

export const productApi = {
  product: (product: string) =>
    call<PortalProduct>(`/api/products/${enc(product)}`),

  createSupportCode: (product: string) =>
    call<{ supportCode: string }>(
      `/api/products/${enc(product)}/support-code`,
      { method: "POST" },
    ),

  exportProductData: (product: string) =>
    download(
      `/api/products/${enc(product)}/export`,
      `polaris-key-${product}-data.json`,
    ),

  removeProductData: (product: string, alsoRemoveLicense: boolean) =>
    call<{ ok: true; product: string; detachedLicenses: string[] }>(
      `/api/products/${enc(product)}/data${
        alsoRemoveLicense ? "?alsoRemoveLicense=1" : ""
      }`,
      { method: "DELETE" },
    ),

  exportAccountData: () =>
    download("/api/me/export", "polaris-key-account-data.json"),

  downloads: (product: string) =>
    call<PortalDownloads>(`/api/products/${enc(product)}/downloads`),

  packageAccess: (product: string, id: string) =>
    call<PortalPackageAccess>(
      `/api/licenses/${enc(product)}/${enc(id)}/registry-tokens`,
    ),

  personalTokens: () => call<PortalPersonalTokens>("/api/me/tokens"),

  mintPersonalToken: (input: { label: string; expiresInDays?: number }) =>
    call<{ ok: true; token: string; view: PortalPersonalToken }>(
      "/api/me/tokens",
      { method: "POST", body: JSON.stringify(input) },
    ),

  revokePersonalToken: (tokenId: string) =>
    call<{ ok: true; view: PortalPersonalToken }>(
      `/api/me/tokens/${enc(tokenId)}`,
      { method: "DELETE" },
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
