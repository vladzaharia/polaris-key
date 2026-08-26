/**
 * Same-origin typed client for the `/manage/api/*` surface. The worker
 * (`packages/worker/src/manage/api.ts` + `handlers/*`) is the source of truth for these
 * shapes. Auth is the HttpOnly session cookie (sent automatically); every state-changing
 * call echoes the per-session CSRF token in the `X-PKey-CSRF` header or the server rejects
 * it. A 401 means the session lapsed → bounce to the login redirect to re-authenticate.
 *
 * Secrets are write-only: a managed *secret* comes back as `{ state, configured, updatedAt }`
 * only — its value NEVER crosses the wire, mirrored here so the UI can't render one.
 *
 * Management state is the v2 MDM model: `default` (server value is a default the client may
 * override) | `enforced` (server value wins, read-only) | `hidden` (enforced + withheld from
 * enumeration). Every managed entry carries `updatedAt` (epoch seconds) for change detection.
 */

// ── catalog / config shapes ──────────────────────────────────────────────────
export type ConfigKind = "config" | "secret" | "flag";
export type ManagementState = "default" | "enforced" | "hidden";

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
  ui?: {
    widget?: string;
    help?: string;
    placeholder?: string;
    order?: number;
    advanced?: boolean;
  };
  accessor?: string;
}

export interface ProductCatalog {
  schemaVersion: number;
  entries: ConfigEntry[];
}

// ── identity ──────────────────────────────────────────────────────────────────
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

// ── products (platform registry) ──────────────────────────────────────────────
type ProductReleaseSource = "manual" | "github" | (string & {});

export interface ProductSigningBundle {
  kid?: string;
  alg?: string;
  publicKey?: string;
  publicKeyPem?: string;
  jwksUrl?: string;
  jwks?: unknown;
  trustKeys?: Record<string, string>;
}

export interface ProductModuleSummary {
  id?: string;
  key?: string;
  name?: string;
  label?: string;
  description?: string;
  status?: string;
  configured?: boolean;
  enabled?: boolean;
  required?: boolean;
  provider?: "platform" | "custom" | string | null;
  missing?: string[];
  missingSecrets?: string[];
}

export interface ProductSetupAction {
  id?: string;
  label?: string;
  title?: string;
  description?: string;
  href?: string;
  route?: string;
  status?: string;
}

export interface ProductSetupState {
  status?: string;
  complete?: boolean;
  healthy?: boolean;
  missing?: string[];
  warnings?: string[];
  requiredSecrets?: string[];
  missingSecrets?: string[];
  secrets?: {
    name: string;
    configured: boolean;
    sources?: string[];
  }[];
  modules?:
    | ProductModuleSummary[]
    | Record<string, ProductModuleSummary | boolean | string>;
  sync?: ProductSyncState | null;
  nextActions?: ProductSetupAction[] | string[];
}

export interface ProductSyncState {
  source?: string;
  status?: string;
  lastCheckedAt?: number | null;
  lastSyncedAt?: number | null;
  commitSha?: string | null;
  changedPaths?: string[];
  updated?: string[];
  errors?: string[];
  message?: string | null;
}

export interface PortalProductSettings {
  portalEnabled: boolean;
  oidcEnabled: boolean;
  magicEnabled: boolean;
  licenseKeyClaimEnabled: boolean;
  releasesEnabled: boolean;
  branding?: unknown;
  modifiedAt?: number;
}

type ReleaseHealthStatus =
  | "healthy"
  | "needs-setup"
  | "not-configured"
  | "error";

type ReleaseHealthCheckStatus = "ok" | "missing" | "warning" | "error";

export interface ReleaseHealthCheck {
  id: string;
  label: string;
  status: ReleaseHealthCheckStatus;
  message?: string;
  missing?: string[];
}

export interface ReleaseHealth {
  status: ReleaseHealthStatus;
  healthy: boolean;
  missing: string[];
  checks: ReleaseHealthCheck[];
  release?: {
    tag: string;
    name: string | null;
    prerelease: boolean;
    assetCount: number;
    htmlUrl: string;
  };
}

export interface ProductOnboarding {
  baseUrl?: string;
  configUrl?: string;
  activateUrl?: string;
  jwksUrl?: string;
  docsUrl?: string;
  sdkSnippets?:
    | Record<string, string>
    | { label?: string; language?: string; code?: string }[];
  modules?:
    | ProductModuleSummary[]
    | Record<string, ProductModuleSummary | boolean | string>;
  setup?: ProductSetupState;
  nextActions?: ProductSetupAction[] | string[];
}

