/**
 * Same-origin client for the `/admin/api/*` surface (packages/worker/src/admin/api.ts is
 * the source of truth for these shapes). Auth is the HttpOnly session cookie (sent
 * automatically); every state-changing call must echo the per-session CSRF token in the
 * `X-PKey-CSRF` header or the server rejects it. A 401 means the session lapsed -> bounce
 * to the login redirect so the operator re-authenticates.
 *
 * Secrets NEVER cross the wire as values: a managed *secret* is delivered as
 * `{ state, configured }` only — mirrored in the types so the UI can't render one.
 */

export type ConfigKind = "config" | "secret" | "flag";
export type ManagementState = "unmanaged" | "managed" | "hidden";

export interface ConfigEntry {
  key: string;
  kind: ConfigKind;
  category: string;
  label: string;
  description: string;
  schema: Record<string, unknown>;
  examples?: unknown[];
  default?: unknown;
  secret?: boolean;
  managementDefault?: ManagementState;
  userGrant?: boolean;
  grantLabel?: string;
  ui?: { widget?: string; help?: string; placeholder?: string; order?: number; advanced?: boolean };
  accessor?: string;
}

export interface ProductCatalog {
  schemaVersion: number;
  entries: ConfigEntry[];
}

export interface ProductRef {
  slug: string;
  name: string;
  schemaVersion: number;
}

export interface Me {
  sub: string;
  name: string;
  email: string;
  csrf: string;
  platformAdmin: boolean;
  products: ProductRef[];
}

export interface ProductDetail {
  slug: string;
  name: string;
  signingKid: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultMachineLimit: number;
  adminGroup: string | null;
  createdAt: number;
  modifiedAt: number;
}

export type LicenseStatus = "active" | "disabled";
export type KeyStatus = "active" | "revoked";

export interface LicenseSummary {
  id: string;
  name: string;
  email: string;
  status: LicenseStatus;
  enrolledAt: number;
  expiresAt: number | null;
  keyCount: number;
  activeKeyCount: number;
  machineCount: number;
  profile: string | null;
  tier: string | null;
  identityProvider: "manual" | "oidc";
  oidcSubject?: string;
  modifiedBy?: string;
  modifiedAt?: number;
}

export interface KeyDto {
  hash: string;
  status: KeyStatus;
  label?: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt?: number;
}

export interface MachineDto {
  machineId: string;
  status: string;
  firstSeen: number;
  lastSeen: number;
  ua?: string;
  label?: string;
  reported?: unknown;
}

export interface ManagedValueView {
  state: ManagementState;
  value?: unknown;
}
export interface ManagedSecretView {
  state: ManagementState;
  configured: boolean;
}
export interface RedactedPayload {
  config: Record<string, ManagedValueView>;
  secrets: Record<string, ManagedSecretView>;
  entitlements: Record<string, ManagedValueView>;
}

export interface LicenseDetail extends LicenseSummary {
  groups?: string[];
  maxOfflineDays?: number | null;
  overrides: RedactedPayload;
  keys: KeyDto[];
  machines: MachineDto[];
}

export interface ProfileSummary {
  id: string;
  name: string;
  description?: string;
  modifiedBy?: string;
  modifiedAt?: number;
}
export interface ProfileDetail extends ProfileSummary {
  payload: RedactedPayload;
}

export interface TierSummary {
  id: string;
  label: string;
  profile: string | null;
  policyExpiryDays: number | null;
  policyMachineLimit: number | null;
}

export interface ActivityItem {
  id: string;
  at: number;
  actor: { sub: string; name: string; email: string };
  action: string;
  target: { kind: string; id: string } | null;
  summary: string;
}
export interface ActivityCursor {
  beforeAt: number;
  beforeId: string;
}

export interface OverrideUpdate {
  key: string;
  state?: ManagementState;
  value?: unknown;
}

// ── transport ────────────────────────────────────────────────────────────────
let csrf = "";
export function setCsrf(token: string): void {
  csrf = token;
}

let redirectToLogin = (): void => {
  window.location.href = "/admin/login";
};
export function setLoginRedirectForTests(fn?: () => void): void {
  redirectToLogin =
    fn ??
    (() => {
      window.location.href = "/admin/login";
    });
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly fields?: string[],
    public readonly code?: string,
  ) {
    super(`api ${status}`);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const mutating = init.method && init.method !== "GET";
  if (mutating) {
    headers.set("X-PKey-CSRF", csrf);
    if (init.body) headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401);
  }
  if (!res.ok) {
    let fields: string[] | undefined;
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string; fields?: string[] };
      fields = body.fields;
      code = body.error;
      message = body.message;
    } catch {
      // non-JSON error body
    }
    const error = new ApiError(res.status, fields, code);
    if (message) error.message = message;
    throw error;
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
/** Build a per-product API base. */
const p = (slug: string): string => `/admin/api/products/${enc(slug)}`;

