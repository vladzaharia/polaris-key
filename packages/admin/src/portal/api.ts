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

export class PortalApiError extends Error {
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
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
      };
      code = body.error;
      message = body.message;
    } catch {
      // non-JSON response
    }
    const error = new PortalApiError(res.status, code);
    if (message) error.message = message;
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
  startMagic: (email: string) =>
    call<{ ok: true }>("/api/magic/start", {
      method: "POST",
      body: JSON.stringify({ email, returnTo: window.location.href }),
    }),
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
  releases: () => call<{ releases: PortalRelease[] }>("/api/releases"),
  downloadToken: (product: string, releaseId: string, artifactId: string) =>
    call<{ url: string }>(
      `/api/releases/${enc(product)}/${enc(releaseId)}/artifacts/${enc(artifactId)}/token`,
      { method: "POST" },
    ),
};
