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

// ── platform settings (A-13, notes/S-13 §5, §6.4) ─────────────────────────────────

/** ADMIN.md §5.2 destructive levels, as the settings registry declares them per direction. */
export type PlatformConfirmLevel = "L0" | "L1" | "L2" | "L3";

/**
 * Where an effective value came from. `failsafe`: the store could not be read, so a kill switch
 * resolved to off.
 */
export type PlatformSettingSource =
  | "runtime"
  | "deploy"
  | "default"
  | "failsafe";

interface PlatformSettingBase {
  key: string;
  area: string;
  label: string;
  description: string;
  /** The Worker scripts that read it (`main`, `deltas`). */
  scripts: string[];
  /** `ceiling`: a deploy-time `off` is a hard off no runtime value can override. */
  precedence: "runtime" | "ceiling";
  /** The raw `[vars]` string, `null` when unset. */
  deployValue: string | null;
  source: PlatformSettingSource;
  /** A `ceiling` setting whose `[vars]` value is `off`. */
  forcedOff: boolean;
  /** The runtime row, if any: its value, whether it applies, who set it and when (epoch s). */
  stored: {
    value: unknown;
    valid: boolean;
    updatedAt: number;
    updatedBy: string;
  } | null;
  /** The `expectedVersion` the next write must send (0: no runtime value). */
  version: number;
}

export interface PlatformSwitchSetting extends PlatformSettingBase {
  kind: "switch";
  default: "on" | "off";
  value: "on" | "off";
  confirm: { on: PlatformConfirmLevel; off: PlatformConfirmLevel };
}

export interface PlatformIntegerSetting extends PlatformSettingBase {
  kind: "integer";
  unit: "bytes" | "days";
  /** Inclusive bounds on a runtime value. */
  min: number;
  max: number;
  default: number;
  value: number;
  confirm: { raise: PlatformConfirmLevel; lower: PlatformConfirmLevel };
}

/** One of a short, fixed list of values (LX-05: `LICENSING_RESERVED_NAMES`, warn or error). */
export interface PlatformChoiceSetting extends PlatformSettingBase {
  kind: "choice";
  options: { value: string; label: string }[];
  default: string;
  value: string;
  /** The confirm level for changing TO each value. */
  confirm: Record<string, PlatformConfirmLevel>;
}

export type PlatformSetting =
  | PlatformSwitchSetting
  | PlatformIntegerSetting
  | PlatformChoiceSetting;

/** `GET /manage/api/platform/reserved-names` (LX-05, worker `admin/handlers/reservedNames.ts`). */
export interface PlatformReservedNames {
  /** The platform's severity for an incompatible declaration. */
  mode: "warn" | "error";
  /** The system keys the platform sets, with the rule it applies. */
  keys: {
    key: string;
    type: "string" | "integer" | "string-array";
    rule: string;
  }[];
  /** Prefixes reserved for future system keys. */
  prefixes: string[];
  /** Registered products whose active catalog declares a reserved name. */
  products: {
    slug: string;
    name: string;
    catalogVersion: number;
    declarations: {
      key: string;
      compatible: boolean;
      problem: string | null;
    }[];
  }[];
}

/** A deploy-time value that is not a credential (a list for the parsed issuer allowlist). */
export interface PlatformDeployValue {
  name: string;
  area: string;
  value: string | string[] | null;
}

/** `GET /manage/api/platform/settings` (worker `admin/handlers/platformSettings.ts`). */
export interface PlatformSettingsView {
  settings: PlatformSetting[];
  /** False when the settings table could not be read. */
  storeAvailable: boolean;
  /** How long a change takes to reach every isolate. */
  propagationSeconds: number;
  deployTime: PlatformDeployValue[];
  /** Presence only: never a value, a length or a hash. */
  secrets: { name: string; set: boolean }[];
  /** Code constants that act as policy. */
  constants: { name: string; area: string; value: number; unit: string }[];
  warnings: { code: string; message: string; names: string[] }[];
}

/** `PATCH /manage/api/platform/settings/<key>`. `confirm` echoes the key for an L2+ change. */
export interface PlatformSettingWrite {
  value: string | number;
  expectedVersion: number;
  confirm?: string;
}

/** `GET /manage/api/products/kek`: the keyring (kid names and per-kid counts, never key material). */
export interface PlatformKekStatus {
  ok: true;
  active: string;
  kids: string[];
  /** Sealed-value group → kid → count. */
  counts: Record<string, Record<string, number>>;
  /** Values not yet sealed under `active`. */
  remaining: number;
  /** Values under a kid that is no longer in the ring. */
  unopenable: number;
}

// ── platform operations (A-14) ─────────────────────────────────────────────────

/** One probe of a binding: presence, then whether it answered in time. */
export interface OperationsProbe {
  bound: boolean;
  /** `null`: not bound, so not probed. */
  ok: boolean | null;
  latencyMs: number | null;
  error?: string;
}

/** A queue's own backlog report; `ok: false` when its `metrics()` failed. */
export interface OperationsQueue extends OperationsProbe {
  backlogCount: number | null;
  backlogBytes: number | null;
  /** Epoch seconds of the oldest waiting message. */
  oldestMessageAt: number | null;
}

/** One cron step of a run (a family of per-product steps is folded into `name:*`). */
export interface OperationsStepRun {
  step: string;
  /** Epoch milliseconds. */
  startedAt: number;
  durationMs: number | null;
  outcome: "ok" | "failed" | (string & {});
  items: number;
  rowsAffected: number | null;
  error: string | null;
}

/** The newest run of a job, with its steps. */
export interface OperationsJobRun {
  runId: string;
  job: string;
  cron: string | null;
  /** Epoch milliseconds. */
  startedAt: number;
  durationMs: number | null;
  outcome: "ok" | "failed" | (string & {});
  steps: OperationsStepRun[];
}

/** A script's heartbeat row (`main`: every cron tick; `deltas`: every consumer batch). */
export interface OperationsHeartbeat {
  script: string;
  /** Epoch seconds. */
  at: number;
  versionTag: string | null;
  cloudflareVersionId: string | null;
  outcome: string | null;
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageAt: number | null;
}

export interface OperationsConnector {
  connector: string;
  productsConfigured: number;
  objectsTracked: number;
  /** Epoch seconds. */
  lastPolledAt: number | null;
  lastEventAt: number | null;
  failedEvents24h: number;
}