export interface ProductDetail {
  slug: string;
  name: string;
  signingKid: string;
  releaseSource?: ProductReleaseSource;
  signing?: ProductSigningBundle | null;
  jwksUrl?: string;
  jwks?: unknown;
  modules?:
    | ProductModuleSummary[]
    | Record<string, ProductModuleSummary | boolean | string>;
  portalSettings?: PortalProductSettings;
  setup?: ProductSetupState;
  onboarding?: ProductOnboarding;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string | null;
  createdAt: number;
  modifiedAt: number;
}

export interface CreateManualProductBody {
  slug: string;
  name?: string;
  schema?: ProductCatalog | string;
  signingKid?: string;
  compatMin?: string;
  compatMax?: string;
  defaultMaxOfflineDays?: number;
  defaultDeviceLimit?: number;
  adminGroup?: string;
}

export type UpdatePortalSettingsBody = Partial<
  Pick<
    PortalProductSettings,
    | "portalEnabled"
    | "oidcEnabled"
    | "magicEnabled"
    | "licenseKeyClaimEnabled"
    | "releasesEnabled"
    | "branding"
  >
>;

export interface CreateManualProductResult {
  ok: true;
  slug: string;
  kid: string;
  signing?: ProductSigningBundle | null;
  setup?: ProductSetupState;
  onboarding?: ProductOnboarding;
  product: ProductDetail | null;
}

export interface LinkRepoResult {
  ok: true;
  slug: string;
  kid: string;
  signing?: ProductSigningBundle | null;
  product?: ProductDetail | null;
  setup?: ProductSetupState;
  onboarding?: ProductOnboarding;
  install?: unknown;
  remainingSecrets?: string[];
}

export interface UpdateProductBody {
  name?: string;
  compatMin?: string;
  compatMax?: string;
  defaultMaxOfflineDays?: number;
  defaultDeviceLimit?: number;
  adminGroup?: string;
}

export interface RotateKeyResult {
  ok: true;
  kid: string;
  publicKey: string;
  status?: "staged" | "active";
  activateAfter?: number;
}

export interface ResyncResult {
  ok: true;
  slug: string;
  updated?: unknown;
}

// ── managed-payload (overrides / profile payloads) ────────────────────────────
/** A managed value: its state, value, and when an admin last changed it (epoch seconds). */
export interface ManagedEntry {
  state: ManagementState;
  value?: unknown;
  updatedAt: number;
}

/** A redacted secret entry — value withheld; only whether one is configured + when. */
export interface ManagedSecretView {
  state: ManagementState;
  configured: boolean;
  updatedAt: number;
}

/** The redacted, over-the-wire payload shape (secrets never carry a value). */
export interface RedactedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedSecretView>;
  entitlements: Record<string, ManagedEntry>;
}

/** A single override/payload key update sent on a PUT batch. */
export interface OverrideUpdate {
  key: string;
  state?: ManagementState;
  value?: unknown;
}

// ── licenses ──────────────────────────────────────────────────────────────────
export type LicenseStatus = "active" | "disabled";
export type KeyStatus = "active" | "revoked";

