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
import type { ArtifactRole } from "@polaris-key/manifest";
import type { ServiceSlug } from "./services.generated.js";
import { RELEASE_POLICY_ERROR_MESSAGES } from "./lib/releasePolicyMessages.js";

// ── identity ──────────────────────────────────────────────────────────────────
export interface ProductRef {
  slug: string;
  name: string;
  schemaVersion: number;
}

/** The deployment a console session talks to (worker `PKEY_ENVIRONMENT`, ADMIN.md A-1). */
export type ConsoleEnvironment = "prod" | "staging" | "dev";

export interface Me {
  sub: string;
  name: string;
  email: string;
  csrf: string;
  platformAdmin: boolean;
  products: ProductRef[];
  /**
   * Which deployment this is (A-1). `null`/absent when the worker has no `PKEY_ENVIRONMENT`:
   * the environment badge then stays hidden, as it does in production.
   */
  environment?: ConsoleEnvironment | null;
  /** When the admin session ends, epoch seconds (A-1; the session is a hard 8 h). */
  sessionExpiresAt?: number;
}

// ── platform (A-11 deploy identity, A-12 platform audit) ─────────────────────────

/** Cloudflare's own record of the running version (the version metadata binding). */
export interface PlatformCloudflareVersion {
  id: string;
  tag: string | null;
  /** ISO 8601, as Cloudflare reports it. */
  uploadedAt: string | null;
}

/** `GET /manage/api/platform/version` (worker `core/deployIdentity.ts`). */
export interface PlatformIdentity {
  releaseTag: string | null;
  gitSha: string | null;
  cloudflare: PlatformCloudflareVersion | null;
  protocolVersion: number;
  discoveryVersion: number;
  latestMigration: string;
  environment: ConsoleEnvironment | null;
}

/** A keyset position in a platform list: the last row's `at` and `id`. */
export interface PlatformCursor {
  beforeAt: number;
  beforeId: string;
}

/** One `platform_deploys` row: a deploy the workflow recorded. */
export interface PlatformDeploy {
  id: string;
  /** Epoch seconds. */
  at: number;
  environment: string | null;
  tag: string | null;
  gitSha: string | null;
  runUrl: string | null;
  scripts: string[];
  latestMigration: string | null;
  cloudflareVersionId: string | null;
  deltasVersionId: string | null;
  smoke: string | null;
}

/** `GET /manage/api/platform/deployment`. */
export interface PlatformDeployment {
  current: PlatformIdentity;
  deploys: { items: PlatformDeploy[]; nextCursor: PlatformCursor | null };
  migrations: {
    latest: string;
    /** `null`: `d1_migrations` could not be read (unknown, not "none applied"). */
    applied: { name: string; appliedAt: string | null }[] | null;
    upToDate: boolean | null;
  };
  /** `missing: null`: the index check could not run. */
  indexes: { missing: string[] | null };
  /** Binding name → present. Presence only, never an id. */
  bindings: Record<string, boolean>;
}

/** One `platform_audit` row: an admin action that belongs to no product. */
export interface PlatformActivityItem {
  id: string;
  /** Epoch seconds. */
  at: number;
  actor: { sub: string; name: string; email: string };
  action: string;
  target: { kind: string; id: string } | null;
  summary: string;
  before: unknown;
  after: unknown;
}