/** `GET /manage/api/platform/operations` (worker `core/operations.ts`). A section is `null` when it could not be read. */
export interface PlatformOperations {
  /** Epoch seconds. */
  generatedAt: number;
  probes: {
    d1: OperationsProbe;
    kv: OperationsProbe;
    r2: OperationsProbe;
    updateHealth: { bound: boolean };
    email: { bound: boolean };
  };
  queues: {
    deltas: OperationsQueue;
    deadLetter: OperationsQueue;
    consumer: {
      maxBatchSize: number;
      maxBatchTimeoutSeconds: number;
      maxRetries: number;
      maxConcurrency: number;
    };
  };
  heartbeats: OperationsHeartbeat[] | null;
  jobs: {
    latest: {
      maintenance: OperationsJobRun | null;
      connectorPoll: OperationsJobRun | null;
    };
    recent: {
      runId: string;
      job: string;
      cron: string | null;
      startedAt: number;
      durationMs: number | null;
      outcome: "ok" | "failed" | (string & {});
      steps: number;
    }[];
    failures: {
      runId: string;
      job: string;
      step: string;
      startedAt: number;
      error: string | null;
    }[];
  } | null;
  storage: {
    d1: { sizeBytes: number | null };
    r2: {
      committedBytes: number;
      objects: number;
      byKind: {
        kind: string;
        gated: boolean;
        bytes: number;
        objects: number;
      }[];
    } | null;
  };
  indexes: { missing: string[] | null };
  connectors: {
    items: OperationsConnector[];
    lastPollFailure: {
      step: string;
      /** Epoch milliseconds. */
      at: number;
      error: string | null;
    } | null;
    commerce: { available: boolean };
  } | null;
  recentErrors: {
    jobFailures: unknown;
    lazyDeltaRefusals:
      | { reason: string; count: number; lastAt: number }[]
      | null;
  };
}

// ── platform store connections (A-16; worker `admin/handlers/platformStoreConnections.ts`) ──

/** A store the platform holds one team-level connection for. */
export type PlatformStore =
  | "app-store"
  | "google-play"
  | "microsoft-store"
  | "steam";

/** One credential slot of a store connection: presence and metadata, never a key. */
export interface PlatformStoreCredential {
  /** `<store>.<slot>`: `app-store.api-key`, `app-store.in-app-purchase-key`, … */
  id: string;
  store: PlatformStore;
  slot: string;
  kind: string;
  label: string;
  configured: boolean;
  /** The source a connector would use now. */
  source: "console" | "secret" | null;
  /** Key id, issuer id, client email, tenant, client and seller ids. Never the key. */
  meta: Record<string, string> | null;
  console: {
    present: boolean;
    status: string | null;
    meta: Record<string, string> | null;
    createdAt: number | null;
    createdBy: string | null;
    rotatedAt: number | null;
    lastUsedAt: number | null;
    lastOkAt: number | null;
    /** A status line the Worker composed (`HTTP 401`), never a store response body. */
    lastError: string | null;
  };
  secret: { name: string; present: boolean; valid: boolean };
  /** What a product's pin on this credential names (`appleId`, `packageName`, …). */
  pinField: string;
  pins: number;
}

