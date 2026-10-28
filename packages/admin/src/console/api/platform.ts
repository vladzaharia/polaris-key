/**
 * The platform slice of the console API (P0-32.20): identity, members, platform, admin tokens,
 * alerts, platform settings, operations, connections and store connections. Types and the
 * `platformApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { ActivityFilters } from "./activity.js";
import { call, enc, p } from "./transport.js";

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
  /**
   * The customer site's origin (`https://polaris.locker`) when the worker has one (LK-17); the
   * console hands an old portal hash to it. `null`/absent otherwise.
   */
  customerOrigin?: string | null;
  /**
   * ST-30: the identity-provider subject this member's older records carry (before the console
   * named actors by member id), so "you" still reads on them. Empty on a v1 session.
   */
  priorSubs?: string[];
  /** When the operator last signed in interactively (I-12 step-up); `null` on an older session. */
  authAt?: number | null;
  /** How recent that sign-in must be for a step-up action (the relink tool). */
  stepUpMaxAgeSeconds?: number;
  /**
   * ST-29: what the worker's `can()` allows this member, which `useCan` reads (never decides).
   * Absent from a worker older than ST-29: the console then treats `platformAdmin` as every area.
   */
  permissions?: MePermissions;
  /**
   * ST-30c.1: a break-glass session (`/manage/login?breakGlass=1`): an hour, no account behind it.
   * The shell warns, and the account-bound screens stay out of reach (the server refuses them).
   */
  breakGlass?: boolean;
  /**
   * LK-FU-2: the operator's own preferences, kept on the server so they follow them across
   * browsers. Absent from an older worker: the console then keeps them in this browser.
   */
  prefs?: { setupGuideHidden: boolean };
  /** Whether the worker can send email (an `EMAIL` binding); absent from an older worker (read as on). */
  emailOn?: boolean;
}

/** The console's authorization areas (worker `core/rbac/areas.ts`; append-only). */
export type AreaId =
  | "console"
  | "platform"
  | "members"
  | "docs"
  | "core"
  | "license"
  | "config"
  | "ship"
  | "signin"
  | "sync"
  | "commerce"
  | "keys"
  | "settings"
  | "connect";

/** The areas allowed at each level in one scope. */
export interface AreaLevels {
  view: AreaId[];
  edit: AreaId[];
}

/** One role the member holds. `scope` is `platform`, `products:*` or `product:<slug>`. */
export interface MeRole {
  role: "superadmin" | "platform_admin" | "product_admin" | "console_access";
  scope: string;
  /** `null`: every area. */
  areas: AreaId[] | null;
  source: string;
}

export interface MePermissions {
  roles: MeRole[];
  platform: AreaLevels;
  /** Per product the member can see, by slug. */
  products: Record<string, AreaLevels>;
}

/** Someone who can give access to an area (NoAccessPage, a disabled control's reason). */
export interface AccessAdmin {
  name: string;
  email: string;
  role: "superadmin" | "product_admin";
}

export interface AccessAdmins {
  scope: string;
  area: AreaId;
  admins: AccessAdmin[];
}

// ── members (ST-31.4 to 31.7: Platform → Members) ─────────────────────────────────

/** One role a member holds, with where it came from (`GET /members`). */
export interface MemberRole {
  role: MeRole["role"];
  scope: string;
  /** `null`: every area. */
  areas: AreaId[] | null;
  /** `root` (computed; no binding), `grant`, `invite` or `creator`. */
  source: "root" | "grant" | "invite" | "creator";
  /** The binding to revoke; `null` for the root rule. */
  bindingId: string | null;
  /** `null`: the system or the root rule; `{ name: null }`: someone who is no longer a member. */
  grantedBy: { name: string | null } | null;
  grantedAt: number | null;
}

export interface Member {
  memberId: string;
  name: string;
  email: string;
  lastSignInAt: number | null;
  disabled: boolean;
  you: boolean;
  roles: MemberRole[];
}

export interface MemberInvite {
  bindingId: string;
  email: string;
  role: MeRole["role"];
  scope: string;
  areas: AreaId[] | null;
  invitedBy: { name: string | null } | null;
  sentAt: number;
  expiresAt: number | null;
}

export interface MembersView {
  rootRule: { group: string | null };
  /** A cap cut the roster: say so. */
  truncated: boolean;
  /** Some account was left out because the erasure ledger was unreadable. */
  incomplete: boolean;
  members: Member[];
  invites: MemberInvite[];
}

