/**
 * Same-origin typed client for the `/manage/api/*` surface. The worker
 * (`packages/worker/src/admin/api.ts` + each service's `admin.ts`) is the source of truth for
 * these shapes.
 *
 * ── THE ADMIN SURFACE IS SERVICE-GROUPED (plan §R1) ─────────────────────────────────────────
 *
 * Every product-scoped resource now lives under the service that owns it, and the pre-suite
 * spellings are GONE server-side (pre-launch; this client was their only consumer):
 *
 *   licenses[/…] → license/licenses[/…]      schema  → config/catalog
 *   tiers[/…]    → license/tiers[/…]         profiles[/…] → config/profiles[/…]
 *   policy[…]    → license/policy[…]         portal  → identity/portal
 *
 * Core/platform resources keep their top-level spelling because they belong to no service:
 * `secrets/*`, `keys/rotate`, `activity`, `services[/revert]`, `bundles`.
 *
 * Auth is the HttpOnly session cookie (sent automatically); every state-changing
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
/**
 * Re-exported from `@polaris-key/catalog`, which is the ONE definition the worker validates against,
 * the SDKs read, and `tools/gen-mirrors.ts` generates from. The console used to re-declare a
 * hand-copied subset here (`ui.widget` as a bare `string`, no `dependsOn`/`appliesTo`), which is
 * how a form silently stops rendering a field the catalog gained. Views keep importing these
 * from `./api.js` — this file is still the console's single import surface, it just no longer
 * owns the shapes.
 */
export type {
  ConfigEntry,
  ConfigKind,
  ManagementState,
  ProductCatalog,
  UiHints,
} from "@polaris-key/catalog";
import type { ManagementState, ProductCatalog } from "@polaris-key/catalog";

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
  /**
   * TRI-STATE (R5-01/R5-02). `null` is "auto": derived from the product's OIDC issuer — on for
   * the platform issuer, OFF for a product on a tenant-controlled `custom` issuer, whose email
   * and `sub` claims are outside the trust boundary. `true`/`false` is an explicit operator
   * override in either direction, which is why this is not a boolean with a default.
   */
  autoLinkEnabled: boolean | null;
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
  /**
   * Which services this product runs (D-15). Carried on the product row itself — not only on
   * `GET …/services` — because the SHELL needs it to decide which nav sections exist, and the
   * shell already loads the product. A second round-trip before the sidebar can be drawn would
   * make the nav pop in after the view it frames.
   */
  services?: Record<ServiceSlug, { enabled: boolean }>;
  /** Declared device-registration policy, or `null` when the product rides the derived default. */
  registration?: RegistrationPolicy | null;
  /** What the derivation currently produces — what the wire actually enforces. */
  effectiveRegistration?: RegistrationPolicy;
  /** Who owns `services_json`: `manifest` (a resync may rewrite it) or `admin`. */
  servicesSource?: string;
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
    | "autoLinkEnabled"
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

/**
 * NOTE what is absent: `compatMin`/`compatMax`. Spec §8 relocated the compatibility window to
 * `update/settings`, and the worker's product PATCH now DROPS them rather than rejecting them —
 * so a console that still sent them would appear to save a value that never changed. Removing
 * them from the type is what makes that unrepresentable instead of merely unused.
 */