/** A non-secret store setting shared by every product (the Apple Team ID, …). */
export interface PlatformStoreSetting {
  key: string;
  label: string;
  usedBy: string;
  value: string | null;
  source: "console" | "env" | null;
  envName: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** One store's connection, as `GET /manage/api/platform/store-connections` lists it. */
export interface PlatformStoreConnection {
  store: PlatformStore;
  label: string;
  configured: boolean;
  /** The primary slot's id: the one the apps listing uses and an assignment pins. */
  primary: string;
  credentials: PlatformStoreCredential[];
  settings: PlatformStoreSetting[];
  appsListing: boolean;
  /** Which product holds which app: credential id → pin. */
  assignments: { product: string; pins: Record<string, string> }[];
}

/** One app the team credential can see, joined with the product holding it. */
export interface PlatformStoreApp {
  /** The value an assignment pins (Apple ID, package name, Store ID, Steam app id). */
  appId: string;
  name: string | null;
  /** Pins on the store's other credentials an assignment sets too (the bundle id). */
  pins: Record<string, string>;
  identifiers: Record<string, string | null>;
  /** The store's distribution status, in its own vocabulary. */
  status: Record<string, unknown>;
  assignedProduct: string | null;
  assignedVia: "platform" | "own-credential" | null;
}

/** `GET /manage/api/platform/store-connections/<store>/apps`. */
export interface PlatformStoreApps {
  store: PlatformStore;
  source: "console" | "secret";
  /** Epoch seconds. */
  fetchedAt: number;
  cached: boolean;
  truncated: boolean;
  /** `false`: the store could not list its apps; only operator-entered ones are shown (Steam). */
  listed?: boolean;
  apps: PlatformStoreApp[];
}

/** `PUT …/apps/<appId>/product`. */
export interface PlatformStoreAssignResult {
  store: PlatformStore;
  appId: string;
  product: string;
  pins: { credential: string; pin: string; changed: boolean }[];
  released: { credential: string; pin: string }[];
  /** The product's own keys re-pinned to the same app (same store account as the team key). */
  ownCredentialsRepinned: string[];
  /** Own keys left alone because their store account cannot be told from their metadata. */
  ownCredentialsSkipped: { id: string; reason: string }[];
}

/** `DELETE …/apps/<appId>/product`. */
export interface PlatformStoreReleaseResult {
  store: PlatformStore;
  appId: string;
  product: string;
  cleared: { credential: string; pin: string }[];
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
  /** `asc-webhook-secret` only: the Worker generates the secret and never returns it. */
  generate?: boolean;
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
  /** PX-W5 (G7): customers may replace a license's key from the portal. Off by default. */
  keyReissueEnabled?: boolean;
  /** PX-W5 / S-16: an email-carrying license may be added by key without that email. Off by default. */
  claimByKey?: boolean;
  /** PX-W10 (G24): the product may be offered on the portal's Discover. On by default. */
  discoverEnabled?: boolean;
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
  /** The platform's own product (F-03: the package-feeds owner of our SDKs); kept out of the
   *  product switcher and the Products registry. */
  system?: boolean;
  /** The operator-owned `packageFeeds` sub-capability (F-11): Distribution → Package feeds shows
   *  only while it is on. */
  packageFeeds?: boolean;
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
    | "keyReissueEnabled"
    | "claimByKey"
    | "discoverEnabled"
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
  /** `null` (or blank) clears the group (A-3). */
  adminGroup?: string | null;
}

export interface RotateKeyResult {
  ok: true;
  kid: string;
  publicKey: string;
  status?: "staged" | "active";
  activateAfter?: number;
}

/** `POST …/release/resync` (worker `release/admin.ts`): what the resync re-applied. */
export interface ResyncResult {
  ok: true;
  slug: string;
  /** What the resync re-applied ("services", "catalog", "channels"…). */
  updated?: string[];
  /** Parts of the manifest it refused while applying the rest (P3-03). */
  refused?: { code: string; path: string; message: string }[];
  /** The pack-set re-resolution, when it stored sets or failed (P4-12). */
  packSets?:
    | { ok: true; sets: number }
    | { ok: false; reason: string; message: string };
}

// ── Core inventories (chunk 5 · A-4, A-5) and CI publishing (P2-02) ─────────────
export type SigningKeyState = "active" | "staged" | "retired" | "revoked";

/** One signing key (`GET …/keys`, A-4). Public material only. */
export interface SigningKeyDto {
  kid: string;
  status: SigningKeyState | (string & {});
  alg: string;
  publicKey: string;
  createdAt: number;
  activateAfter: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
}

/**
 * After a rotation (UX-29): the authorized devices seen in the last `windowDays`, and how many of
 * them reached the server since the active key went live. Derived from `last_seen`; there is no
 * per-device trust fetch record, so the console says "refreshed", never "fetched the new trust".
 */
export interface SigningKeyRefreshDto {
  kid: string;
  activatedAt: number;
  activeDevices: number;
  refreshedDevices: number;
  windowDays: number;
}

export interface SigningKeysResponse {
  keys: SigningKeyDto[];
  /** The server's clock, epoch seconds: the staged countdown is measured against it. */
  now: number;
  /** `null` unless the active key replaced another within the window; absent on older Workers. */
  refresh?: SigningKeyRefreshDto | null;
}

/** One secret of the inventory (`GET …/secrets`, A-5). Never a value. */
export interface ProductSecretDto {
  name: string;
  configured: boolean;
  usage: SecretUsage | null;
  createdAt: number | null;
  updatedAt: number | null;
  requiredBy: string[];
}

export interface PublisherPolicyDto {
  product: string;
  provider: "github";
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  workflow: string;
  environment: string;
  scopes: string[];
  source: "manifest" | "admin";
  createdAt: number;
  modifiedAt: number;
  modifiedBy: string | null;
}

export interface PublisherClaimBody {
  workflow?: string;
  environment?: string;
  scopes?: string[];
  repository?: string;
  repositoryId?: number;
  repositoryOwnerId?: number;
}

export interface CiTokenDto {
  tokenId: string;
  kind: "oidc" | "static";
  scopes: string[];
  subject: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
}

export interface IssueCiTokenBody {
  scopes: string[];
  expiresInDays: number;
  label?: string;
}

export interface IssuedCiToken {
  ok: true;
  token: string;
  tokenId: string;
  expiresAt: number;
  scopes: string[];
}

/** The CI scopes a publisher policy or a static token can hold (worker `core/ciVocabulary.ts`). */
export const CI_SCOPES = [
  "release:publish",
  "release:promote",
  "release:yank",
  "distribution:report",
  "distribution:rollout",
  "distribution:feeds",
  "distribution:listing",
] as const;

/** The blob collector's dry run for one product (`GET …/blob-gc`, P4-14). */
export interface BlobGcDryRun {
  enabled: boolean;
  graceSeconds: number;
  lockAgeSeconds: number;
  skipped?: string | null;
  complete?: boolean;
  incomplete?: unknown;
  liveReleases?: number;
  drops: {
    packObject: number;
    packUpload: number;
    truncated: boolean;
    listed: unknown[];
  };
  restores: { count: number; listed: unknown[] };
  earliestDeletion: number | null;
}

/** The activity feed's server-side filters (A-2). */
export interface ActivityFilters {
  /** A prefix: `license.` matches every license action. */
  action?: string;
  /** A subject or email; `system` for rows the runtime wrote. */
  actor?: string;
  targetKind?: string;
  targetId?: string;
  /** Epoch seconds, inclusive. */
  since?: number;
  until?: number;
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
  /** `pending`, `blocked`, `ready` or `overridden` (an operator released the hold). */
  state: string;
  /** The computed state, whatever the override (absent from an older worker). */
  computed?: string;
  holds: boolean;
  holdable: boolean;
  warning: string | null;
  blockers: {
    pack: string;
    /** The pack release that blocks, when one exists (`null` for `unsatisfied`). */
    packReleaseId?: string | null;
    version: string | null;
    reason: string;
    detail: string;
  }[];
  pendingReason: string | null;
  /** The operator's override, when one is in force. */
  override?: { by: string; at: number; reason: string | null } | null;
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

// ── distribution: outlets, keys, readiness and connectors (admin chunk 9) ─────
/** The capability keys an outlet carries (worker `services/distribution/capabilities.ts`). */
export type CapabilityKey =
  | "binaryUpdates"
  | "codeUpdates"
  | "dataUpdates"
  | "channelSwitch"
  | "commerce"
  | "downloadedScripts";

/** What an outlet permits: `binaryUpdates` self > store > none; `commerce` own, store-iap or none. */
export interface OutletCapabilitiesDto {
  binaryUpdates: string;
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: string;
  downloadedScripts: boolean;
}

/** One outlet as the admin API lists it (worker `distribution/admin.ts` `outletView`). */
export interface OutletDto {
  outletId: string;
  kind: string;
  identity: Record<string, unknown>;
  listing: unknown;
  /** The capabilities in force; `null` for a kind this build has no defaults for. */
  capabilities: OutletCapabilitiesDto | null;
  defaultCapabilities: OutletCapabilitiesDto | null;
  /** `manifest`, or `admin` once an operator narrowed it. */
  capabilitiesSource: string;
  capabilityOverride: Partial<OutletCapabilitiesDto> | null;
  transports: Array<{
    deliverableId: string;
    transport: string;
    supported: boolean;
  }>;
  removedAt: number | null;
  createdAt: number;
  modifiedAt: number;
}

export interface OutletsResponse {
  capabilityKeys: CapabilityKey[];
  outlets: OutletDto[];
}

/** One distribution signing-key inventory entry (worker `availability.ts` `keyRecord`). */
export interface DistributionKeyDto {
  purpose: string;
  sha256: string;
  outletId: string | null;
  notes: string | null;
  registered: boolean;
  registeredAt: number | null;
  observed: Record<string, unknown> | null;
  /** CI observed a key of this purpose that matches no entry. */
  flagged: boolean;
}

/** A key CI observed that matches no inventory entry. */
export interface DistributionKeyObservationDto {
  purpose: string;
  sha256: string;
  outletId: string | null;
  observed: Record<string, unknown> | null;
  firstSeenAt: number;
}

export interface DistributionKeysResponse {
  purposes: string[];
  keys: DistributionKeyDto[];
  observations: DistributionKeyObservationDto[];
}

export interface PutDistributionKeyBody {
  purpose: string;
  sha256: string;
  outlet?: string | null;
  notes?: string | null;
  registered?: boolean;
}

/** A store connector's status (worker `distribution/connectors/*` `status`). */
export interface ConnectorStatusDto {
  /** `asc`, `play` or `ms-store`. */
  kind: string;
  label: string;
  outletKinds: string[];
  configured: boolean;
  /** Why it does not run, when it does not. */
  inert?: { reason: string; message: string } | null;
  setup?: Record<string, unknown> | null;
  /** The control paths it answers (`phased-release/pause`, `rollout/fraction`, …). */
  controls: string[];
  notes?: string[];
  /** Google Play: the operator's settings. */
  settings?: {
    priority?: { default?: number };
    vitals?: Record<string, unknown>;
  };
  /**
   * Where its key comes from, `product` or `platform` (A-16). The App Store Connect connector
   * reports it inside `setup` (with `platformSource`); this top-level field is the fallback.
   */
  credentialSource?: string;
}

export interface ConnectorsResponse {
  connectors: ConnectorStatusDto[];
}

// ── distribution: App Store Distribute and in-app purchases (A-17d, A-17e; console A-17g) ──
// Reads under `GET …/distribution/connectors/asc/<path>` (worker `connectors/asc/distribute.ts`,
// `commerce/appleCatalog.ts`). Every Apple field is passed through as Apple states it.

/** A note on a build upload (`{ code, description }`, Apple's text bounded by the Worker). */
export interface AscUploadNote {
  code: string;
  description: string;
}

/** One unexpired build of the pinned app (`distribute/builds`). */
export interface AscBuildDto {
  id: string;
  buildNumber: string | null;
  version: string | null;
  platform: string | null;
  /** `PROCESSING`, `FAILED`, `INVALID` or `VALID`. */
  processingState: string | null;
  usesNonExemptEncryption: boolean | null;
  exportComplianceNeeded: boolean;
  uploadedDate: string | null;
  expirationDate: string | null;
  internalBuildState: string | null;
  externalBuildState: string | null;
  upload: {
    id: string;
    state: string | null;
    warnings: AscUploadNote[];
    errors: AscUploadNote[];
    uploadedDate: string | null;
  } | null;
  /** The Polaris Key release the connector linked the build to, when it did. */
  releaseId: string | null;
}

export interface AscBuildsResponse {
  ok: true;
  appleId: string;
  builds: AscBuildDto[];
}

export interface AscBetaGroupDto {
  id: string;
  name: string | null;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
  publicLinkEnabled: boolean;
}

export interface AscBetaGroupsResponse {
  ok: true;
  betaGroups: AscBetaGroupDto[];
}

/** One App Store version (`distribute/versions`). */
export interface AscVersionDto {
  id: string;
  platform: string | null;
  versionString: string | null;
  state: string | null;
  appStoreState: string | null;
  releaseType: string | null;
  earliestReleaseDate: string | null;
  /** Metadata, build and release type can still change. */
  editable: boolean;
  buildId: string | null;
  phasedReleaseId: string | null;
  phasedReleaseState: string | null;
}

/** A review submission that is open or with Apple. */
export interface AscSubmissionDto {
  id: string;
  platform: string | null;
  state: string | null;
  submittedDate: string | null;
  cancelable: boolean;
}

export interface AscVersionsResponse {
  ok: true;
  versions: AscVersionDto[];
  submissions: AscSubmissionDto[];
}

/** One preflight line; `ok: null` is a portal step the API cannot see. */
export interface AscPreflightCheck {
  id: string;
  ok: boolean | null;
  detail?: string;
  missing?: string[];
}

export interface AscPreflightResponse {
  ok: true;
  versionId: string;
  state: string | null;
  ready: boolean;
  checks: AscPreflightCheck[];
}

/** What can ride the next review submission (`distribute/submission-items`). */
export interface AscSubmissionItemsResponse {
  ok: true;
  platform: string;
  firstInAppPurchase: boolean;
  firstInAppPurchaseNote?: string;
  inAppPurchaseVersions: {
    inAppPurchaseVersionId: string;
    productId: string;
    iapId: string;
    name: string | null;
    state: string | null;
    versionState: string | null;
  }[];
  backgroundAssetVersions: {
    backgroundAssetVersionId: string;
    assetPackIdentifier: string | null;
    version: string | null;
    appStoreReleaseState: string | null;
  }[];
}

/** One `app-store` commerce mapping beside Apple's state (`iap/products`). */
export interface AscIapProductDto {
  storeProductId: string;
  flag: string;
  deliverableId: string;
  /** `missing`, or Apple's state (`MISSING_METADATA`, `READY_TO_SUBMIT`, `APPROVED`, …). */
  status: string;
  typeMismatch: boolean;
  iap: {
    id: string;
    name: string | null;
    inAppPurchaseType: string | null;
    state: string | null;
    familySharable: boolean;
  } | null;
}

export interface AscIapProductsResponse {
  ok: true;
  appleId: string;
  firstInAppPurchase: boolean;
  firstInAppPurchaseNote?: string;
  priceChangeWarning: string;
  products: AscIapProductDto[];
}

export interface AscPricePointDto {
  id: string;
  customerPrice: string | null;
  proceeds: string | null;
}

export interface AscPricePointsResponse {
  ok: true;
  productId: string;
  iapId: string;
  territory: string;
  current: {
    baseTerritory: string | null;
    pricePointId: string | null;
    customerPrice: string | null;
  } | null;
  /** A change of an existing price: typed. */
  priceChange: boolean;
  priceChangeWarning: string;
  pricePoints: AscPricePointDto[];
}

/** A readiness refresh: how many rows it recomputed. */
export interface ReadinessRefreshResult {
  refreshed: number;
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
  /**
   * Who signed the release record: the CI release key (AGENTS rule 2), with the record's hash.
   * `null` for a release no signed record describes (a legacy GitHub-synced release); absent from
   * a Worker that predates the field.
   */
  signer?: { kind: "release"; kid: string; recordSha256: string } | null;
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
  /** `app`, `pack` or (F-03) `package`. */
  kind: string;
  /** The pack type, or a package's ecosystem; `null` for the app. */
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
  /** The binary update methods the device supports (`BINARY_METHODS`, `,`-separated). */
  methods?: string;
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
  /** A pack's floors per contentApi line on this channel (P4-12); absent for the app. */
  packFloors?: {
    contentApi: number;
    minSupported: string;
    modifiedAt: number;
    modifiedBy: string | null;
  }[];
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
  /**
   * A pack's floor for one contentApi line (P4-12): with `minSupported` (a version, or `null` to
   * clear) and `deliverable`, and nothing else.
   */
  contentApi?: number;
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
  /** Omitted: the tier's term (`policyExpiryDays` from now). `null`: no expiry. */
  expiresAt?: number | null;
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
  /** `null` clears it, so the product default applies (A-3). */
  maxOfflineDays?: number | null;
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
  /** How many tiers (baseline) and licenses (profile stack) point at it. */
  usedBy?: { tiers: number; licenses: number };
}
export interface ProfileDetail extends Omit<ProfileSummary, "usedBy"> {
  payload: RedactedPayload;
  /** The tiers and licenses that point at it; Delete is refused while either is non-empty. */
  usedBy?: {
    tiers: { id: string; label: string }[];
    licenses: { id: string; name?: string; email?: string }[];
  };
}

// ── catalog history and usage (A-6, A-7b) ─────────────────────────────────────
export interface CatalogVersionSummary {
  version: number;
  active: boolean;
  createdAt: number;
  entryCount: number;
  /** `admin`: published in the console; `manifest`: written by the product's `.pkey/schema`. */
  source: "admin" | "manifest";
  publishedBy: string | null;
}

/** What sets one catalog key: ids and names, never a value. */
export interface CatalogKeyUsage {
  profiles: { id: string; name: string }[];
  /** Tiers that inherit one of those profiles as their baseline. */
  tiers: { id: string; label: string; profile: string }[];
  licenses: { id: string; name: string | null; email: string | null }[];
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

/** A tier create or patch. On a patch, `null` clears a nullable field (A-3). */
export interface TierBody {
  id?: string;
  label?: string;
  profile?: string | null;
  policyExpiryDays?: number | null;
  policyDeviceLimit?: number | null;
  channels?: string[];
  minVersion?: string | null;
  maxVersion?: string | null;
}

// ── package feeds (F-11; worker `admin/handlers/feeds.ts`) ───────────────────────────

/** The six tier-1 ecosystems a package feed serves (`@polaris-key/manifest` PACKAGE_ECOSYSTEMS). */
export type FeedEcosystem =
  | "npm"
  | "pypi"
  | "swift"
  | "maven"
  | "oci"
  | "godot";

/** Why a feed does not answer, in the order the registry's access ladder checks it. */
export type FeedOffReason =
  | "platform-off"
  | "no-owner"
  | "distribution-off"
  | "package-feeds-off"
  | "not-set-up"
  | "feed-off";

export interface FeedSummary {
  ecosystem: FeedEcosystem;
  label: string;
  configured: boolean;
  enabled: boolean;
  accessMode: string;
  status: "enabled" | "off" | "unavailable";
  reason: FeedOffReason | null;
  packages: number;
  versions: number;
  lastPublishedAt: number | null;
  /** On the registry host; `null` when this deployment has no registry host configured. */
  baseUrl: string | null;
}

export interface PackageFeedsSwitch {
  enabled: boolean;
  /** 0 = never written. */
  version: number;
  updatedAt: number | null;
}

interface FeedsHead {
  scope: "platform" | "product";
  /** The owning product (the system product in platform scope); `null` before the bootstrap. */
  owner: string | null;
  ownerName: string | null;
  distributionEnabled: boolean;
  packageFeeds: PackageFeedsSwitch | null;
  registryOrigin: string | null;
}

export interface FeedsOverviewDto extends FeedsHead {
  feeds: FeedSummary[];
  summary: {
    feedsEnabled: number;
    packages: number;
    versions: number;
    lastPublishedAt: number | null;
  };
  /** Platform scope: every owner with a packageFeeds row. */
  owners?: {
    slug: string;
    name: string;
    system: boolean;
    packageFeeds: boolean;
  }[];
}

export interface FeedSettings {
  enabled: boolean;
  accessMode: string;
  namespace: Record<string, unknown>;
  maxPackageBytes: number;
  upstream: "none";
  ext: Record<string, unknown>;
  /** 0 = no row yet: the first save creates it. */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface FeedPolicy {
  enabled: boolean;
  maxPackageBytesCeiling: number;
  version: number;
  updatedAt: number;
  updatedBy: string | null;
}

/**
 * What one ecosystem's protocol can express: the feed adapter's declaration (worker
 * `services/distribution/registry/adapter.ts` `FeedCapabilities`), exposed on every feed and
 * package. Read it instead of switching on the ecosystem's name.
 */
export interface FeedCapabilities {
  yank: boolean;
  deprecate: boolean;
  yankPolicy: boolean;
  /** How Release channels surface: npm dist-tags, tags, only "latest", or not at all. */
  channels: "dist-tags" | "tags" | "latest" | "none";
  /** The protocol carries a package signature (the feed's `requireSigned` setting applies). */
  signing: boolean;
  immutableVersions: boolean;
  delete: boolean;
  search: boolean;
  /** The challenge a non-public feed answers an anonymous client with. */
  authChallenge: "basic" | "oci-bearer";
  /**
   * One entry per operation (`render`, `serve`, `auth`, `yank`, `unyank`, `deprecate`, `setup`),
   * in the shared adapter base's shape: `{mode: "api", …}` or `{mode: "unsupported", reason}`.
   */
  ops?: Record<string, { mode: string; reason?: string }>;
}

export interface FeedDetailDto extends FeedsHead {
  feed: FeedSummary;
  settings: FeedSettings;
  policy: FeedPolicy | null;
  capabilities: FeedCapabilities;
  /**
   * The extension settings (`settings.ext` keys) the feed's adapter accepts, which the ecosystem
   * panel renders (F-12); `yankHidesFromIndex` is the Yank policy section's and never listed.
   */
  extensions: string[];
  accessModes: { mode: string; available: boolean }[];
  /** F-21: the ecosystem's packages with no delivery gate, which `entitled` refuses every
   *  licence token for. */
  ungatedPackages?: { id: string; name: string }[];
}

// ── registry tokens (F-21; worker `admin/handlers/registryTokens.ts`) ────────────────────────

/** One registry token as the console lists it: never the plaintext or its hash. */
export interface RegistryTokenDto {
  tokenId: string;
  label: string;
  /** The token's last four characters. */
  hint: string;
  scopes: string[];
  /** `null` = every feed of the owner. */
  ecosystems: FeedEcosystem[] | null;
  binding: "owner" | "license";
  licenseId: string | null;
  presentation: "header" | "url";
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

export interface RegistryTokenFeed {
  ecosystem: FeedEcosystem;
  label: string;
  enabled: boolean;
  accessMode: string;
  baseUrl: string | null;
}

export interface RegistryTokensDto {
  owner: string;
  registryOrigin: string | null;
  /** The username clients send beside the token (`__token__`). */
  username: string;
  tokens: RegistryTokenDto[];
  feeds: RegistryTokenFeed[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    urlDefaultDays: number;
    perOwner: number;
    perLicense: number;
  };
}

export interface MintRegistryTokenBody {
  label: string;
  ecosystems?: FeedEcosystem[] | null;
  expiresInDays?: number;
  binding: "owner" | "license";
  licenseId?: string;
  presentation?: "header" | "url";
}

export interface MintedRegistryToken {
  ok: true;
  /** The plaintext: in this answer only. */
  token: string;
  view: RegistryTokenDto;
}

export interface FeedSettingsWrite {
  expectedVersion: number;
  enabled?: boolean;
  accessMode?: string;
  namespace?: Record<string, unknown>;
  maxPackageBytes?: number;
  ext?: Record<string, unknown>;
}

export interface FeedPolicyWrite {
  expectedVersion: number;
  enabled?: boolean;
  maxPackageBytesCeiling?: number;
}

export interface FeedTag {
  tag: string;
  channel: string;
  version: string;
}

export interface FeedPackageRow {
  owner: string;
  deliverableId: string;
  name: string;
  versions: number;
  liveVersions: number;
  latestVersion: string | null;
  lastPublishedAt: number | null;
  tags: FeedTag[];
}

export interface FeedPackagesPage {
  items: FeedPackageRow[];
  nextCursor: string | null;
}

export interface FeedPackageFile {
  name: string;
  type: string;
  size: number;
  sha256: string;
  sha512?: string;
  sha1?: string;
  md5?: string;
}

export interface FeedPackageVersion {
  version: string;
  releaseId: string;
  channel: string | null;
  tags: string[];
  state: "live" | "yanked" | "deprecated";
  stateMessage: string | null;
  publishedAt: number;
  source: {
    kind: "oidc" | "static" | "console" | "unknown";
    publisher: string | null;
    runUrl: string | null;
    tokenId: string | null;
  };
  size: number;
  files: FeedPackageFile[];
}

export interface FeedPackageDto {
  owner: string;
  ownerName: string;
  ecosystem: FeedEcosystem;
  deliverableId: string;
  name: string;
  baseUrl: string | null;
  capabilities: FeedCapabilities;
  tags: FeedTag[];
  versions: FeedPackageVersion[];
}

export type FeedVersionVerb = "yank" | "unyank" | "deprecate" | "undeprecate";

/** Which console scope a Feeds call is in: the platform's feeds, or one product's. */
export type FeedScope =
  | { kind: "platform" }
  | { kind: "product"; slug: string };

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

/** The Feeds API base of a scope (F-11). */
const feedsBase = (scope: FeedScope): string =>
  scope.kind === "platform"
    ? "/manage/api/platform/feeds"
    : `${p(scope.slug)}/distribution/feeds`;

/** One package: `:owner/:name` in platform scope, `:name` in product scope. */
const feedPackagePath = (
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
): string =>
  scope.kind === "platform"
    ? `${feedsBase(scope)}/${eco}/packages/${enc(owner)}/${enc(name)}`
    : `${feedsBase(scope)}/${eco}/packages/${enc(name)}`;

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
  /** The self-reported Operations snapshot (A-14): probes, queues, cron runs, storage, connectors. */
  platformOperations: () =>
    call<PlatformOperations>("/manage/api/platform/operations"),
  /** `platform_audit`, newest first (keyset `cursor`). */
  platformActivity: (cursor?: PlatformCursor | null) =>
    call<PlatformActivityPage>(
      `/manage/api/platform/activity${cursorQuery(cursor)}`,
    ),
  /** The runtime settings, the read-only inventory, secrets presence and the warnings (A-13). */
  platformSettings: () =>
    call<PlatformSettingsView>("/manage/api/platform/settings"),
  /** The reserved entitlement names and the products that declare one (LX-05). */
  platformReservedNames: () =>
    call<PlatformReservedNames>("/manage/api/platform/reserved-names"),
  /** Store a runtime value; 409 `version_conflict` when the row moved past `expectedVersion`. */
  patchPlatformSetting: (key: string, body: PlatformSettingWrite) =>
    call<PlatformSetting>(`/manage/api/platform/settings/${enc(key)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Drop the runtime value: back to the deploy var or the code default (version-guarded). */
  revertPlatformSetting: (key: string, expectedVersion: number) =>
    call<PlatformSetting>(
      `/manage/api/platform/settings/${enc(key)}?expectedVersion=${expectedVersion}`,
      { method: "DELETE" },
    ),
  /** The KEK keyring: active kid, the ring, per-kid counts. 503 when the ring does not parse. */
  platformKek: () => call<PlatformKekStatus>("/manage/api/products/kek"),
  /** Every store's team credential (presence and metadata only), settings and assignments. */
  platformStoreConnections: () =>
    call<{ stores: PlatformStoreConnection[] }>(
      "/manage/api/platform/store-connections",
    ),
  /**
   * The apps a store's team credential can see. `refresh` reads the store again instead of the
   * minute-long cache; `tracks` adds Play's track status (it opens and deletes an edit per app,
   * so only on an explicit opt-in).
   */
  platformStoreApps: (
    store: PlatformStore,
    opts: { refresh?: boolean; tracks?: boolean } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.refresh === true) q.set("refresh", "1");
    if (opts.tracks === true) q.set("tracks", "1");
    const qs = q.toString();
    return call<PlatformStoreApps>(
      `/manage/api/platform/store-connections/${enc(store)}/apps${qs ? `?${qs}` : ""}`,
    );
  },
  /** Assign a store app to a product: its pin on the team credential (and its own keys' re-pin). */
  assignPlatformStoreApp: (
    store: PlatformStore,
    appId: string,
    product: string,
  ) =>
    call<PlatformStoreAssignResult>(
      `/manage/api/platform/store-connections/${enc(store)}/apps/${enc(appId)}/product`,
      { method: "PUT", body: JSON.stringify({ product }) },
    ),
  /**
   * Release a store app from the product holding it. `heldBy` is not sent (the Worker finds the
   * holder itself): it names the product whose connector state the release makes stale.
   */
  releasePlatformStoreApp: (
    store: PlatformStore,
    appId: string,
    heldBy: string,
  ) => {
    void heldBy;
    return call<PlatformStoreReleaseResult>(
      `/manage/api/platform/store-connections/${enc(store)}/apps/${enc(appId)}/product`,
      { method: "DELETE" },
    );
  },

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
  // ── Keys & secrets (chunk 5): inventories and the signing-key lifecycle ─────
  /** A-4: every signing key with its lifecycle state. */
  productKeys: (slug: string) => call<SigningKeysResponse>(`${p(slug)}/keys`),
  /** Promote a staged key. `breakGlass` skips the trust-cache window. */
  activateProductKey: (slug: string, kid: string, breakGlass = false) =>
    call<{ ok: true; kid: string; status: "active" }>(
      `${p(slug)}/keys/activate`,
      {
        method: "POST",
        body: JSON.stringify(breakGlass ? { kid, breakGlass } : { kid }),
      },
    ),
  retireProductKey: (slug: string, kid: string) =>
    call<{ ok: true; kid: string; status: "retired" }>(
      `${p(slug)}/keys/retire`,
      { method: "POST", body: JSON.stringify({ kid }) },
    ),
  revokeProductKey: (slug: string, kid: string) =>
    call<{ ok: true; kid: string; status: "revoked" }>(
      `${p(slug)}/keys/revoke`,
      { method: "POST", body: JSON.stringify({ kid }) },
    ),
  /** A-5: secret names, usage and what requires each. Never a value. */
  productSecrets: (slug: string) =>
    call<{ secrets: ProductSecretDto[] }>(`${p(slug)}/secrets`),
  ciPublisher: (slug: string) =>
    call<{ ok: true; policy: PublisherPolicyDto | null }>(
      `${p(slug)}/ci-publisher`,
    ),
  /** Claims the policy from the manifest (`source` becomes `admin`). */
  putCiPublisher: (slug: string, body: PublisherClaimBody) =>
    call<{ ok: true; policy: PublisherPolicyDto }>(`${p(slug)}/ci-publisher`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  ciTokens: (slug: string) =>
    call<{ ok: true; tokens: CiTokenDto[] }>(`${p(slug)}/ci-tokens`),
  /** The token is in this response once and never again. */
  issueCiToken: (slug: string, body: IssueCiTokenBody) =>
    call<IssuedCiToken>(`${p(slug)}/ci-tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeCiToken: (slug: string, tokenId: string) =>
    call<{ ok: true; tokenId: string; revokedAt: number }>(
      `${p(slug)}/ci-tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    ),
  /** The blob collector's dry run: what would be dropped, and when. Read-only. */
  blobGc: (slug: string) => call<BlobGcDryRun>(`${p(slug)}/blob-gc`),

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
    body: {
      mode: ReleaseAccess;
      deliverable?: string;
      /** A pack's delivery gate, for `entitled`: the catalog flag a license must grant (`null` clears it). */
      entitlement?: string | null;
    },
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

  /** Start a rollout, or set its percentage (`bp`, 0–10 000) — the admin rollout route. */
  setRollout: (
    slug: string,
    outlet: string,
    channel: string,
    body: { deliverable: string; releaseId: string; bp: number },
  ) =>
    call<{ rollout: Rollout }>(
      `${p(slug)}/distribution/rollouts/${encodeURIComponent(outlet)}/${encodeURIComponent(channel)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // ── distribution: readiness (P4-14) ─────────────────────────────────────────
  /** Recompute every app release's readiness on every outlet. */
  refreshReadiness: (slug: string) =>
    call<ReadinessRefreshResult>(`${p(slug)}/distribution/readiness/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Release a readiness hold on one outlet, with the reason (audited). */
  overrideReadiness: (
    slug: string,
    appReleaseId: string,
    outletId: string,
    reason: string,
  ) =>
    call<{ appReleaseId: string; readiness: MatrixReadinessDto | null }>(
      `${p(slug)}/distribution/readiness/${enc(appReleaseId)}/${enc(outletId)}/override`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  /** Clear an override: the hold is computed again. */
  clearReadinessOverride: (
    slug: string,
    appReleaseId: string,
    outletId: string,
  ) =>
    call<{ appReleaseId: string; readiness: MatrixReadinessDto | null }>(
      `${p(slug)}/distribution/readiness/${enc(appReleaseId)}/${enc(outletId)}/clear`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // ── distribution: outlets and capabilities (P2b-02) ─────────────────────────
  distributionOutlets: (slug: string) =>
    call<OutletsResponse>(`${p(slug)}/distribution/outlets`),
  /** Narrow an outlet's capabilities below its kind's default (never wider). */
  narrowOutletCapabilities: (
    slug: string,
    outletId: string,
    capabilities: Partial<OutletCapabilitiesDto>,
  ) =>
    call<{ outlet: OutletDto }>(
      `${p(slug)}/distribution/outlets/${enc(outletId)}/capabilities`,
      { method: "PUT", body: JSON.stringify({ capabilities }) },
    ),
  /** Return an outlet's capabilities to its kind's default. */
  revertOutletCapabilities: (slug: string, outletId: string) =>
    call<{ outlet: OutletDto }>(
      `${p(slug)}/distribution/outlets/${enc(outletId)}/capabilities/revert`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // ── distribution: the signing-key inventory (P2b-03) ────────────────────────
  distributionKeys: (slug: string) =>
    call<DistributionKeysResponse>(`${p(slug)}/distribution/keys`),
  putDistributionKey: (slug: string, body: PutDistributionKeyBody) =>
    call<DistributionKeysResponse & { key: DistributionKeyDto }>(
      `${p(slug)}/distribution/keys`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Remove an inventory entry, or dismiss a CI observation. */
  deleteDistributionKey: (slug: string, purpose: string, sha256: string) =>
    call<DistributionKeysResponse>(
      `${p(slug)}/distribution/keys/${enc(purpose)}/${enc(sha256)}`,
      { method: "DELETE" },
    ),

  // ── distribution: store connectors (P5-02 to P5-04) ─────────────────────────
  connectors: (slug: string) =>
    call<ConnectorsResponse>(`${p(slug)}/distribution/connectors`),
  /**
   * One connector control (`phased-release/pause`, `rollout/fraction`, `settings`, …). The App
   * Store Connect flows (A-17c to A-17e) also take `idempotencyKey`, one per operator intent: the
   * Worker's ledger answers a retry under the same key from what it already did.
   */
  connectorControl: (
    slug: string,
    connector: string,
    control: string,
    body: Record<string, unknown>,
    opts?: { idempotencyKey?: string } | null,
  ) =>
    call<Record<string, unknown> & { ok: true }>(
      `${p(slug)}/distribution/connectors/${enc(connector)}/${control
        .split("/")
        .map(enc)
        .join("/")}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    ),
  /** One connector read (`distribute/builds`, `iap/products`, …; A-17d, A-17e). */
  connectorRead: <T>(
    slug: string,
    connector: string,
    path: string,
    query?: Record<string, string> | null,
  ) => {
    const qs = new URLSearchParams(query ?? {}).toString();
    return call<T>(
      `${p(slug)}/distribution/connectors/${enc(connector)}/${path
        .split("/")
        .map(enc)
        .join("/")}${qs ? `?${qs}` : ""}`,
    );
  },

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
  /**
   * Publish a new catalog version. `expectedVersion` is the version the draft started from (`0`
   * for a first publish): when another publish landed since, the server answers 409
   * `catalog_version_conflict` instead of overwriting it (ADMIN.md A-6).
   */
  publishSchema: (
    slug: string,
    catalog: ProductCatalog,
    expectedVersion?: number,
  ) =>
    call<{ ok: true; schemaVersion: number }>(`${p(slug)}/config/catalog`, {
      method: "PUT",
      body: JSON.stringify(
        expectedVersion === undefined
          ? { catalog }
          : { catalog, expectedVersion },
      ),
    }),
  /** Every published catalog version, newest first (A-6). */
  catalogVersions: (slug: string) =>
    call<{ versions: CatalogVersionSummary[] }>(
      `${p(slug)}/config/catalog/versions`,
    ),
  /** One catalog version, active or not (A-6). */
  catalogVersion: (slug: string, version: number) =>
    call<ProductCatalog>(`${p(slug)}/config/catalog/versions/${version}`),
  /** The profiles, tiers and licenses that set each key (A-7b). */
  catalogUsage: (slug: string, keys: readonly string[]) =>
    call<{ keys: Record<string, CatalogKeyUsage> }>(
      `${p(slug)}/config/catalog/usage?${([] as string[])
        .concat(keys)
        .map((k) => `key=${enc(k)}`)
        .join("&")}`,
    ),

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
  /** Edit a profile's name and description (A-7); `description: null` clears it. */
  patchProfile: (
    slug: string,
    id: string,
    body: { name?: string; description?: string | null },
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
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

  // ── package feeds (F-11), both scopes ───────────────────────────────────────────
  feedsOverview: (scope: FeedScope) => call<FeedsOverviewDto>(feedsBase(scope)),
  feedDetail: (scope: FeedScope, eco: FeedEcosystem) =>
    call<FeedDetailDto>(`${feedsBase(scope)}/${eco}`),
  /** 409 `version_conflict` when the feed moved past `expectedVersion` (0 creates the row). */
  saveFeedSettings: (
    scope: FeedScope,
    eco: FeedEcosystem,
    body: FeedSettingsWrite,
  ) =>
    call<{ ok: true; settings: FeedSettings }>(
      `${feedsBase(scope)}/${eco}/settings`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Platform scope only: the ecosystem's kill switch and size ceiling. */
  saveFeedPolicy: (eco: FeedEcosystem, body: FeedPolicyWrite) =>
    call<{ ok: true; policy: FeedPolicy }>(
      `/manage/api/platform/feeds/${eco}/policy`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  feedPackages: (
    scope: FeedScope,
    eco: FeedEcosystem,
    query: { q?: string; owner?: string; cursor?: string | null } = {},
  ) => {
    const search = new URLSearchParams();
    if (query.q) search.set("q", query.q);
    if (query.owner) search.set("owner", query.owner);
    if (query.cursor) search.set("cursor", query.cursor);
    const qs = search.toString();
    return call<FeedPackagesPage>(
      `${feedsBase(scope)}/${eco}/packages${qs ? `?${qs}` : ""}`,
    );
  },
  feedPackage: (
    scope: FeedScope,
    eco: FeedEcosystem,
    owner: string,
    name: string,
  ) => call<FeedPackageDto>(feedPackagePath(scope, eco, owner, name)),
  feedVersionAction: (
    scope: FeedScope,
    eco: FeedEcosystem,
    owner: string,
    name: string,
    version: string,
    verb: FeedVersionVerb,
    body: { reason?: string; message?: string } = {},
  ) =>
    call<{ ok: true; state: FeedPackageVersion["state"] }>(
      `${feedPackagePath(scope, eco, owner, name)}/versions/${enc(version)}/${verb}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  rebuildFeed: (scope: FeedScope, eco: FeedEcosystem) =>
    call<{ ok: true; queued: number }>(`${feedsBase(scope)}/${eco}/rebuild`, {
      method: "POST",
    }),
  feedActivity: (scope: FeedScope, eco: FeedEcosystem) =>
    call<{ items: ActivityItem[] }>(`${feedsBase(scope)}/${eco}/activity`),
  /** F-21: the scope's registry tokens (or one licence's), with its feeds for the snippets. */
  registryTokens: (scope: FeedScope, licenseId?: string) =>
    call<RegistryTokensDto>(
      `${feedsBase(scope)}/tokens${licenseId ? `?license=${enc(licenseId)}` : ""}`,
    ),
  mintRegistryToken: (scope: FeedScope, body: MintRegistryTokenBody) =>
    call<MintedRegistryToken>(`${feedsBase(scope)}/tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeRegistryToken: (scope: FeedScope, tokenId: string) =>
    call<{ ok: true; view: RegistryTokenDto }>(
      `${feedsBase(scope)}/tokens/${enc(tokenId)}/revoke`,
      { method: "POST" },
    ),
  revokeAllRegistryTokens: (scope: FeedScope, licenseId?: string) =>
    call<{ ok: true; revoked: number }>(
      `${feedsBase(scope)}/tokens/revoke-all`,
      {
        method: "POST",
        body: JSON.stringify(licenseId ? { licenseId } : {}),
      },
    ),
  /** Create (or re-assert) the system product that owns the platform's feeds (F-03). */
  bootstrapPlatformFeeds: () =>
    call<{ ok: true; slug: string; created: boolean }>(
      "/manage/api/platform/feeds/bootstrap",
      { method: "POST" },
    ),
  packageFeeds: (slug: string) =>
    call<{ packageFeeds: PackageFeedsSwitch }>(
      `${p(slug)}/distribution/package-feeds`,
    ),
  /** 409 `version_conflict` when the switch moved past `expectedVersion` (0 = never written). */
  savePackageFeeds: (
    slug: string,
    body: { enabled: boolean; expectedVersion: number },
  ) =>
    call<{ ok: true; packageFeeds: PackageFeedsSwitch }>(
      `${p(slug)}/distribution/package-feeds`,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  // ── activity (keyset) ─────────────────────────────────────────────────────────
  activity: (
    slug: string,
    cursor?: ActivityCursor | null,
    limit = 50,
    filters: ActivityFilters = {},
  ) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      search.set("beforeAt", String(cursor.beforeAt));
      search.set("beforeId", cursor.beforeId);
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
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