/** The grant a write names. `areas: null` is every area. */
export interface GrantBody {
  role: MeRole["role"];
  scope: string;
  areas: AreaId[] | null;
  /** `L2` for a Superadmin, Platform admin or All products grant. */
  confirm?: "L2";
}

export type InviteStatus =
  | "invited"
  | "updated"
  | "merged"
  | "invalid"
  | "exists";

export interface MemberInviteOutcome {
  email: string;
  status: InviteStatus;
  bindingId?: string;
  expiresAt?: number;
  needsOperatorSignIn?: boolean;
  emailed?: boolean;
  /** The sign-in link, only when the mail did not go out. */
  link?: string;
}

export interface InviteResult {
  ok: true;
  results: MemberInviteOutcome[];
  counts: Record<InviteStatus, number>;
  emailOff: boolean;
  notified: { sent: number; of: number; nobodyNotified: boolean };
}

/** A person or address that reaches a product from above (`GET /products/:slug/members`). */
export interface ProductPlatformRole {
  memberId: string;
  name: string;
  email: string;
  role: MeRole["role"];
  /** `platform` (a Superadmin) or `products:*`. */
  scope: string;
  areas: AreaId[] | null;
  source: "root" | "grant" | "invite" | "creator" | "rule";
}

/** `GET /products/:slug/members`, shaped like the platform roster: this product's roles only. */
export interface ProductMembersView {
  product: string;
  truncated: boolean;
  incomplete: boolean;
  members: Member[];
  invites: MemberInvite[];
  platformRoles: ProductPlatformRole[];
}

// ── platform (A-11 deploy identity, A-12 platform audit) ─────────────────────────

/** Cloudflare's own record of the running version (the version metadata binding). */
export interface PlatformCloudflareVersion {
  id: string;
  tag: string | null;
  /** ISO 8601, as Cloudflare reports it. */
  uploadedAt: string | null;
}

/** `GET /manage/api/platform/version` (worker `core/ops/deployIdentity.ts`). */
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
  /**
   * The product the event belongs to; `null` for a platform event. Only a read that names a
   * `product` can return product events: without one the feed is the platform's alone.
   */
  product?: string | null;
  actor: { sub: string; name: string; email: string };
  action: string;
  target: { kind: string; id: string } | null;
  summary: string;
  before: unknown;
  after: unknown;
}

/** The platform feed's filters: a product feed's, plus which trails to read (ST-51). */
export interface PlatformActivityFilters extends ActivityFilters {
  /** `all` (every product and the platform), `platform`, or a product slug. */
  product?: string;
  /** One event, by id (a deep link to its drawer). */
  id?: string;
}

export interface PlatformActivityPage {
  items: PlatformActivityItem[];
  nextCursor: PlatformCursor | null;
}

// ── admin API tokens (platform) ───────────────────────────────────────────────
/**
 * The admin API's MACHINE credential (`pkeya_…`; worker `console/apiTokens.ts`).
 *
 * Platform-scoped like the platform pages rather than per-product, and reachable only by a
 * SESSION: the worker names no scope for these three routes, so a token principal cannot list,
 * mint or revoke a token, including itself. Minting a credential is an interactive act, and the
 * mint also needs a recent sign-in (403 `step_up_required`).
 */

/** The scope vocabulary, mirroring the worker's. */
export const ADMIN_API_SCOPES = ["bundles:mint", "migrations:report"] as const;
export type AdminApiScope = (typeof ADMIN_API_SCOPES)[number];

/** The worker's longest token lifetime. Mirrored so the mint form can bound its input rather
 *  than teaching the operator the ceiling through a 422. */
export const MAX_TOKEN_DAYS = 365;

/** The lifecycle the SERVER collapsed out of `revokedAt` and `expiresAt`. Never re-derived here:
 *  the console would be re-deriving it against the browser's clock, not the worker's. */