export interface LicenseSummary {
  id: string;
  name: string;
  email: string;
  status: LicenseStatus;
  activatedAt: number;
  expiresAt: number | null;
  keyCount: number;
  activeKeyCount: number;
  deviceCount: number;
  profile: string | null;
  profiles?: string[];
  tier: string | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
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

/** A device's hardware binding. Digests are truncated server-side — never full values. */
export interface DeviceFingerprintDto {
  status: "verified" | "unverified";
  hwid: string | null;
  components: Record<string, string>;
  componentCount: number;
  firstSeen: number;
  lastSeen: number;
  lastDriftAt?: number;
  lastDriftCount?: number;
}

/** A device's current software snapshot. */
export interface DeviceFactsDto {
  os: { name?: string; version?: string; build?: string; kernel?: string };
  hardware: {
    cpuModel?: string;
    cpuCores?: number;
    ramMb?: number;
    machineModel?: string;
  };
  runtime: { name?: string; version?: string };
  locale?: string;
  timezone?: string;
  probes?: Record<string, { present: boolean; version?: string }>;
  updatedAt: number;
}

export interface DeviceDto {
  deviceId: string;
  status: string;
  firstSeen: number;
  lastSeen: number;
  ua?: string;
  label?: string;
  platform?: string;
  arch?: string;
  appVersion?: string;
  sdkName?: string;
  sdkVersion?: string;
  reported?: unknown;
  fingerprint?: DeviceFingerprintDto | null;
  facts?: DeviceFactsDto | null;
}

export type FingerprintMode = "off" | "lenient" | "normal" | "strict";

export interface FingerprintProbeDto {
  id: string;
  label: string;
  macos?: string;
  windows?: string;
  linux?: string;
}

export interface FingerprintPolicyDto {
  enabled: boolean;
  defaultMode: FingerprintMode;
  probes: FingerprintProbeDto[];
}

export interface FingerprintPolicyResponse {
  policy: FingerprintPolicyDto;
  /** `manifest` means a resync still owns it; `admin` means an operator has taken it over. */
  source: "manifest" | "admin";
}

export interface LicenseDetail extends LicenseSummary {
  groups?: string[];
  maxOfflineDays?: number | null;
  overrides: RedactedPayload;
  keys: KeyDto[];
  devices: DeviceDto[];
}

export interface CreateLicenseBody {
  name: string;
  email: string;
  expiresAt?: number;
  profile?: string;
  profiles?: string[];
  tier?: string;
  maxOfflineDays?: number;
  channels?: string[];
  minVersion?: string;
  maxVersion?: string;
}

export interface PatchLicenseBody {
  name?: string;
  email?: string;
  expiresAt?: number | null;
  maxOfflineDays?: number;
  profile?: string | null;
  profiles?: string[];
  tier?: string | null;
  channels?: string[];
  minVersion?: string | null;
  maxVersion?: string | null;
}

// ── profiles ──────────────────────────────────────────────────────────────────
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

// ── tiers ─────────────────────────────────────────────────────────────────────
export interface TierSummary {
  id: string;
  label: string;
  profile: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

export interface TierBody {
  id?: string;
  label?: string;
  profile?: string;
  policyExpiryDays?: number;
  policyDeviceLimit?: number;
  channels?: string[];
  minVersion?: string | null;
  maxVersion?: string | null;
}

// ── activity ──────────────────────────────────────────────────────────────────
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
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: ActivityCursor | null;
}

// ── transport ─────────────────────────────────────────────────────────────────
const CSRF_HEADER = "X-PKey-CSRF";

let csrf = "";
export function setCsrf(token: string): void {
  csrf = token;
}

let redirectToLogin = (): void => {
  window.location.href = "/manage/login";
};
/** Override the 401 redirect (tests pass a spy; call with no arg to restore the default). */
export function setLoginRedirectForTests(fn?: () => void): void {
  redirectToLogin =
    fn ??
    (() => {
      window.location.href = "/manage/login";
    });
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly fields?: string[],
    public readonly code?: string,
  ) {
    super(`api ${status}`);
    this.name = "ApiError";
  }
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
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401);
  }
  if (!res.ok) {
    let fields: string[] | undefined;
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: string | { code?: string; message?: string; fields?: string[] };
        message?: string;
        fields?: string[];
        code?: string;
      };
      if (typeof body.error === "object" && body.error) {
        fields = body.error.fields ?? body.fields;
        code = body.error.code ?? body.code;
        message = body.error.message ?? body.message;
      } else {
        fields = body.fields;
        code = body.error ?? body.code;
        message = body.message;
      }
    } catch {
      // non-JSON error body
    }
    const error = new ApiError(res.status, fields, code);
    if (message) error.message = message;
    throw error;
  }
  // 204/empty bodies are tolerated (returns undefined cast to T).
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;
/** Build a per-product API base. */
const p = (slug: string): string => `/manage/api/products/${enc(slug)}`;

