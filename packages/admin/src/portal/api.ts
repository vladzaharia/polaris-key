export interface PortalAccount {
  id: string;
  name: string;
  email: string;
}

export interface PortalMe {
  account: PortalAccount;
  csrf: string;
}

export interface PortalCapabilities {
  auth: {
    oidc: boolean;
    magic: boolean;
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
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
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
  capabilities: () => call<PortalCapabilities>("/api/capabilities"),
  me: () => call<PortalMe>("/api/me"),
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