/** A person's `pkeyp_` token as a Superadmin lists it (F-33): never the token or its hash. */
export interface AdminPersonalToken {
  id: string;
  /** The account's primary email; `null` once erased. */
  email: string | null;
  label: string;
  /** The token's last four characters. */
  hint: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

/** One of the signed-in member's own `pkeyp_` tokens (ST-34.4): either scope; no owner, no revoker. */
export interface OwnPersonalToken {
  id: string;
  /** The label; a token `pkey login` made reads "pkey on <host>". */
  label: string;
  /** The token's last four characters. */
  hint: string;
  scope: "admin" | "packages:read";
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

/** One of the signed-in operator's own sign-in methods (ST-30c.3, `GET /me/methods`). */
export interface ConsoleMethod {
  id: string;
  /** `passkey`, `oidc`, `email`, …; the Worker's link kind. */
  kind: string;
  /** The passkey's name, or the linked address; `null` when it has none. */
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** Opens the console (SM-3). */
  strong: boolean;
  /** A passkey added under the console's relying party that "Use for the console" may mark. */
  consoleEligible: boolean;
  /** A passkey's authenticator model (AAGUID), as I-16 stored it; `null` for other kinds. */
  aaguid: string | null;
  /** The browser a passkey was added from, as I-16 stored it; `null` for other kinds. */
  addedFrom: string | null;
}

export type AdminApiTokenStatus = "active" | "expired" | "revoked";

/**
 * A token as the roster shows it. Note what is absent: the plaintext AND the hash. The plaintext
 * exists in exactly one response ever (`MintAdminApiTokenResult.secret`) and nothing stored can
 * reproduce it; the hash is withheld so nobody mistakes it for an id. There is therefore no field
 * on this type a list view could render a secret from.
 */
export interface AdminApiToken {
  id: string;
  label: string;
  scopes: AdminApiScope[];
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: AdminApiTokenStatus;
}

export interface MintAdminApiTokenBody {
  label: string;
  /** REQUIRED, 1 to `MAX_TOKEN_DAYS`. The server has no default, deliberately: a machine
   *  credential's lifetime is the one decision the operator has to make consciously. */
  expiresInDays: number;
  /** Omitted means every scope the worker knows about; the console always names them. */
  scopes?: AdminApiScope[];
}

export interface MintAdminApiTokenResult {
  ok: true;
  token: AdminApiToken;
  /**
   * The plaintext (`pkeya_…`): the ONLY response that will ever carry it. The mint dialog is the
   * only thing that ever holds this string, in a component that unmounts on close.
   */
  secret: string;
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
  /** ST-16: `default`: products that set none inherit it; `bound`: it clamps products. */
  link?: "default" | "bound" | null;
  /** ST-16: what the setting reaches at rest (linked rows only). */
  fleet?: PlatformFleet;
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
  unit: "bytes" | "days" | "count";
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

/** A list of short terms (PX-W13c: `identity.reservedDisplayTerms`). */
export interface PlatformListSetting extends PlatformSettingBase {
  kind: "list";
  /** At most this many terms, each at most `maxLength` characters. */
  max: number;
  maxLength: number;
  default: string[];
  value: string[];
  confirm: { change: PlatformConfirmLevel };
}

export type PlatformSetting =
  | PlatformSwitchSetting
  | PlatformIntegerSetting
  | PlatformChoiceSetting
  | PlatformListSetting;

/** `GET /manage/api/platform/reserved-names` (LX-05, worker `console/handlers/reservedNames.ts`). */
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

/** One product a change reaches: its effective value before and after. */
export interface PlatformReachProduct {
  product: string;
  name: string;
  from: unknown;
  to: unknown;
  /** The product sets no value of its own. */
  inherited: boolean;
}

/**
 * `GET /manage/api/platform/settings/:key/reach?value=` (ST-16, worker
 * `console/handlers/platformReach.ts`): the products whose effective value changes when the
 * platform value goes from `from` to `to`.
 */
export interface PlatformReach {
  kind: "default" | "bound";
  direction: "lower" | "raise" | "none";
  total: number;
  reaches: number;
  from: unknown;
  to: unknown;
  /** Up to five. */
  products: PlatformReachProduct[];
}

/** What a linked row reaches at rest, sent with the settings list (so never stale). */
export type PlatformFleet =
  | {
      kind: "bound";
      total: number;
      count: number;
      products: {
        product: string;
        name: string;
        set: unknown;
        effective: unknown;
        inherited: boolean;
      }[];
    }
  | {
      kind: "default";
      total: number;
      inheriting: number;
      own: { product: string; name: string; value: unknown }[];
    };

/** `GET /manage/api/platform/settings` (worker `console/handlers/platformSettings.ts`). */
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
  constants: {
    name: string;
    /** The group the Limits section files it under. */
    area: string;
    label: string;
    help: string;
    value: number;
    unit: string;
  }[];
  warnings: { code: string; message: string; names: string[] }[];
}

/** `PATCH /manage/api/platform/settings/<key>`. `confirm` echoes the key for an L2+ change. */
export interface PlatformSettingWrite {
  value: string | number | string[];
  expectedVersion: number;
  confirm?: string;
  /** Why (a critical setting needs one; the Worker records it in the trail). */
  reason?: string;
}

/** `GET /manage/api/products/kek`: the keyring (kid names and per-kid counts, never key material). */
export interface PlatformKekStatus {
  ok: true;
  active: string;
  kids: string[];
  /** Sealed-value group → kid → count. */
  counts: Record<string, Record<string, number>>;
  /**
   * Values not yet sealed under `active`. A FLOOR, not a total, while `countsComplete` is false
   * (at least 1 then): the scan stopped before it had looked at every row.
   */
  remaining: number;
  /** Values under a kid that is no longer in the ring. A floor while `countsComplete` is false. */
  unopenable: number;
  /**
   * False when the managed-payload scan stopped at its row cap, so every count above is a floor
   * and none of them may be read as "nothing left". `countsTruncated` names the tables.
   */
  countsComplete: boolean;
  /** The tables whose scan stopped at the cap; empty when `countsComplete`. */
  countsTruncated: string[];
  /**
   * Present only while `PLATFORM_KEK` is set beside `PLATFORM_KEK_KEYS`: the legacy key, kept for
   * opening only (RUNBOOK "Rotating when the old KEK is unknown").
   */
  legacy?: {
    kid: string;
    /** False when `PLATFORM_KEK_KEYS` holds the same key under the same kid. */
    openOnly: boolean;
    /** Stored values still sealed under the legacy kid; the sweep brings this to 0. */
    remaining: number;
    /** Sealed Worker secrets still under the legacy kid; re-sealed by hand (`signin:seal`). */
    workerSecrets: string[];
    /** Whether deleting `PLATFORM_KEK` leaves nothing unopenable. */
    safeToDelete: boolean;
  };
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

/** `GET /manage/api/platform/operations` (worker `core/ops/operations.ts`). A section is `null` when it could not be read. */
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
  /** One row per opt-in service; `null` when it could not be read. */
  services:
    | {
        slug: string;
        /** Live products that run the service. */
        productsEnabled: number;
        /** The newest failed cron step in the service's family (`at` is epoch milliseconds). */
        lastError: { step: string; at: number; error: string | null } | null;
      }[]
    | null;
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

// ── platform connections (I-31; worker `console/handlers/platformConnections.ts`) ──────────────

/** One email domain a connection claims. `record` is what to publish in DNS (not a secret). */
export interface ConnectionDomain {
  domain: string;
  verified: boolean;
  verifiedAt: number | null;
  checkedAt: number | null;
  enforce: boolean;
  record: { name: string; value: string };
}

export interface ClaimMapDto {
  groups?: string;
  claims?: string[];
  name?: string;
  picture?: string;
  birthdate?: string;
}

/** A platform connection. A client secret is never in it: `hasSecret` says only whether one is sealed. */
export interface PlatformConnection {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  jwksUri: string | null;
  audience: "customers" | "operators" | "both";
  claimMap: ClaimMapDto;
  status: "active" | "disabled";
  source: "env" | "console" | "manifest";
  hasSecret: boolean;
  domains: ConnectionDomain[];
  /** People who sign in through it. */
  links: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface PlatformConnectionsPage {
  connections: PlatformConnection[];
  /** The primary redirect URI to register at every provider. */
  redirectUri: string;
  /** Every address a person may sign in at: Polaris Locker first when set, then the console. */
  redirectUris?: { site: "locker" | "console"; label: string; value: string }[];
  builtIns: {
    kind: "google" | "apple" | "steam";
    label: string;
    configured: boolean;
    /** What to register at the provider: one exact URI, or (Steam) the realm. */
    registration: { kind: "redirect-uri" | "realm"; value: string };
    /** One per place a person may sign in (Polaris Locker first when set). */
    registrations?: {
      site: "locker" | "console";
      label: string;
      kind: "redirect-uri" | "realm";
      value: string;
    }[];
  }[];
  email: { configured: boolean };
  turnstile: { enabled: boolean };
}

/** What the add wizard sends. `clientSecret` goes in once and is sealed. */
export interface ConnectionBody {
  label?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  jwksUri?: string | null;
  claimMap?: ClaimMapDto;
  status?: "active" | "disabled";
}

export interface ConnectionDiscovery {
  issuer: string;
  authorizationHost: string;
  tokenHost: string;
  jwksHost: string;
  redirectUri: string;
  issParameter: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Plain text. */
  message?: string;
  preview?: {
    issuer: string;
    email: string | null;
    emailVerified: boolean | null;
    name: string | null;
    groups: string[] | null;
    claims: Record<string, string> | null;
    claimNames: string[];
  };
}

// ── platform store connections (A-16; worker `console/handlers/platformStoreConnections.ts`) ──

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
  /** A-18j: the store has a storefront adapter, so an assigned app offers "Set up". */
  storefront?: boolean;
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

/**
 * The live credential check's answer (UX-69, SETUP.md D42; worker
 * `services/distribution/connectors/credentialCheck.ts`). What the store found with the unsaved
 * value, in words; never the value itself.
 */
export interface CredentialCheck {
  verdict: "valid" | "warning" | "invalid" | "unavailable" | "unchecked";
  reason:
    | "ok"
    | "format"
    | "rejected"
    | "expired"
    | "expiring"
    | "permission"
    | "wrong-account"
    | "not-found"
    | "rate-limited"
    | "store-down"
    | "not-checkable";
  /** One line: what was found ("Team 69a6de7f · 3 apps") or what is wrong. */
  title: string;
  /** The fix, or what a warning means. */
  detail: string | null;
  /** What the store reported: the account, the app count, scopes, expiry. */
  facts: { label: string; value: string }[];
  /** The form field a field-specific failure belongs to (`value.p8`, `value.clientSecret`). */
  field?: string;
  /** The store's HTTP status when it refused or failed. */
  status?: number;
}

/** `POST …/store-connections/<store>[/credentials/<slot>]/check`. */
export interface PlatformStoreCheckResult {
  id: string;
  check: CredentialCheck;
}

/** `PUT …/store-connections/<store>[/credentials/<slot>]`: metadata only, never the value. */
export interface PlatformStoreCredentialSaved {
  id: string;
  source: "console";
  meta: Record<string, string>;
}

/** `POST …/distribution/storefronts/<id>/ci-secrets/<name>/check`. */
export interface CiSecretCheckResult {
  storefront: string;
  name: string;
  check: CredentialCheck;
}

// ── products (platform registry) ──────────────────────────────────────────────
export type ProductReleaseSource = "manual" | "github" | (string & {});

export interface ProductSigningBundle {
  kid?: string;
  alg?: string;
  publicKey?: string;
  publicKeyPem?: string;
  jwksUrl?: string;
  jwks?: unknown;
  trustKeys?: Record<string, string>;
}

// ── edge-mint recipe approval (Config, P0-12) ────────────────────────────────

/** What a product secret may be used for. Set by an operator only — never by a manifest. */
export type SecretUsage = "general" | "edge-mint";

// ── alert destinations (ST-27) ───────────────────────────────────────────────
/** The alert kinds a destination can take (worker `core/notify/alertDestinations.ts`). */
export type AlertKindId =
  | "auto_halt"
  | "store_connection"
  | "commerce"
  | "access_changed"
  | "notifications_failing";

/** Which console scope an alert-destination call is in. */
export type AlertScope =
  | { kind: "platform" }
  | { kind: "product"; slug: string };

/**
 * One destination as the API shows it. `target` is the address, or `https://host/…` for a
 * webhook: the URL and the signing secret are sealed on the Worker and never come back.
 */
export interface AlertDestination {
  id: string;
  scope: string;
  kind: "email" | "webhook";
  target: string;
  label: string | null;
  alerts: AlertKindId[];
  enabled: boolean;
  version: number;
  lastStatus: "ok" | "failed" | "refused" | null;
  lastAt: number | null;
  /** Why the last delivery failed: a host or HTTP status, never a path or secret. */
  lastError: string | null;
  failures: number;
}

export interface AlertDestinationsView {
  destinations: AlertDestination[];
  kinds: Array<{ id: AlertKindId; label: string; sent: boolean }>;
  max: number;
  emailAvailable: boolean;
  /** Product scope: how many enabled platform destinations apply where this sets none. */
  inherited?: number;
  /** Product scope: enabled platform destinations that take each kind. */
  inheritedByKind?: Record<AlertKindId, number>;
}

export interface AlertDestinationBody {
  kind?: "email" | "webhook";
  /** An address, or an https URL (write only). */
  target?: string;
  label?: string;
  alerts?: AlertKindId[];
  enabled?: boolean;
  rotateSecret?: boolean;
  expectedVersion?: number;
}

/** A write's answer. `secret` (a webhook's signing secret) is present on create and rotate only. */
export interface AlertDestinationWritten {
  destination: AlertDestination;
  secret?: string;
}

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

/** The alert destinations base of a scope (ST-27). */
const alertsBase = (scope: AlertScope): string =>
  scope.kind === "platform"
    ? "/manage/api/platform/alerts"
    : `${p(scope.slug)}/alerts`;

export const platformApi = {
  // The probe that learns the session is back: it must not wait for the sign-in it would end.
  me: () => call<Me>("/manage/api/me", {}, { hold: false }),
  /** Who can give the member access to `area` in `scope` (`platform` or `product:<slug>`). */
  accessAdmins: (scope: string, area: AreaId) =>
    call<AccessAdmins>(
      `/manage/api/access/admins?scope=${encodeURIComponent(scope)}&area=${encodeURIComponent(area)}`,
    ),
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
  platformActivity: (
    cursor?: PlatformCursor | null,
    filters: PlatformActivityFilters = {},
    limit?: number,
  ) => {
    const search = new URLSearchParams();
    if (limit) search.set("limit", String(limit));
    if (cursor) {
      search.set("beforeAt", String(cursor.beforeAt));
      search.set("beforeId", cursor.beforeId);
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    }
    const qs = search.toString();
    return call<PlatformActivityPage>(
      `/manage/api/platform/activity${qs ? `?${qs}` : ""}`,
    );
  },
  // ── admin API tokens (platform, not product-scoped) ─────────────────────────
  /** The roster. Never carries a secret or a hash: see `AdminApiToken`. */
  apiTokens: () => call<{ tokens: AdminApiToken[] }>("/manage/api/tokens"),
  /**
   * Mint. The resolved value is the one and only carrier of the plaintext. Needs a sign-in from
   * the last five minutes (403 `step_up_required` otherwise); 422 `fields` names what it refused
   * (`label`, `scopes`, `expiresInDays`); 409 at the live-token cap.
   */
  mintApiToken: (body: MintAdminApiTokenBody) =>
    call<MintAdminApiTokenResult>("/manage/api/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Revoke. The row is kept (409 if it was already revoked), so the history survives. */
  revokeApiToken: (id: string) =>
    call<{ ok: true; token: AdminApiToken }>(`/manage/api/tokens/${enc(id)}`, {
      method: "DELETE",
    }),
  // ── alert destinations (ST-27) ───────────────────────────────────────────────
  /** Where this scope's alerts go. Never a URL or a secret. */
  alertDestinations: (scope: AlertScope) =>
    call<AlertDestinationsView>(alertsBase(scope)),
  /**
   * Add one. A webhook answers its signing secret once, in `secret`. Needs a sign-in from the
   * last five minutes (403 `step_up_required`); 422 `reason` says what was refused.
   */
  createAlertDestination: (scope: AlertScope, body: AlertDestinationBody) =>
    call<AlertDestinationWritten>(alertsBase(scope), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Change one; `rotateSecret` answers a new secret once. Retargeting needs the step-up. */
  updateAlertDestination: (
    scope: AlertScope,
    id: string,
    body: AlertDestinationBody,
  ) =>
    call<AlertDestinationWritten>(`${alertsBase(scope)}/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAlertDestination: (scope: AlertScope, id: string) =>
    call<{ ok: true }>(`${alertsBase(scope)}/${enc(id)}`, {
      method: "DELETE",
    }),
  /** One test alert; 429 `too_soon` inside 30 seconds of the last send. */
  testAlertDestination: (scope: AlertScope, id: string) =>
    call<{ outcome: "ok" | "failed" | "refused"; detail: string | null }>(
      `${alertsBase(scope)}/${enc(id)}/test`,
      { method: "POST" },
    ),
  /** Platform → Members: everyone with a role, the root rule and the pending invites. */
  members: () => call<MembersView>("/manage/api/members"),
  /** Invite addresses (`emails`) to a role. */
  inviteMembers: (body: GrantBody & { emails: string[] }) =>
    call<InviteResult>("/manage/api/bindings", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Give an existing member another role. */
  grantRole: (body: GrantBody & { member: string }) =>
    call<{ ok: true; binding: MemberRole }>("/manage/api/bindings", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Change a product admin's areas. Widening needs a recent sign-in (403 `step_up_required`). */
  editBindingAreas: (
    id: string,
    body: { areas: AreaId[] | null; confirm?: "L2" },
  ) =>
    call<{ ok: true }>(`/manage/api/bindings/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Take a role (or cancel an invite) back. */
  revokeBinding: (id: string) =>
    call<{ ok: true }>(`/manage/api/bindings/${enc(id)}`, {
      method: "DELETE",
    }),
  /**
   * Product → Settings → Members (ST-31.14): who holds access to one product. The Worker leaves
   * the scope off each role and invite and sends no sign-in time; this fills them in so the
   * platform roster's drawer and tags read it unchanged.
   */
  productMembers: async (slug: string): Promise<ProductMembersView> => {
    const raw = await call<{
      product: string;
      truncated: boolean;
      incomplete: boolean;
      members: (Omit<Member, "roles" | "lastSignInAt" | "disabled"> & {
        roles: Omit<MemberRole, "scope">[];
      })[];
      invites: Omit<MemberInvite, "scope">[];
      platformRoles: ProductPlatformRole[];
    }>(`/manage/api/products/${enc(slug)}/members`);
    const scope = `product:${slug}`;
    return {
      ...raw,
      members: raw.members.map((m) => ({
        ...m,
        lastSignInAt: null,
        disabled: false,
        roles: m.roles.map((r) => ({ ...r, scope })),
      })),
      invites: raw.invites.map((i) => ({ ...i, scope })),
    };
  },
  /** Invite addresses as Product admin of one product (the role and scope are the route's). */
  inviteProductMembers: (
    slug: string,
    body: { emails: string[]; areas: AreaId[] | null },
  ) =>
    call<InviteResult>(`/manage/api/products/${enc(slug)}/members`, {
      method: "POST",
      body: JSON.stringify({ ...body, role: "product_admin" }),
    }),
  /** Change a product admin's areas. Widening needs a recent sign-in (403 `step_up_required`). */
  editProductMemberAreas: (
    slug: string,
    id: string,
    body: { areas: AreaId[] | null },
  ) =>
    call<{ ok: true }>(`/manage/api/products/${enc(slug)}/members/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Take a product role (or cancel an invite) back. */
  revokeProductMember: (slug: string, id: string) =>
    call<{ ok: true }>(`/manage/api/products/${enc(slug)}/members/${enc(id)}`, {
      method: "DELETE",
    }),
  /** People's `pkeyp_` tokens (F-33): the Superadmin's roster. Never a token or a hash. */
  personalTokens: () =>
    call<{ tokens: AdminPersonalToken[] }>("/manage/api/account-tokens"),
  /** Revoke one at once (reason `admin`). */
  revokePersonalToken: (id: string) =>
    call<{ ok: true; token: AdminPersonalToken }>(
      `/manage/api/account-tokens/${enc(id)}`,
      { method: "DELETE" },
    ),
  /** Store the operator's own preferences (LK-FU-2). */
  setMyPrefs: (prefs: { setupGuideHidden: boolean }) =>
    call<{ prefs: { setupGuideHidden: boolean } }>("/manage/api/me/prefs", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),
  /** The signed-in operator's own sign-in methods (ST-30c.3). */
  myMethods: () =>
    call<{
      methods: ConsoleMethod[];
      /** I-16's own test: whether a passkey can be added now. */
      canAdd: boolean;
      reason: "limit" | "email_unverified" | null;
    }>("/manage/api/me/methods"),
  /** A passkey registration challenge for the console's relying party; needs a step-up. */
  myPasskeyOptions: () =>
    call<Record<string, unknown>>("/manage/api/me/passkeys/options", {
      method: "POST",
      body: "{}",
    }),
  /** Finish adding a passkey from the browser's attestation; needs a step-up. */
  myPasskeyAdd: (response: Record<string, unknown>) =>
    call<{ ok: true; passkey: { id: string; methodId: string } }>(
      "/manage/api/me/passkeys",
      {
        method: "POST",
        body: JSON.stringify({ response }),
      },
    ),
  /** "Use for the console": mark one of my passkeys strong; needs a step-up. */
  myMethodStrong: (id: string) =>
    call<{ ok: true; id: string; strong: true }>(
      `/manage/api/me/methods/${enc(id)}/strong`,
      { method: "POST", body: "{}" },
    ),
  /** The signed-in member's own personal tokens, both scopes (ST-34.4). A v1 cookie answers 409 `reauth`. */
  myPersonalTokens: () =>
    call<{ tokens: OwnPersonalToken[] }>("/manage/api/me/personal-tokens"),
  /** Revoke one of your own at once. */
  revokeMyPersonalToken: (id: string) =>
    call<{ ok: true; token: OwnPersonalToken }>(
      `/manage/api/me/personal-tokens/${enc(id)}`,
      { method: "DELETE" },
    ),
  /** The runtime settings, the read-only inventory, secrets presence and the warnings (A-13). */
  platformSettings: () =>
    call<PlatformSettingsView>("/manage/api/platform/settings"),
  /** How many products a change to this default or bound reaches (`value`: the proposed one). */
  platformSettingReach: (key: string, value?: number) =>
    call<PlatformReach>(
      `/manage/api/platform/settings/${enc(key)}/reach${value === undefined ? "" : `?value=${value}`}`,
    ),
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
  /** The Connections page: connections, built-in providers, email and Turnstile status. */
  platformConnections: () =>
    call<PlatformConnectionsPage>("/manage/api/platform/connections"),
  platformConnection: (id: string) =>
    call<{ connection: PlatformConnection }>(
      `/manage/api/platform/connections/${enc(id)}`,
    ),
  /** Add a connection (step-up). The secret is sealed and never returned. */
  createPlatformConnection: (body: ConnectionBody) =>
    call<{ ok: true; connection: PlatformConnection }>(
      "/manage/api/platform/connections",
      { method: "POST", body: JSON.stringify(body) },
    ),
  updatePlatformConnection: (id: string, body: ConnectionBody) =>
    call<{ ok: true; connection: PlatformConnection }>(
      `/manage/api/platform/connections/${enc(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deletePlatformConnection: (id: string) =>
    call<{ ok: true }>(`/manage/api/platform/connections/${enc(id)}`, {
      method: "DELETE",
    }),
  /** Run discovery for an issuer; nothing is saved. */
  discoverConnection: (body: { issuer: string; jwksUri?: string | null }) =>
    call<{ ok: true; discovery: ConnectionDiscovery }>(
      "/manage/api/platform/connections/discover",
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Begin a test sign-in: the provider's address to open, and the flow's state. */
  startConnectionTest: (
    body: ConnectionBody & { draftId: string; connectionId?: string },
  ) =>
    call<{ ok: true; url: string; state: string }>(
      "/manage/api/platform/connections/test/start",
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** The test's claims, once, to the operator and draft that started it. */
  connectionTestResult: (state: string, draftId: string) =>
    call<{ ok: true; result: ConnectionTestResult }>(
      `/manage/api/platform/connections/test/result?state=${enc(state)}&draft=${enc(draftId)}`,
    ),
  addConnectionDomain: (id: string, domain: string) =>
    call<{ ok: true; connection: PlatformConnection }>(
      `/manage/api/platform/connections/${enc(id)}/domains`,
      { method: "POST", body: JSON.stringify({ domain }) },
    ),
  verifyConnectionDomain: (id: string, domain: string) =>
    call<{
      ok: true;
      connection: PlatformConnection;
      verify?: "verified" | "absent" | "error" | "taken";
    }>(`/manage/api/platform/connections/${enc(id)}/domains/verify`, {
      method: "POST",
      body: JSON.stringify({ domain }),
    }),
  setConnectionDomainEnforce: (id: string, domain: string, enforce: boolean) =>
    call<{ ok: true; connection: PlatformConnection }>(
      `/manage/api/platform/connections/${enc(id)}/domains/${enc(domain)}`,
      { method: "PATCH", body: JSON.stringify({ enforce }) },
    ),
  removeConnectionDomain: (id: string, domain: string) =>
    call<{ ok: true; connection: PlatformConnection }>(
      `/manage/api/platform/connections/${enc(id)}/domains/${enc(domain)}`,
      { method: "DELETE" },
    ),
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

  /**
   * The live check (UX-69): the UNSAVED value goes to the store once, through the Worker, and
   * the answer says what it found. Nothing is stored. `slot` null is the store's primary slot.
   */
  checkPlatformStoreCredential: (
    store: PlatformStore,
    slot: string | null,
    value: unknown,
  ) =>
    call<PlatformStoreCheckResult>(
      `/manage/api/platform/store-connections/${enc(store)}${slot ? `/credentials/${enc(slot)}` : ""}/check`,
      { method: "POST", body: JSON.stringify({ value }) },
    ),
  /** Store (or rotate) a slot's console credential. The connect form calls it only after a
   *  check passed. Answers metadata only. */
  putPlatformStoreCredential: (
    store: PlatformStore,
    slot: string | null,
    value: unknown,
  ) =>
    call<PlatformStoreCredentialSaved>(
      `/manage/api/platform/store-connections/${enc(store)}${slot ? `/credentials/${enc(slot)}` : ""}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    ),
  /** The live check of a CI secret a storefront needs (UX-69). Nothing is stored; writing the
   *  secret to GitHub is UX-70's route. */
  checkCiSecret: (
    slug: string,
    storefront: string,
    name: string,
    value: string,
  ) =>
    call<CiSecretCheckResult>(
      `${p(slug)}/distribution/storefronts/${enc(storefront)}/ci-secrets/${enc(name)}/check`,
      { method: "POST", body: JSON.stringify({ value }) },
    ),
};