export interface UpdateProductBody {
  name?: string;
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

// ── services (per-product enablement) ─────────────────────────────────────────
/** The five opt-in services layered over the always-on Core substrate. */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";

/** How a device may register (spec §2.3). Derived from the enablement set unless declared. */
export type RegistrationPolicy =
  | "open"
  | "requires-identity"
  | "requires-license";

/**
 * `GET /manage/api/products/<slug>/services` — the single authority for which services a
 * product runs. Every console affordance that only makes sense for a running service is a
 * projection of this, rather than being inferred from the presence of some child row.
 */
export interface ServicesResponse {
  services: Record<ServiceSlug, { enabled: boolean }>;
  /** As DECLARED — `null` when the product rides the derived default. */
  registration: RegistrationPolicy | null;
  /** What the derivation currently produces — what the wire actually enforces. */
  effectiveRegistration: RegistrationPolicy;
  /** Who owns the row: `manifest` (a resync may rewrite it) or `admin` (operator-claimed). */
  source: string;
}

/** A partial enablement patch: an omitted slug keeps its current value server-side. */
export interface UpdateServicesBody {
  services?: Partial<Record<ServiceSlug, { enabled: boolean }>>;
  /** `null` clears the declaration and returns the product to the derived default. */
  registration?: RegistrationPolicy | null;
}

/**
 * The stable coherence codes `PATCH …/services` returns in `error.errors` (worker
 * `core/services.ts` `validateServices`). Rendered as inline validation rather than a toast:
 * they name the exact toggle the operator just moved.
 */
export const SERVICE_ERROR_MESSAGES: Record<string, string> = {
  update_requires_release:
    "Update is a feed over Release’s truth store — enable Release first, or turn Update off.",
  registration_requires_identity:
    "Registration is set to “requires-identity”, but Identity is off; no device could ever register.",
  config_without_activation:
    "Config is on without License, but registration is set to “requires-license” — those devices could never obtain a token.",
};

// ── update settings (feed access + compat window) ─────────────────────────────
export type ReleaseAccess =
  | "public"
  | "authenticated"
  | "licensed"
  | "entitled";

export interface UpdateSettings {
  metadataAccess: ReleaseAccess;
  artifactsAccess: ReleaseAccess;
  compatMin: string;
  compatMax: string;
  /** False when the product has no release configuration: the access modes are defaults and a
   *  PATCH of them has nothing to write to (the server 422s). */
  configured: boolean;
}

export type UpdateSettingsBody = Partial<
  Pick<
    UpdateSettings,
    "metadataAccess" | "artifactsAccess" | "compatMin" | "compatMax"
  >
>;

// ── release truth store ───────────────────────────────────────────────────────
export interface ReleaseArtifactDto {
  artifactId: string;
  name: string;
  kind: string;
  platform: string | null;
  arch: string | null;
  sizeBytes: number | null;
  access: string | null;
}

export interface ReleaseDto {
  releaseId: string;
  version: string;
  title: string | null;
  publishedAt: number | null;
  sourceUrl: string | null;
  status: string;
  artifacts: ReleaseArtifactDto[];
}

export interface ReleaseChannelDto {
  channel: string;
  releaseId: string;
  modifiedAt: number | null;
}

export interface ReleaseStoreResponse {
  releases: ReleaseDto[];
  channels: ReleaseChannelDto[];
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

// ── offline bundles ───────────────────────────────────────────────────────────
/**
 * What to mint into one offline activation bundle. The server
 * (`packages/worker/src/core/bundles.ts`) decides what actually rides inside by ENABLEMENT,
 * so this is a request, not an instruction.
 */
export interface MintBundleBody {
  /** The device's request code, exactly as the app's offline screen shows it: 32 base64url
   *  characters. A typo is a 400 rather than a bundle no machine can import. */
  deviceId: string;
  /** The offline window in days, 1..365 — the same ceiling the importing client enforces. */
  graceDays: number;
  /** Defaults to true server-side; forced false when the Config service is disabled. Omit it
   *  and let enablement decide rather than asserting a preference the operator never made. */
  includeConfig?: boolean;
  /** REQUIRED when the License service is enabled — there is no authenticated device here to
   *  infer a licence from, and guessing would silently mint the wrong grant. */
  licenseId?: string;
}

export interface MintBundleResult {
  /** A ULID, and the audit anchor: the mint is recorded under it and the importing client
   *  reports it back, so it is the only string tying a support ticket to a row. */
  bundleId: string;
  /** The compact `pkey-bundle+jws` — this string IS the file the operator carries across. */
  bundle: string;
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
    /**
     * Stable COHERENCE codes, distinct from `fields`. A field name says "this input was
     * malformed"; an `errors` entry says "these inputs are individually fine and jointly
     * impossible" — `update_requires_release` names no single toggle, it names a relationship.
     * Only the endpoints that validate a whole object against rules (services, so far) send it.
     */
    public readonly errors?: string[],
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
    let errors: string[] | undefined;
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as {
        error?:
          | string
          | {
              code?: string;
              message?: string;
              fields?: string[];
              errors?: string[];
            };
        message?: string;
        fields?: string[];
        errors?: string[];
        code?: string;
      };
      if (typeof body.error === "object" && body.error) {
        fields = body.error.fields ?? body.fields;
        errors = body.error.errors ?? body.errors;
        code = body.error.code ?? body.code;
        message = body.error.message ?? body.message;
      } else {
        fields = body.fields;
        errors = body.errors;
        code = body.error ?? body.code;
        message = body.message;
      }
    } catch {
      // non-JSON error body
    }
    const error = new ApiError(res.status, fields, code, errors);
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
  /** The release TRUTH STORE (`release_metadata`/`_artifacts`/`_channels`, P2.T2) — what
   *  Polaris Key believes the linked repo publishes, without spending a GitHub round-trip. */
  releases: (slug: string) =>
    call<ReleaseStoreResponse>(`${p(slug)}/release/releases`),
  portalSettings: (slug: string) =>
    call<{ settings: PortalProductSettings }>(`${p(slug)}/identity/portal`),
  updatePortalSettings: (slug: string, body: UpdatePortalSettingsBody) =>
    call<{ ok: true; settings: PortalProductSettings }>(
      `${p(slug)}/identity/portal`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  putProductSecret: (slug: string, name: string, value: string) =>
    call<{ ok: true; name: string }>(`${p(slug)}/secrets/${enc(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  rotateProductKey: (slug: string) =>
    call<RotateKeyResult>(`${p(slug)}/keys/rotate`, { method: "POST" }),

  // ── services (per-product enablement) ───────────────────────────────────────
  services: (slug: string) => call<ServicesResponse>(`${p(slug)}/services`),
  updateServices: (slug: string, body: UpdateServicesBody) =>
    call<ServicesResponse>(`${p(slug)}/services`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Hand `services_json` back to the manifest. Changes nothing live — the manifest re-applies
   *  on the NEXT resync (worker `core/servicesAdmin.ts`). */
  revertServices: (slug: string) =>
    call<ServicesResponse>(`${p(slug)}/services/revert`, { method: "POST" }),

  // ── update settings ─────────────────────────────────────────────────────────
  updateSettings: (slug: string) =>
    call<UpdateSettings>(`${p(slug)}/update/settings`),
  saveUpdateSettings: (slug: string, body: UpdateSettingsBody) =>
    call<UpdateSettings>(`${p(slug)}/update/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  // ── config: catalog ───────────────────────────────────────────────────────────
  schema: (slug: string) => call<ProductCatalog>(`${p(slug)}/config/catalog`),
  publishSchema: (slug: string, catalog: ProductCatalog) =>
    call<{ ok: true; schemaVersion: number }>(`${p(slug)}/config/catalog`, {
      method: "PUT",
      body: JSON.stringify({ catalog }),
    }),

  // ── licenses ────────────────────────────────────────────────────────────────
  licenses: (slug: string) =>
    call<{ licenses: LicenseSummary[] }>(`${p(slug)}/license/licenses`),
  license: (slug: string, id: string) =>
    call<LicenseDetail>(`${p(slug)}/license/licenses/${enc(id)}`),
  createLicense: (slug: string, body: CreateLicenseBody) =>
    call<{ licenseId: string; key: string; license: LicenseSummary }>(
      `${p(slug)}/license/licenses`,
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
    }>(`${p(slug)}/license/licenses/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  setLicenseEnabled: (slug: string, id: string, enabled: boolean) =>
    call<{ ok: true; id: string; status: LicenseStatus }>(
      `${p(slug)}/license/licenses/${enc(id)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    ),
  putLicenseOverrides: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(
      `${p(slug)}/license/licenses/${enc(id)}/overrides`,
      {
        method: "PUT",
        body: JSON.stringify({ updates }),
      },
    ),

  // ── license keys ──────────────────────────────────────────────────────────────
  licenseKeys: (slug: string, id: string) =>
    call<{ keys: KeyDto[] }>(`${p(slug)}/license/licenses/${enc(id)}/keys`),
  mintKey: (slug: string, id: string, label?: string) =>
    call<{ key: string; hash: string; record: KeyDto }>(
      `${p(slug)}/license/licenses/${enc(id)}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ label }),
      },
    ),
  revokeKey: (slug: string, id: string, keyHash: string) =>
    call<{ ok: true; hash: string; status: KeyStatus }>(
      `${p(slug)}/license/licenses/${enc(id)}/keys/${enc(keyHash)}/revoke`,
      { method: "POST" },
    ),

  // ── license devices ───────────────────────────────────────────────────────────
  licenseDevices: (slug: string, id: string) =>
    call<{ devices: DeviceDto[] }>(
      `${p(slug)}/license/licenses/${enc(id)}/devices`,
    ),
  deauthorizeDevice: (slug: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/license/licenses/${enc(id)}/devices/${enc(deviceId)}`,
      {
        method: "DELETE",
      },
    ),
  /** Clear a device's hardware binding WITHOUT deauthorizing it — the support escape hatch
   *  for a false-positive drift lockout, so the user keeps their seat. */
  resetDeviceFingerprint: (slug: string, id: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/license/licenses/${enc(id)}/devices/${enc(deviceId)}/fingerprint/reset`,
      { method: "POST" },
    ),

  // ── offline bundles ─────────────────────────────────────────────────────────
  /** Mint one offline activation bundle for an air-gapped device. Re-minting is cheap — the
   *  result is a signed artifact, not a secret the server forgets. */
  mintBundle: (slug: string, body: MintBundleBody) =>
    call<MintBundleResult>(`${p(slug)}/bundles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── enrollment & fingerprint policy (License) ───────────────────────────────
  fingerprintPolicy: (slug: string) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/license/policy`),
  updateFingerprintPolicy: (
    slug: string,
    patch: Partial<FingerprintPolicyDto>,
  ) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/license/policy`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  revertFingerprintPolicy: (slug: string) =>
    call<FingerprintPolicyResponse>(`${p(slug)}/license/policy/revert`, {
      method: "POST",
    }),

  // ── profiles ────────────────────────────────────────────────────────────────
  profiles: (slug: string) =>
    call<{ profiles: ProfileSummary[] }>(`${p(slug)}/config/profiles`),
  profile: (slug: string, id: string) =>
    call<ProfileDetail>(`${p(slug)}/config/profiles/${enc(id)}`),
  createProfile: (
    slug: string,
    body: { id?: string; name?: string; description?: string },
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  putProfilePayload: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  deleteProfile: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "DELETE",
    }),

  // ── tiers ─────────────────────────────────────────────────────────────────────
  tiers: (slug: string) =>
    call<{ tiers: TierSummary[] }>(`${p(slug)}/license/tiers`),
  createTier: (slug: string, body: TierBody) =>
    call<{ ok: true; id: string }>(`${p(slug)}/license/tiers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchTier: (slug: string, id: string, body: TierBody) =>
    call<{ ok: true; id: string }>(`${p(slug)}/license/tiers/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTier: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/license/tiers/${enc(id)}`, {
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