export const api = {
  me: () => call<Me>("/admin/api/me"),
  logout: () => call<{ ok: true }>("/admin/api/logout", { method: "POST" }),

  // Platform: products
  products: () => call<{ products: ProductDetail[] }>("/admin/api/products"),
  createProduct: (body: { slug: string; name?: string; adminGroup?: string }) =>
    call<{ ok: true; product: ProductDetail; signingKeySecret: string }>("/admin/api/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchProduct: (slug: string, body: Partial<{ name: string; compatMin: string; compatMax: string; defaultMachineLimit: number; defaultMaxOfflineDays: number; adminGroup: string }>) =>
    call<{ ok: true }>(`${p(slug)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProduct: (slug: string) => call<{ ok: true }>(`${p(slug)}`, { method: "DELETE" }),

  // Per-product: schema
  schema: (slug: string) => call<ProductCatalog>(`${p(slug)}/schema`),
  publishSchema: (slug: string, catalog: ProductCatalog) =>
    call<{ ok: true; schemaVersion: number }>(`${p(slug)}/schema`, {
      method: "PUT",
      body: JSON.stringify({ catalog }),
    }),

  // Per-product: licenses
  licenses: (slug: string) => call<{ licenses: LicenseSummary[] }>(`${p(slug)}/licenses`),
  license: (slug: string, id: string) => call<LicenseDetail>(`${p(slug)}/licenses/${enc(id)}`),
  createLicense: (slug: string, body: { name: string; email: string; expiresAt?: number; profile?: string }) =>
    call<{ licenseId: string; key: string; license: LicenseSummary }>(`${p(slug)}/licenses`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchLicense: (slug: string, id: string, body: Partial<{ name: string; email: string; expiresAt: number | null; maxOfflineDays: number }>) =>
    call<{ ok: true; id: string }>(`${p(slug)}/licenses/${enc(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  setLicenseEnabled: (slug: string, id: string, enabled: boolean) =>
    call<{ ok: true; id: string; status: LicenseStatus }>(`${p(slug)}/licenses/${enc(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
  setLicenseOverrides: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/licenses/${enc(id)}/overrides`, { method: "PUT", body: JSON.stringify({ updates }) }),

  // Keys
  mintKey: (slug: string, id: string, label?: string) =>
    call<{ key: string; hash: string; record: KeyDto }>(`${p(slug)}/licenses/${enc(id)}/keys`, { method: "POST", body: JSON.stringify({ label }) }),
  revokeKey: (slug: string, id: string, keyHash: string) =>
    call<{ ok: true; hash: string; status: KeyStatus }>(`${p(slug)}/licenses/${enc(id)}/keys/${enc(keyHash)}/revoke`, { method: "POST" }),

  // Machines
  deauthorizeMachine: (slug: string, id: string, machineId: string) =>
    call<{ ok: true; machineId: string }>(`${p(slug)}/licenses/${enc(id)}/machines/${enc(machineId)}`, { method: "DELETE" }),

  // Profiles
  profiles: (slug: string) => call<{ profiles: ProfileSummary[] }>(`${p(slug)}/profiles`),
  profile: (slug: string, id: string) => call<ProfileDetail>(`${p(slug)}/profiles/${enc(id)}`),
  createProfile: (slug: string, body: { id?: string; name?: string; description?: string }) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles`, { method: "POST", body: JSON.stringify(body) }),
  setProfileOverrides: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles/${enc(id)}`, { method: "PUT", body: JSON.stringify({ updates }) }),
  deleteProfile: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles/${enc(id)}`, { method: "DELETE" }),

  // Tiers
  tiers: (slug: string) => call<{ tiers: TierSummary[] }>(`${p(slug)}/tiers`),
  createTier: (slug: string, body: { id?: string; label?: string; profile?: string; policyExpiryDays?: number; policyMachineLimit?: number }) =>
    call<{ ok: true; id: string }>(`${p(slug)}/tiers`, { method: "POST", body: JSON.stringify(body) }),
  patchTier: (slug: string, id: string, body: Partial<{ label: string; profile: string; policyExpiryDays: number; policyMachineLimit: number }>) =>
    call<{ ok: true; id: string }>(`${p(slug)}/tiers/${enc(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTier: (slug: string, id: string) => call<{ ok: true; id: string }>(`${p(slug)}/tiers/${enc(id)}`, { method: "DELETE" }),

  // Activity (keyset)
  activity: (slug: string, cursor?: ActivityCursor, limit = 50) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      search.set("beforeAt", String(cursor.beforeAt));
      search.set("beforeId", cursor.beforeId);
    }
    return call<{ items: ActivityItem[]; nextCursor: ActivityCursor | null }>(`${p(slug)}/activity?${search.toString()}`);
  },
};