export const api = {
  // ── identity ────────────────────────────────────────────────────────────────
  me: () => call<Me>("/manage/api/me"),
  logout: () => call<{ ok: true }>("/manage/api/logout", { method: "POST" }),

  // ── products (platform registry) ──────────────────────────────────────────────
  products: () => call<{ products: ProductDetail[] }>("/manage/api/products"),
  product: (slug: string) => call<{ product: ProductDetail }>(p(slug)),
  createManualProduct: (body: CreateManualProductBody) =>
    call<CreateManualProductResult>("/manage/api/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  linkRepo: (repoUrl: string) =>
    call<LinkRepoResult>("/manage/api/products/link-repo", {
      method: "POST",
      body: JSON.stringify({ repoUrl }),
    }),
  updateProduct: (slug: string, body: UpdateProductBody) =>
    call<{ ok: true; slug: string }>(p(slug), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProduct: (slug: string) =>
    call<{ ok: true; slug: string }>(p(slug), {
      method: "DELETE",
      body: JSON.stringify({ confirmSlug: slug }),
    }),
  resyncProduct: (slug: string) =>
    call<ResyncResult>(`${p(slug)}/release/resync`, { method: "POST" }),
  releaseHealth: (slug: string) =>
    call<{ health: ReleaseHealth }>(`${p(slug)}/release/health`),
  portalSettings: (slug: string) =>
    call<{ settings: PortalProductSettings }>(`${p(slug)}/portal`),
  updatePortalSettings: (slug: string, body: UpdatePortalSettingsBody) =>
    call<{ ok: true; settings: PortalProductSettings }>(`${p(slug)}/portal`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  putProductSecret: (slug: string, name: string, value: string) =>
    call<{ ok: true; name: string }>(`${p(slug)}/secrets/${enc(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  rotateProductKey: (slug: string) =>
    call<RotateKeyResult>(`${p(slug)}/keys/rotate`, { method: "POST" }),

  // ── schema / catalog ──────────────────────────────────────────────────────────
  schema: (slug: string) => call<ProductCatalog>(`${p(slug)}/schema`),
  publishSchema: (slug: string, catalog: ProductCatalog) =>
    call<{ ok: true; schemaVersion: number }>(`${p(slug)}/schema`, {
      method: "PUT",
      body: JSON.stringify({ catalog }),
    }),

  // ── licenses ────────────────────────────────────────────────────────────────
  licenses: (slug: string) =>
    call<{ licenses: LicenseSummary[] }>(`${p(slug)}/licenses`),
  license: (slug: string, id: string) =>
    call<LicenseDetail>(`${p(slug)}/licenses/${enc(id)}`),
  createLicense: (slug: string, body: CreateLicenseBody) =>
    call<{ licenseId: string; key: string; license: LicenseSummary }>(
      `${p(slug)}/licenses`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  patchLicense: (slug: string, id: string, body: PatchLicenseBody) =>
    call<{
      ok: true;
      id: string;
      /** Present when a tier change lands below the active device count. Existing devices
       *  are grandfathered; new activations are refused until the count drops. */
      overLimit?: { deviceCount: number; deviceLimit: number };
    }>(`${p(slug)}/licenses/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  setLicenseEnabled: (slug: string, id: string, enabled: boolean) =>
    call<{ ok: true; id: string; status: LicenseStatus }>(
      `${p(slug)}/licenses/${enc(id)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    ),
  putLicenseOverrides: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/licenses/${enc(id)}/overrides`, {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),

  // ── license keys ──────────────────────────────────────────────────────────────
  licenseKeys: (slug: string, id: string) =>
    call<{ keys: KeyDto[] }>(`${p(slug)}/licenses/${enc(id)}/keys`),
  mintKey: (slug: string, id: string, label?: string) =>
    call<{ key: string; hash: string; record: KeyDto }>(
      `${p(slug)}/licenses/${enc(id)}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ label }),
      },
    ),
  revokeKey: (slug: string, id: string, keyHash: string) =>
    call<{ ok: true; hash: string; status: KeyStatus }>(
      `${p(slug)}/licenses/${enc(id)}/keys/${enc(keyHash)}/revoke`,
      { method: "POST" },
    ),

  // ── license devices ───────────────────────────────────────────────────────────
  licenseDevices: (slug: string, id: string) =>
    call<{ devices: DeviceDto[] }>(`${p(slug)}/licenses/${enc(id)}/devices`),
  deauthorizeDevice: (slug: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/licenses/${enc(id)}/devices/${enc(deviceId)}`,
      {
        method: "DELETE",
      },
    ),
  /** Clear a device's hardware binding WITHOUT deauthorizing it — the support escape hatch
   *  for a false-positive drift lockout, so the user keeps their seat. */
  resetDeviceFingerprint: (slug: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/licenses/${enc(id)}/devices/${enc(deviceId)}/fingerprint/reset`,
      { method: "POST" },
    ),

  // ── fingerprint policy ──────────────────────────────────────────────────────
  fingerprintPolicy: (slug: string) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/policy`),
  updateFingerprintPolicy: (
    slug: string,
    patch: Partial<FingerprintPolicyDto>,
  ) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/policy`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  revertFingerprintPolicy: (slug: string) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/policy/revert`, {
      method: "POST",
    }),

  // ── profiles ────────────────────────────────────────────────────────────────
  profiles: (slug: string) =>
    call<{ profiles: ProfileSummary[] }>(`${p(slug)}/profiles`),
  profile: (slug: string, id: string) =>
    call<ProfileDetail>(`${p(slug)}/profiles/${enc(id)}`),
  createProfile: (
    slug: string,
    body: { id?: string; name?: string; description?: string },
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  putProfilePayload: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  deleteProfile: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/profiles/${enc(id)}`, {
      method: "DELETE",
    }),

  // ── tiers ─────────────────────────────────────────────────────────────────────
  tiers: (slug: string) => call<{ tiers: TierSummary[] }>(`${p(slug)}/tiers`),
  createTier: (slug: string, body: TierBody) =>
    call<{ ok: true; id: string }>(`${p(slug)}/tiers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchTier: (slug: string, id: string, body: TierBody) =>
    call<{ ok: true; id: string }>(`${p(slug)}/tiers/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTier: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/tiers/${enc(id)}`, {
      method: "DELETE",
    }),

  // ── activity (keyset) ─────────────────────────────────────────────────────────
  activity: (slug: string, cursor?: ActivityCursor | null, limit = 50) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      search.set("beforeAt", String(cursor.beforeAt));
      search.set("beforeId", cursor.beforeId);
    }
    return call<ActivityPage>(`${p(slug)}/activity?${search.toString()}`);
  },
};