export interface PlatformActivityPage {
  items: PlatformActivityItem[];
  nextCursor: PlatformCursor | null;
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

// ── edge-mint recipe approval (Config, P0-12) ────────────────────────────────

/** What a product secret may be used for. Set by an operator only — never by a manifest. */
export type SecretUsage = "general" | "edge-mint";

/** A store credential's kind (P5-01; worker `core/outletCredentials.ts`). */
export type OutletCredentialKind =
  | "asc-api-key"
  | "asc-webhook-secret"
  | "google-service-account"
  | "ms-partner-center"
  | "sentry-integration"
  | "app-store-server-key"
  | "steam-publisher-key";

/** One outlet credential as the admin API lists it: metadata and health, never the value. */
export interface OutletCredentialInfo {
  id: string;
  kind: OutletCredentialKind | string;
  outletId: string | null;
  /** Non-secret display fields (key id, issuer id, client email, tenant id, …). */
  meta: Record<string, string>;
  status: string;
  createdAt: number;
  createdBy: string;
  rotatedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
}

/** A kind's operator-owned pin (P5-02f): the `meta` field it is kept under and its label. */
export interface OutletCredentialPinSpec {
  field: string;
  label: string;
}

export interface OutletCredentialsResponse {
  ok: true;
  kinds: OutletCredentialKind[];
  /** Kind → its pin, for the kinds that carry one (an `asc-api-key`'s app id). */
  pins?: Record<string, OutletCredentialPinSpec>;
  credentials: OutletCredentialInfo[];
}

export interface PutOutletCredentialBody {
  kind: OutletCredentialKind;
  /** The kind's value object; a Google key may be its JSON file as a string. Omitted with `pin`
   *  alone, to re-pin a stored credential without its value. */
  value?: Record<string, unknown> | string;
  /** The operator's pin: the one store app the credential may be used for (P5-02f). */
  pin?: string;
  outletId?: string | null;
  expiresAt?: number | null;
}

/** The security-relevant recipe fields, exactly as the approve call must echo them. */
export interface EdgeMintRecipeFields {
  alg: string;
  signingKeySecret: string;
  kid: string | null;
  claimsTemplateJson: string | null;
  ttlSeconds: number;
  audience: string | null;
}

/** The sign-in trust an edge-mint approval covers: the product's identity provider and the group
 *  map that decides who a sign-in licenses. `null` means Identity is off (no sign-in path). */
export interface EdgeMintIdentity {
  provider: string | null;
  issuer: string | null;
  clientId: string | null;
  groupRoleMapJson: string | null;
}

export interface EdgeMintRecipe extends EdgeMintRecipeFields {
  id: string;
  /** Parsed `claimsTemplateJson`, for display only (null when absent or corrupt). */
  claimsTemplate: unknown;
  /** `approved` mints; `pending` was never approved; `changed` was approved in another form. */
  status: "approved" | "pending" | "changed";
  secretUsage: SecretUsage | "missing" | "unrecognised";
  approval:
    | (EdgeMintRecipeFields & {
        /** Whether the approval carries the open-registration acknowledgement. */
        openRegistrationAcknowledged: boolean;
        /** Whether License was on (licences checked) when the approval was given. */
        licenseEnabled: boolean;
        /** The sign-in trust recorded with the approval. */
        identity: EdgeMintIdentity | null;
        approvedAt: number;
        approvedBy: string;
      })
    | null;
  /** Why a `changed` recipe's approval no longer applies. `registration` means the mint is
   *  public now (open registration, anonymous enrolment or an OIDC default tier) and the
   *  approval was given without acknowledging that; `license` means License was turned off
   *  since, so device licences are no longer checked; `identity` means sign-in now trusts a
   *  different identity provider or group map than the approval recorded. The next push or
   *  console edit of the product's services or License policy deletes such an approval before
   *  it writes (the recipe then reads `pending`; the audit log says why), so `changed` for these
   *  three lasts only until then — after an operator's own edit, or a push that was cut off
   *  before its own sweep. */
  changedFields: (
    | keyof EdgeMintRecipeFields
    | "registration"
    | "license"
    | "identity"
  )[];
}

export interface EdgeMintRecipesResponse {
  /** The product's EFFECTIVE registration policy; `open` means anyone can hold a device token. */
  registration: "open" | "requires-identity" | "requires-license";
  /** Whether auto-issue lets any caller enrol anonymously (`POST /<p>/license/enroll`). */
  anonymousEnroll: boolean;
  /** Whether Identity is on and auto-issue gives every signed-in account a default tier. */
  oidcDefault: boolean;
  /** Open registration, anonymous enrolment or an OIDC default tier: anyone (who can sign in)
   *  can hold a device token, so approving needs the acknowledgement. */
  publicMint: boolean;
  /** Whether License is on, so the mint checks each device's licence. */
  licenseEnabled: boolean;
  /** The sign-in trust an approval given now would record; the approve call echoes it. */
  identity: EdgeMintIdentity | null;
  recipes: EdgeMintRecipe[];
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
  /** Files the check is about: what the latest release carries (`release-artifacts`), the file
   *  a declared artifact entry matched, or an ambiguous entry's candidates. */
  files?: ReleaseHealthFile[];
}

export interface ReleaseHealthFile {
  name: string;
  platform?: string;
  arch?: string;
  format?: string;
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
/** The opt-in services layered over the always-on Core substrate — generated from the service
 *  table (`tools/services.json`) by `pnpm gen:services`. */
export type { ServiceSlug };

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
  distribution_requires_release:
    "Distribution delivers what Release says exists — enable Release first, or turn Distribution off.",
  update_requires_distribution:
    "Update is a feed over what Distribution delivers — enable Distribution first, or turn Update off.",
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

/** Who owns a block a resync can also write: `admin` once an operator saved it here (resync then
 *  skips it), `manifest` otherwise (P0-01). */
export type SettingsSource = "manifest" | "admin";

export interface UpdateSettings {
  /** Who may read the changelog, the version check and the installer. */
  metadataAccess: ReleaseAccess;
  /** Who owns the metadata mode. (The artifacts mode is Distribution's since P2b-04:
   *  `DeliveryAccess`.) */
  accessSource: SettingsSource;
  compatMin: string;
  compatMax: string;
  compatSource: SettingsSource;
  /** Operator-only `sparkle:minimumSystemVersion`; `null` when unset. No manifest writes it. */
  minimumSystemVersion: string | null;
  /** Operator-only; `true` unless an operator explicitly turned it off (R6-03). */
  requireSparkleSignature: boolean;
  /** False when the product has no release configuration: the access modes and artifact policy
   *  are defaults and a PATCH of them has nothing to write to (the server 422s). */
  configured: boolean;
}

export type UpdateSettingsBody = Partial<
  Pick<
    UpdateSettings,
    | "metadataAccess"
    | "compatMin"
    | "compatMax"
    | "minimumSystemVersion"
    | "requireSparkleSignature"
  >
>;

/** The blocks `update/settings/revert` can hand back to the manifest. */
export type UpdateSettingsBlock = "access" | "compat";

// ── distribution: delivery access + rollouts (P2b-04) ────────────────────────
/**
 * Who may download a deliverable (worker `services/distribution/access.ts`): the ONE answer the
 * downloads, the appcast and the portal read. The `app` row is manifest-owned until an operator
 * saves it; a pack with no row inherits the app's.
 */
export interface DeliveryAccess {
  modes: ReleaseAccess[];
  app: { deliverableId: string; mode: ReleaseAccess; source: SettingsSource };
  deliverables: Array<{
    deliverableId: string;
    mode: ReleaseAccess;
    entitlement: string | null;
    source: SettingsSource;
    modifiedAt: number;
  }>;
}

export type RolloutState = "active" | "paused" | "halted" | "complete";

/** One outlet rollout (worker `core/hooks.ts` `RolloutRecord`). */
export interface Rollout {
  deliverableId: string;
  outletId: string;
  channel: string;
  releaseId: string;
  /** Basis points, 0–10000. */
  rolloutBp: number;
  state: RolloutState;
  /** A store connector owns it; direct edits are refused. */
  mirrored: boolean;
  source: string;
  startedAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface RolloutsResponse {
  rollouts: Rollout[];
}

// ── distribution: the matrix (P2b-06) ────────────────────────────────────────
export type RolloutVerb = "pause" | "resume" | "halt" | "complete";

/** One availability record (worker `core/hooks.ts` `AvailabilityRecord`). */
export interface AvailabilityRecordDto {
  releaseId: string;
  /** `''` = the whole release. */
  buildId: string;
  outletId: string;
  transport: string;
  state: string;
  since: number | null;
  source: string;
  /** No report: a self-hosted outlet is live wherever our bytes are. */
  derived: boolean;
  updatedAt: number | null;
}

/** One submission record (worker `core/hooks.ts` `SubmissionRecord`). */
export interface SubmissionRecordDto {
  releaseId: string;
  outletId: string;
  state: string;
  submittedAt: number | null;
  reviewedAt: number | null;
  source: string;
  updatedAt: number;
}

export interface MatrixRolloutDto extends Rollout {
  /** The verbs the state allows; empty for a mirrored rollout. */
  controls: RolloutVerb[];
}

export interface MatrixCellDto {
  releaseId: string;
  outletId: string;
  /** The best state among the records, or `null`. */
  availability: string | null;
  records: AvailabilityRecordDto[];
  submission: SubmissionRecordDto | null;
  rollouts: MatrixRolloutDto[];
  /**
   * P4-14: the app release's readiness on this outlet (worker `distribution/readiness.ts`
   * `OutletReadiness`, abridged); null for a pack's cells and a product without packs. Absent from
   * a worker that predates P4-14.
   */
  readiness?: MatrixReadinessDto | null;
}

/** The fields of `OutletReadiness` the console renders. */
export interface MatrixReadinessDto {
  state: string;
  holds: boolean;
  holdable: boolean;
  warning: string | null;
  blockers: {
    pack: string;
    version: string | null;
    reason: string;
    detail: string;
  }[];
  pendingReason: string | null;
}

/** `GET …/distribution/matrix` (worker `services/distribution/matrix.ts`). */
export interface DistributionMatrix {
  deliverableId: string;
  limit: number;
  outlets: Array<{
    outletId: string;
    kind: string;
    transport: string;
    derives: boolean;
    /** Whether Polaris Key acts on the transport (delivers it, P4-05, or tracks a store transport through reports, P5-08); an unsupported one is stored only. */
    supported: boolean;
  }>;
  releases: Array<{
    releaseId: string;
    version: string;
    channel: string | null;
    publishedAt: number | null;
    yanked: boolean;
  }>;
  cells: MatrixCellDto[];
  states: { availability: string[]; submission: string[]; rollout: string[] };
}

// ── distribution: update health (P6-03) ───────────────────────────────────────
/** The seven update outcome events (`updateEvent` in conformance/parity/enums.json). */
export type UpdateEventName =
  | "update_offered"
  | "update_downloaded"
  | "update_applied"
  | "update_confirmed"
  | "update_reverted"
  | "pack_failed"
  | "boot_rolled_back";

export type UpdateEventCounts = Record<UpdateEventName, number>;

/** The operator-owned telemetry auto-halt (worker `services/distribution/autoHalt.ts`). */
export interface AutoHaltSettings {
  enabled: boolean;
  windowHours: number;
  minSample: number;
  maxRevertRate: number;
  maxBootRollbackRate: number;
}

/** A tracked object of the auto-halt or the Sentry hook (worker `connectors/state.ts`). */
export interface UpdateHealthObject {
  type: string;
  id: string;
  outletId: string | null;
  releaseId: string | null;
  state: string | null;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
  terminal: boolean;
  updatedAt: number;
}

/** `GET …/distribution/update-health` (worker `services/distribution/updateHealthAdmin.ts`). */
export interface UpdateHealthResponse {
  windowHours: number;
  /** Whether this deployment has the counters bound at all. */
  counting: boolean;
  events: UpdateEventName[];
  rollouts: Array<{
    rollout: Rollout;
    /** Distinct devices per event; `null` when the counters could not be read. */
    devices: UpdateEventCounts | null;
    events: UpdateEventCounts | null;
    truncated: boolean;
    verdict: {
      revertRate: number | null;
      bootRollbackRate: number | null;
      trips: string[];
    } | null;
  }>;
  unknown: Array<{
    deliverable: string;
    releaseId: string;
    outlet: "unknown";
    devices: UpdateEventCounts;
  }>;
  autoHalt: {
    settings: AutoHaltSettings & {
      updatedAt: number | null;
      updatedBy: string | null;
    };
    defaults: AutoHaltSettings;
    maxWindowHours: number;
    lastReading: UpdateHealthObject | null;
    trips: UpdateHealthObject[];
    alerts: UpdateHealthObject[];
  };
  sentry: { configured: boolean; candidates: UpdateHealthObject[] };
}

// ── release truth store ───────────────────────────────────────────────────────
/**
 * Where an artifact's bytes live (`@polaris-key/manifest` `DescriptorLocation`, P2-04). Every
 * location is pinned by the artifact's SHA-256; `store` carries no bytes of ours.
 */
export type ArtifactLocationDto =
  | { provider: "r2"; key: string }
  | { provider: "github"; asset: string }
  | { provider: "store" }
  | { provider: "external"; url: string };

export interface ReleaseArtifactDto {
  artifactId: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  sizeBytes: number | null;
  access: string | null;
  /** The build this file belongs to (P2-04's descriptor); `null` for a file the GitHub sync
   *  indexed without one. */
  buildId: string | null;
  /** `ARTIFACT_ROLES` in `@polaris-key/manifest`: payload, signature, checksum, … */
  role: ArtifactRole | (string & {}) | null;
  sha256: string | null;
  /** As the descriptor declared them; `null` for a file only the GitHub sync knows. */
  locations: ArtifactLocationDto[] | null;
}

/** One build of a release (P2-04 descriptor; worker `release_builds`). */
export interface ReleaseBuildDto {
  buildId: string;
  /** `null` = platform-independent (a pack variant). */
  platform: string | null;
  arch: string;
  format: string | null;
  buildNumber: string | null;
  minOs: string | null;
  /** P4-09: the pack ids this build ships embedded; `null` (or absent) when its descriptor said
   *  nothing about embedding. */
  embeds?: string[] | null;
}

/** A release's yank (P2-05): never offered on a moving selector; resolves only by pin. */
export interface ReleaseYankDto {
  reason: string;
  at: number;
  /** `admin:<sub>` or `ci:<subject>`. */
  by: string;
}

export interface ReleaseDto {
  releaseId: string;
  version: string;
  title: string | null;
  publishedAt: number | null;
  sourceUrl: string | null;
  status: string;
  artifacts: ReleaseArtifactDto[];
  /** The deliverable this is a release of (`app` until packs exist). */
  deliverable: string;
  seq: number | null;
  /** The channel it was published to; `null` = derived from GitHub's prerelease flag. */
  channel: string | null;
  yank: ReleaseYankDto | null;
  /** Empty for a legacy release no descriptor described. */
  builds: ReleaseBuildDto[];
  /** P4-09: the app release's `content.contentApi`; `null` before its product declared packs. */
  contentApi?: number | null;
  /** P4-09: the exact pack release each pack is pinned to (a mirror of the signed `content`). */
  pins?: AppPinDto[];
}

/** One pin of an app release (worker `release_pins`, P4-02). */
export interface AppPinDto {
  pack: string;
  packReleaseId: string;
  /** `null` when the pinned release's row is gone. */
  packVersion: string | null;
  /** The pinned pack release's yank: a yank never changes an existing pin. */
  packYank: ReleaseYankDto | null;
  /** The app release's `expects` entry for the pack. */
  required: boolean;
  delivery: string;
  recordSha256: string;
}

// ── pack deliverables (P4-09; worker `release/packs/adminView.ts`) ─────────────

/** One row of `GET …/release/deliverables`: the app or a pack. */
export interface DeliverableDto {
  id: string;
  /** `app` or `pack`. */
  kind: string;
  /** The pack type; `null` for the app. */
  type: string | null;
  /** False for a pack whose stored declaration does not read back (a resync rewrites it). */
  declared: boolean;
  binding: string | null;
  required: boolean | null;
  /** `embedded` or `none` for a pack. */
  baseline: string | null;
  delivery: string | null;
  variantKeys: string[];
  /** The licence flag `.pkey/release` asserts; never the gate. */
  assertedEntitlement: string | null;
  /** The delivery gate (Distribution's access row for this deliverable), or `null`. */
  gate: string | null;
  latest: {
    releaseId: string;
    version: string;
    seq: number | null;
    publishedAt: number | null;
    yanked: boolean;
    /** The latest pack release's signed `entitlement`, or `null`. */
    entitlement: string | null;
  } | null;
  releaseCount: number;
  /** Distinct app releases pinning some release of this pack; `null` for the app. */
  pinnedByAppReleases: number | null;
}

/** One row of `GET …/release/delegations` (P4-19, worker `release/packs/adminView.ts`): a
 *  delegated content key. Read-only: minting and revoking are CI acts. */
export interface DelegationDto {
  sha256: string;
  scope: string;
  types: string[];
  effectiveTypes: string[];
  seq: number;
  issuedAt: number;
  expiresAt: number;
  status: "active" | "closed" | "revoked";
  origin: "submit" | "revocation";
  signedBy: string;
  keyFingerprint: string;
  releaseCount: number;
  revocation: {
    sha256: string;
    kid: string | null;
    reason: string | null;
    issuedAt: number | null;
  } | null;
}

export interface DelegationsResponse {
  delegations: DelegationDto[];
}

export interface DeliverablesResponse {
  deliverables: DeliverableDto[];
  /** False while Distribution is off: `gate` is unknown then, not "ungated". */
  gateKnown: boolean;
}

/** One entry of a pack variant's delta menu, as the signed record gives it. */
export interface PackDeltaDto {
  /** `payload` (one patch) or `files` (a per-entry patch set). */
  scope: string;
  method: string | null;
  /** The base's `payload.sha256`. */
  from: string | null;
  /** The version of this pack's release that has that base, when one does. */
  fromVersion: string | null;
  /** Stored bytes a device downloads for this strategy. */
  bytes: number;
  memBytes: number | null;
}

export interface PackVariantDto {
  /** `""` for an unvaried pack. */
  variantKey: string;
  variant: Record<string, string>;
  engine: string | null;
  payload: { size: number; sha256: string };
  /** Stored bytes of the whole payload (the full download). */
  fullBytes: number | null;
  indexBytes: number | null;
  deltas: PackDeltaDto[];
}

export interface PinnedByDto {
  appReleaseId: string;
  appVersion: string | null;
  appYank: ReleaseYankDto | null;
  required: boolean;
  delivery: string;
  recordSha256: string;
}

export interface PackReleaseDto {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  publishedAt: number | null;
  yank: ReleaseYankDto | null;
  recordSha256: string | null;
  formatVersion: number | null;
  entitlement: string | null;
  /** P4-19: who signed the record (absent from a Worker before P4-19). */
  signer?:
    | { kind: "release"; kid: string }
    | { kind: "delegated"; delegation: string; scope: string; seq: number }
    | null;
  variants: PackVariantDto[];
  /** Every app release that pins this pack release, yanked or not. */
  pinnedBy: PinnedByDto[];
}

export interface PackReleasesResponse {
  deliverable: string;
  releases: PackReleaseDto[];
}

/** One file of a pack variant, from its files index (never where its blob is stored). */
export interface PackFileDto {
  path: string;
  size: number;
  sha256: string;
  /** Container layout only. */
  offset: number | null;
  blob: { sha256: string; bytes: number; codec: string };
}

export interface PackFilesResponse {
  deliverable: string;
  releaseId: string;
  variant: string;
  /** At most 2,000; `total` is how many the index lists. */
  files: PackFileDto[];
  total: number;
}

// ── release: the compatibility matrix (P4-15; worker `release/packs/compat.ts`) ─────
export type CompatCellState =
  | "pinned"
  | "held"
  | "compatible"
  | "incompatible"
  | "revoked";

export interface CompatYankDto {
  reason: string;
  at: number;
  by: string;
}

export interface CompatAppReleaseDto {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  contentApi: number | null;
  live: boolean;
  liveOn: string[];
  yanked: CompatYankDto | null;
  platforms: string[];
  engines: string[];
  pins: { pack: string; releaseId: string }[];
  holds: { pack: string; releaseId: string }[];
  unsatisfied: {
    pack: string;
    reason: string;
    detail: string;
    channel: string;
    platform: string;
    engine: string;
    variant: string;
  }[];
}

export interface CompatPackReleaseDto {
  pack: string;
  releaseId: string;
  version: string;
  seq: number | null;
  sha256: string | null;
  channel: string | null;
  requires: { contentApi: string[]; engines: string[] };
  yanked: CompatYankDto | null;
  revoked: {
    kind: "record" | "delegation";
    recordSha256: string;
    reason: string;
    issuedAt: number;
    replacement: { releaseId: string; sha256: string } | null;
  } | null;
  current: boolean;
}

export interface CompatCellDto {
  appReleaseId: string;
  packReleaseId: string;
  state: CompatCellState;
  current: boolean;
  yanked: boolean;
  reason: string;
}

/** `GET …/release/compat`. */
export interface CompatResponse {
  channels: string[];
  liveLevels: Record<string, number[]>;
  levels: number[];
  limit: number;
  packs: { id: string; binding: string; required: boolean; delivery: string }[];
  appReleases: CompatAppReleaseDto[];
  packReleases: CompatPackReleaseDto[];
  cells: CompatCellDto[];
  hidden: { appReleases: number; packReleases: number };
  /** The page's window start; `older` is what lies past it; `capped` that the 200-row cap cut. */
  offset: number;
  capped: boolean;
  older: { appReleases: number; packReleases: number };
  resolvedAt: number | null;
}

// ── update: the simulator (P4-15; worker `update/simulate.ts`) ──────────────────
export interface SimulateParams {
  appRelease: string;
  platform: string;
  outlet?: string;
  /** `axis=value;axis=value` (a value may be a `,` preference list). */
  variant?: string;
  channel?: string;
  /** A device id, for the rollout buckets. */
  device?: string;
  /** A device's reported packSetId, to compare. */
  packSetId?: string;
}

export interface SimulatedReleaseDto {
  sha256: string;
  version: string;
  seq: number;
}

export interface SimulatedPackDto {
  pack: string;
  declared: { binding: string; required: boolean; delivery: string } | null;
  expected: { required: boolean; delivery: string } | null;
  effectiveBinding: string | null;
  reason: {
    kind: "app-pin" | "app-hold" | "transport" | "declared" | "undeclared";
    detail: string;
    transport?: string;
  };
  feedTarget: SimulatedReleaseDto | null;
  gate: {
    halted: boolean;
    rollout: { bp: number; salt: string } | null;
    bucket: number | null;
    takesTarget: boolean;
    fallback: SimulatedReleaseDto | null;
  } | null;
  floor: { minVersion: string; versionScheme: string } | null;
  unsatisfied: { reason: string; detail: string; variant: string }[];
  revocations: {
    kind: "record" | "delegation";
    record: string;
    target: string;
    version: string;
    replacement: { releaseId: string; sha256: string } | null;
    reason: string;
  }[];
  active: SimulatedReleaseDto | null;
  install: SimulatedReleaseDto | null;
  revoke: boolean;
  runs: SimulatedReleaseDto | null;
}

/** `GET …/update/simulate`: the decision is client-core's `UpdateDecision`, as the worker ran it. */
export interface SimulateResponse {
  selector: {
    appRelease: string;
    version: string;
    channel: string;
    platform: string;
    outlet: { id: string; kind: string; servesPlatform: boolean } | null;
    axes: Record<string, string[]>;
    engine: string | null;
    contentApi: number | null;
    build: { id: string; arch: string; format: string } | null;
    device: string | null;
    methods: string[];
  };
  feed: {
    composable: boolean;
    selector: Record<string, string>;
    omitted: string[];
    /** Entries the document's delta menu lists (P4-29); 0: none. */
    deltas: number;
    target: SimulatedReleaseDto | null;
    appRollout: {
      halted: boolean;
      rollout: { bp: number; salt: string } | null;
      bucket: number | null;
    } | null;
  };
  decision: ({ action: string } & Record<string, unknown>) | null;
  boot: string | null;
  errors: { code: string; detail: string | null }[];
  set: { pack: string; sha256: string; version: string; seq: number }[];
  packSetId: string | null;
  activePackSetId: string | null;
  reported: { packSetId: string; matches: boolean } | null;
  block: string | null;
  packs: SimulatedPackDto[];
  notes: string[];
}

export interface ReleaseChannelDto {
  channel: string;
  releaseId: string;
  modifiedAt: number | null;
}

/**
 * A channel's anti-rollback floor (P0-02, R6-10): the highest version a sync has seen on it. An
 * operator may lower or clear it (`…/release/channels/<channel>/floor`), never raise it.
 */
export interface ReleaseChannelFloorDto {
  channel: string;
  version: string;
  releaseId: string | null;
  raisedAt: number;
  loweredBy: string | null;
  loweredAt: number | null;
}

export interface ReleaseStoreResponse {
  releases: ReleaseDto[];
  channels: ReleaseChannelDto[];
  floors: ReleaseChannelFloorDto[];
}

/**
 * One channel's policy as `GET …/release/channels` returns it (worker `policy.ts`
 * `ChannelPolicyView`, plus what it resolves to). The console renders `resolved` and
 * `byPlatform` as they are: it never recomputes resolution.
 */
export interface ChannelPolicyDto {
  deliverable: string;
  channel: string;
  /** A release id, or `null` to follow the newest eligible release. */
  pointer: string | null;
  pinned: boolean;
  /** Channels this one includes; `null` = the default (beta includes stable). */
  includes: string[] | null;
  /** The device floor the signed feed carries (P2-03, P3-03). */
  minSupported: string | null;
  critical: boolean;
  /** `manifest` until an operator or CI changes the row; `admin` from then on. */
  source: SettingsSource;
  modifiedAt: number | null;
  modifiedBy: string | null;
  /** The release the channel resolves to with no platform filter, or `null`. */
  resolved: string | null;
  /** Platform → the release the channel resolves to there (`null`: nothing qualifies). */
  byPlatform: Record<string, string | null>;
}

export interface ReleaseChannelsResponse {
  deliverables: Array<{
    deliverable: string;
    kind: string;
    /** Every platform some build of the deliverable declares, sorted. */
    platforms: string[];
    channels: ChannelPolicyDto[];
  }>;
}

/** `PUT …/release/channels/<channel>`: any of these; an omitted field is left as it is. */
export interface ChannelPolicyBody {
  deliverable?: string;
  pointer?: string | null;
  pinned?: boolean;
  minSupported?: string | null;
  critical?: boolean;
}

/** `POST …/release/channels/<channel>/floor`: lower to a version, or clear. Never raises. */
export type ChannelFloorBody = { version: string } | { clear: true };

export { RELEASE_POLICY_ERROR_MESSAGES };

/** The console's wording for a release policy refusal. */
export function releasePolicyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const known = err.reason
      ? RELEASE_POLICY_ERROR_MESSAGES[err.reason]
      : undefined;
    if (known) return known;
    if (err.message && err.message !== `api ${err.status}`) return err.message;
    return `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
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

/** One row of Platform → Devices: the license view's device without fingerprint/facts, plus the
 *  license it holds (null = license-free) and the seat it occupies. */
export interface ProductDeviceDto {
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
  licenseId: string | null;
  seatNo: number | null;
  /** P6-02: `attested` once the device proved a genuine store install (App Attest or Play
   *  Integrity); everything else, including web, desktop and sideloaded builds, is `basic`. */
  trustLevel?: "basic" | "attested";
  attestedAt?: number | null;
  /** The last attestation verdict summary (kind, outcome, reason or verdicts), never a token. */
  lastVerdict?: AttestationVerdictDto | null;
}

export interface AttestationVerdictDto {
  kind?: string;
  outcome?: string;
  reason?: string;
  at?: number;
  [k: string]: unknown;
}

/** A single device, with the hardware binding and software facts the list omits. */
export interface ProductDeviceDetail extends ProductDeviceDto {
  fingerprint: DeviceFingerprintDto | null;
  facts: DeviceFactsDto | null;
}

export type ProductDeviceStatusFilter = "authorized" | "deauthorized" | "all";

export interface ProductDeviceQuery {
  status?: ProductDeviceStatusFilter;
  platform?: string;
  licensed?: boolean;
  q?: string;
  limit?: number;
  /** Opaque: the previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface ProductDevicePage {
  devices: ProductDeviceDto[];
  nextCursor: string | null;
}

export interface DeviceCount {
  value: string | null;
  count: number;
}

export interface ProductDeviceSummary {
  total: number;
  byStatus: DeviceCount[];
  /** Authorized devices only, as are the breakdowns below. */
  licensed: { licensed: number; licenseFree: number };
  byPlatform: DeviceCount[];
  byArch: DeviceCount[];
  bySdkName: DeviceCount[];
  /** Top 20 by count. */
  byAppVersion: DeviceCount[];
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
   *  infer a license from, and guessing would silently mint the wrong grant. */
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
     * impossible" — `update_requires_distribution` names no single toggle, it names a relationship.
     * Only the endpoints that validate a whole object against rules (services, so far) send it.
     */
    public readonly errors?: string[],
    /**
     * A machine-readable refusal reason (`unknown_channel`, `release_yanked`, …). The release
     * policy routes send it beside the generic `code` (worker `release/admin.ts`).
     */
    public readonly reason?: string,
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
    let reason: string | undefined;
    try {
      const body = (await res.json()) as {
        error?:
          | string
          | {
              code?: string;
              message?: string;
              fields?: string[];
              errors?: string[];
              reason?: string;
            };
        message?: string;
        fields?: string[];
        errors?: string[];
        code?: string;
        reason?: string;
      };
      if (typeof body.error === "object" && body.error) {
        fields = body.error.fields ?? body.fields;
        errors = body.error.errors ?? body.errors;
        code = body.error.code ?? body.code;
        message = body.error.message ?? body.message;
        reason = body.error.reason ?? body.reason;
      } else {
        fields = body.fields;
        errors = body.errors;
        code = body.error ?? body.code;
        message = body.message;
        reason = body.reason;
      }
    } catch {
      // non-JSON error body
    }
    const error = new ApiError(res.status, fields, code, errors, reason);
    if (message) error.message = message;
    throw error;
  }
  // 204/empty bodies are tolerated (returns undefined cast to T).
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

/** A platform list's keyset position as a query string (`""` for the first page). */
function cursorQuery(cursor?: PlatformCursor | null): string {
  if (
    !cursor ||
    typeof cursor !== "object" ||
    typeof cursor.beforeAt !== "number" ||
    !cursor.beforeId
  ) {
    return "";
  }
  return `?beforeAt=${cursor.beforeAt}&beforeId=${enc(cursor.beforeId)}`;
}
/** Build a per-product API base. */
const p = (slug: string): string => `/manage/api/products/${enc(slug)}`;

const rawApi = {
  // ── identity ────────────────────────────────────────────────────────────────
  me: () => call<Me>("/manage/api/me"),
  logout: () => call<{ ok: true }>("/manage/api/logout", { method: "POST" }),

  // ── platform (instance-wide, product-less; A-11/A-12, notes/S-13 §9.2) ─────────
  /** Which build of Polaris Key is running. Cheap: the account menu's version chip reads it. */
  platformVersion: () => call<PlatformIdentity>("/manage/api/platform/version"),
  /** Identity, deploy history (keyset `cursor`), D1 migrations, indexes and bindings. */
  platformDeployment: (cursor?: PlatformCursor | null) =>
    call<PlatformDeployment>(
      `/manage/api/platform/deployment${cursorQuery(cursor)}`,
    ),
  /** `platform_audit`, newest first (keyset `cursor`). */
  platformActivity: (cursor?: PlatformCursor | null) =>
    call<PlatformActivityPage>(
      `/manage/api/platform/activity${cursorQuery(cursor)}`,
    ),

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
  /**
   * Tombstone a product. `confirmSlug` is what the operator TYPED in the L3 confirmation (ADMIN.md
   * §5.2): the worker refuses unless it equals the slug, and the client never fills it in itself
   * (fixes PRD-4: an auto-filled guard guards nothing).
   */
  deleteProduct: (slug: string, confirmSlug: string) =>
    call<{ ok: true; slug: string }>(p(slug), {
      method: "DELETE",
      body: JSON.stringify({ confirmSlug }),
    }),
  resyncProduct: (slug: string) =>
    call<ResyncResult>(`${p(slug)}/release/resync`, { method: "POST" }),
  releaseHealth: (slug: string) =>
    call<{ health: ReleaseHealth }>(`${p(slug)}/release/health`),
  /** The release TRUTH STORE (`release_metadata`/`_artifacts`/`_channels`, P2.T2) — what
   *  Polaris Key believes the linked repo publishes, without spending a GitHub round-trip. */
  releases: (slug: string) =>
    call<ReleaseStoreResponse>(`${p(slug)}/release/releases`),
  /** P4-09: the app and every pack, with its declaration, gate and latest release. */
  deliverables: (slug: string) =>
    call<DeliverablesResponse>(`${p(slug)}/release/deliverables`),
  /** P4-19: the product's delegated content keys, read-only. */
  delegations: (slug: string) =>
    call<DelegationsResponse>(`${p(slug)}/release/delegations`),
  /** P4-09: a pack's releases, newest first, each with the app releases that pin it. */
  packReleases: (slug: string, deliverable: string) =>
    call<PackReleasesResponse>(
      `${p(slug)}/release/deliverables/${enc(deliverable)}/releases`,
    ),
  /** P4-09: one variant's files (`variant` is `""` for an unvaried pack), read from its index. */
  packFiles: (
    slug: string,
    deliverable: string,
    releaseId: string,
    variant: string,
  ) =>
    call<PackFilesResponse>(
      `${p(slug)}/release/deliverables/${enc(deliverable)}/releases/${enc(releaseId)}/files?variant=${enc(variant)}`,
    ),
  /** P4-15: app releases × pack releases, a state per pair, the live contentApi levels. */
  releaseCompat: (
    slug: string,
    opts: { limit?: number; offset?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.offset !== undefined && opts.offset > 0)
      q.set("offset", String(opts.offset));
    const qs = q.toString();
    return call<CompatResponse>(
      `${p(slug)}/release/compat${qs ? `?${qs}` : ""}`,
    );
  },
  /** P4-15: what a fresh device running one app release gets on one outlet (read-only). */
  simulateUpdate: (slug: string, params: SimulateParams) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (typeof v === "string" && v !== "") q.set(k, v);
    return call<SimulateResponse>(`${p(slug)}/update/simulate?${q.toString()}`);
  },
  // ── release channel policy (P2-05 admin routes; worker `release/admin.ts`) ────
  /** Every deliverable's channels: policy, source, and what each resolves to, per platform. */
  releaseChannels: (slug: string) =>
    call<ReleaseChannelsResponse>(`${p(slug)}/release/channels`),
  /** Promote (`pointer`), pin (`pointer` + `pinned: true`), unpin (`pinned: false`), the device
   *  floor (`minSupported`) and `critical`. Claims the row for the operator. */
  updateReleaseChannel: (
    slug: string,
    channel: string,
    body: ChannelPolicyBody,
  ) =>
    call<{ ok: true; policy: ChannelPolicyDto }>(
      `${p(slug)}/release/channels/${enc(channel)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Hand the channel back to the manifest. Changes nothing live — the manifest's declaration
   *  re-applies on the NEXT resync. */
  revertReleaseChannel: (slug: string, channel: string, deliverable?: string) =>
    call<{ ok: true; policy: ChannelPolicyDto }>(
      `${p(slug)}/release/channels/${enc(channel)}/revert`,
      {
        method: "POST",
        body: JSON.stringify(deliverable ? { deliverable } : {}),
      },
    ),
  /** Lower or clear a channel's anti-rollback floor (P0-02). The server refuses a raise. */
  setChannelFloor: (slug: string, channel: string, body: ChannelFloorBody) =>
    call<{ ok: true; channel: string; floor: ReleaseChannelFloorDto | null }>(
      `${p(slug)}/release/channels/${enc(channel)}/floor`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  yankRelease: (slug: string, releaseId: string, reason: string) =>
    call<{ ok: true }>(`${p(slug)}/release/releases/${enc(releaseId)}/yank`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  unyankRelease: (slug: string, releaseId: string) =>
    call<{ ok: true }>(`${p(slug)}/release/releases/${enc(releaseId)}/yank`, {
      method: "DELETE",
    }),
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
  /** Write-only. `usage` omitted keeps what is stored (a new secret is general). */
  putProductSecret: (
    slug: string,
    name: string,
    value: string,
    usage?: SecretUsage,
  ) =>
    call<{ ok: true; name: string; usage?: SecretUsage }>(
      `${p(slug)}/secrets/${enc(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(usage ? { value, usage } : { value }),
      },
    ),
  // ── outlet credentials (P5-01): platform admin, write-only ──────────────────
  outletCredentials: (slug: string) =>
    call<OutletCredentialsResponse>(`${p(slug)}/outlet-credentials`),
  /** Write-only: the response echoes the id, never the value or its metadata. */
  putOutletCredential: (
    slug: string,
    id: string,
    body: PutOutletCredentialBody,
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/outlet-credentials/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteOutletCredential: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/outlet-credentials/${enc(id)}`, {
      method: "DELETE",
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
  /** Hand the named blocks back to the manifest. Changes nothing live — the manifest re-applies
   *  on the NEXT resync (worker `services/update/admin.ts`). */
  revertUpdateSettings: (slug: string, fields: UpdateSettingsBlock[]) =>
    call<UpdateSettings>(`${p(slug)}/update/settings/revert`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    }),

  // ── distribution: delivery access + rollouts (P2b-04) ───────────────────────
  deliveryAccess: (slug: string) =>
    call<DeliveryAccess>(`${p(slug)}/distribution/access`),
  saveDeliveryAccess: (
    slug: string,
    body: { mode: ReleaseAccess; deliverable?: string },
  ) =>
    call<DeliveryAccess>(`${p(slug)}/distribution/access`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** Hand the app's delivery access back to the manifest; it re-applies on the next resync. */
  revertDeliveryAccess: (slug: string) =>
    call<DeliveryAccess>(`${p(slug)}/distribution/access/revert`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  rollouts: (slug: string) =>
    call<RolloutsResponse>(`${p(slug)}/distribution/rollouts`),
  /** The release × outlet matrix (P2b-06). */
  distributionMatrix: (
    slug: string,
    opts: { deliverable?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.deliverable) q.set("deliverable", opts.deliverable);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return call<DistributionMatrix>(
      `${p(slug)}/distribution/matrix${qs ? `?${qs}` : ""}`,
    );
  },
  /** A rollout verb on one outlet's channel (P2b-04's admin route). `releaseId` guards against
   *  acting on a rollout that moved to another release since the matrix was read. */
  rolloutAction: (
    slug: string,
    outlet: string,
    channel: string,
    verb: RolloutVerb,
    body: { deliverable: string; releaseId: string },
  ) =>
    call<{ rollout: Rollout }>(
      `${p(slug)}/distribution/rollouts/${encodeURIComponent(outlet)}/${encodeURIComponent(channel)}/${verb}`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // ── distribution: update health (P6-03) ─────────────────────────────────────
  updateHealth: (slug: string, windowHours?: number) =>
    call<UpdateHealthResponse>(
      `${p(slug)}/distribution/update-health${
        windowHours !== undefined ? `?windowHours=${windowHours}` : ""
      }`,
    ),
  /** The auto-halt settings — the ONE writer, audited by the worker. */
  saveAutoHalt: (slug: string, body: Partial<AutoHaltSettings>) =>
    call<{ settings: UpdateHealthResponse["autoHalt"]["settings"] }>(
      `${p(slug)}/distribution/update-health/settings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Confirm (halts the rollout, as you) or dismiss a Sentry halt candidate. */
  decideCandidate: (
    slug: string,
    id: string,
    decision: "confirm" | "dismiss",
  ) =>
    call<{ candidate: UpdateHealthObject }>(
      `${p(slug)}/distribution/update-health/candidates/${encodeURIComponent(id)}/${decision}`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // ── config: catalog ───────────────────────────────────────────────────────────
  schema: (slug: string) => call<ProductCatalog>(`${p(slug)}/config/catalog`),
  publishSchema: (slug: string, catalog: ProductCatalog) =>
    call<{ ok: true; schemaVersion: number }>(`${p(slug)}/config/catalog`, {
      method: "PUT",
      body: JSON.stringify({ catalog }),
    }),

  // ── config: edge-mint recipe approval (P0-12) ───────────────────────────────
  edgeMintRecipes: (slug: string) =>
    call<EdgeMintRecipesResponse>(`${p(slug)}/config/mint`),
  /** Approve exactly what the operator was shown — the recipe and the sign-in trust beside it:
   *  the server refuses (409) if either changed. */
  approveEdgeMintRecipe: (
    slug: string,
    id: string,
    fields: EdgeMintRecipeFields,
    identity: EdgeMintIdentity | null,
    /** Whether License was on in the view the operator approved from (refused with 409 if a
     *  push changed it since). */
    licenseEnabled: boolean,
    acknowledgeOpenRegistration = false,
  ) =>
    call<{ ok: true; id: string; status: "approved" }>(
      `${p(slug)}/config/mint/${enc(id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          alg: fields.alg,
          signingKeySecret: fields.signingKeySecret,
          kid: fields.kid,
          claimsTemplateJson: fields.claimsTemplateJson,
          ttlSeconds: fields.ttlSeconds,
          audience: fields.audience,
          identity,
          licenseEnabled,
          ...(acknowledgeOpenRegistration
            ? { acknowledgeOpenRegistration: true }
            : {}),
        }),
      },
    ),
  revokeEdgeMintRecipe: (slug: string, id: string) =>
    call<{ ok: true; id: string; status: "pending" }>(
      `${p(slug)}/config/mint/${enc(id)}/revoke`,
      { method: "POST" },
    ),

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

  // ── devices, product-wide (Core) ─────────────────────────────────────────────
  productDevices: (slug: string, query: ProductDeviceQuery = {}) => {
    const search = new URLSearchParams();
    if (query.status) search.set("status", query.status);
    if (query.platform) search.set("platform", query.platform);
    if (query.licensed !== undefined)
      search.set("licensed", String(query.licensed));
    if (query.q) search.set("q", query.q);
    if (query.limit) search.set("limit", String(query.limit));
    if (query.cursor) search.set("cursor", query.cursor);
    const qs = search.toString();
    return call<ProductDevicePage>(`${p(slug)}/devices${qs ? `?${qs}` : ""}`);
  },
  productDeviceSummary: (slug: string) =>
    call<ProductDeviceSummary>(`${p(slug)}/devices/summary`),
  productDevice: (slug: string, deviceId: string) =>
    call<ProductDeviceDetail>(`${p(slug)}/devices/${enc(deviceId)}`),
  deauthorizeProductDevice: (slug: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/devices/${enc(deviceId)}/deauthorize`,
      { method: "POST" },
    ),
  resetProductDeviceFingerprint: (slug: string, deviceId: string) =>
    call<{ ok: true; deviceId: string }>(
      `${p(slug)}/devices/${enc(deviceId)}/fingerprint/reset`,
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

/** The admin API surface: every endpoint the console calls. */
export type AdminApi = typeof rawApi;
export type AdminApiMethod = keyof AdminApi;

/**
 * The admin API client. Reads are called directly; WRITES go through `mutate()` in
 * `console/data/mutations.ts`, which runs each write's declared invalidation (ADMIN.md §5.4).
 * `test/mutations.test.ts` fails if a view calls a write on `api` directly.
 */
export const api: AdminApi = rawApi;
