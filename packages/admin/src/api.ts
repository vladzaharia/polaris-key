/**
 * Same-origin typed client for the `/manage/api/*` surface. The worker
 * (`packages/worker/src/console/api.ts` + each service's `admin.ts`) is the source of truth for
 * these shapes.
 *
 * ── THE ADMIN SURFACE IS SERVICE-GROUPED (plan §R1) ─────────────────────────────────────────
 *
 * Every product-scoped resource now lives under the service that owns it, and the pre-suite
 * spellings are GONE server-side (pre-launch; this client was their only consumer):
 *
 *   licenses[/…] → license/licenses[/…]      schema  → config/catalog
 *   tiers[/…]    → license/tiers[/…]         profiles[/…] → config/profiles[/…]
 *   portal       → identity/portal            policy  → the settings `license.fingerprint` and
 *                                              `license.autoIssue` (the generic settings API)
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
import type { ArtifactRole } from "@polaris-key/manifest";
import type { LicenseTerms } from "../../worker/src/core/licensing/terms.js";
import type { ServiceSlug } from "./services.generated.js";
import { platformApi } from "./console/api/platform.js";
import type { AreaId } from "./console/api/platform.js";
import { ApiError, call, enc, p } from "./console/api/transport.js";
import { productsApi } from "./console/api/products.js";
import { coreApi } from "./console/api/core.js";
import { configApi } from "./console/api/config.js";
import type { ManifestPlan } from "./console/api/products.js";
import type {
  TrustPolicyDto,
  TrustPolicyGuard,
  TrustPolicyResponse,
  TrustPolicyWrite,
} from "./console/api/core.js";
import type { OverrideUpdate, RedactedPayload } from "./console/api/config.js";
export * from "./console/api/products.js";
export * from "./console/api/core.js";
export * from "./console/api/config.js";
export {
  ApiError,
  setCsrf,
  setLoginRedirectForTests,
} from "./console/api/transport.js";
export * from "./console/api/platform.js";
import { RELEASE_POLICY_ERROR_MESSAGES } from "./lib/releasePolicyMessages.js";

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

// ── product settings (LX-06) ──────────────────────────────────────────────────

/** A setting's value shape (worker `core/settings/types.ts` `ValueSpec`). */
export type SettingValueSpec =
  | { kind: "switch" }
  | { kind: "boolean" }
  | { kind: "integer"; unit: string; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; pattern?: string; maxLength: number }
  | { kind: "list"; of: SettingValueSpec; max: number }
  | { kind: "json"; schema: string };

export type SettingConfirmLevel = "L0" | "L1" | "L2" | "L3";

/** The confirm level per direction (worker `SettingConfirm`). */
export type SettingConfirmSpec =
  | { up: SettingConfirmLevel; down: SettingConfirmLevel }
  | { on: SettingConfirmLevel; off: SettingConfirmLevel }
  | { change: SettingConfirmLevel };

/**
 * One product setting with its value in force (`GET …/settings/effective`, the generic settings
 * API of S-18 §4.7): `licensing.*` on License → Settings, the device trust policy on Keys, the
 * fingerprint policy on Enrollment, the update settings and the delivery access.
 */
export interface ProductSetting {
  key: string;
  area: string;
  service: string;
  label: string;
  description: string;
  docs: string;
  spec: SettingValueSpec;
  confirm: SettingConfirmSpec;
  /** A write needs a reason. */
  critical: boolean;
  /** `product:<dotted path>` in `.pkey/`. */
  manifestPath: string | null;
  visibleWhen: {
    service?: string;
    offBehaviour: "hide" | "readOnly" | "visible";
  } | null;
  serviceEnabled: boolean;
  /** The console area a write needs; absent on older responses. */
  rbacArea?: AreaId;
  /** Who may write it; a `manifest` or `read-only` key is shown, not edited. */
  ownership?:
    | "operator"
    | "manifest"
    | "claimable"
    | "narrow-only"
    | "read-only";
  /** Why a write is refused now whatever the value (no release configuration), when it is. */
  blocked?: string;
  value: unknown;
  source: "default" | "manifest" | "console";
  defaultValue: unknown;
  /** What an unset value follows (the daily mail cap), when the platform supplies one. */
  inherited?: unknown;
  /** What the last applied manifest declares (Revert's target); absent when it declares nothing. */
  manifestValue?: unknown;
  /** The row version, 0 for none: a write's `expectedVersion`. */
  version: number;
  /** Epoch seconds. */
  updatedAt: number | null;
  updatedBy: string | null;
  reason: string | null;
}

/** `GET …/settings/drift` (ST-17): the console's claims against the last applied manifest. */
export interface SettingsDriftItem {
  key: string;
  label: string;
  area: string;
  claimedBy: string | null;
  claimedAt: number | null;
  version: number;
  breakGlass?: { reason: string; expiresAt: number };
  /** `claim`: `revertClaim`; `setting`: `revertProductSetting` with `version`. */
  revert: "claim" | "setting";
  manifestKnown: boolean;
  differs: boolean;
  console: unknown;
  manifest: unknown;
  /** The catalog: which keys the manifest adds, drops or changes. */
  changes?: { added: string[]; removed: string[]; changed: string[] };
}

export interface SettingsDrift {
  snapshot: {
    origin: string;
    appliedAt: number;
    appliedSha: string | null;
  } | null;
  items: SettingsDriftItem[];
  /** What the last apply recorded; null before one did. */
  lastPlan: {
    v: 1;
    origin: "resync" | "link" | "deploy-hook";
    commit: string | null;
    plannedAt: number;
    plan: ManifestPlan;
  } | null;
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

/** The opt-in services layered over the always-on Core substrate — generated from the service
 *  table (`tools/services.json`) by `pnpm gen services`. */
export type { ServiceSlug };

export { SERVICE_ERROR_MESSAGES } from "./lib/serviceErrorMessages.js";

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
  /** The caller may not see the access mode (its area is Settings), so `metadataAccess` is a
   *  placeholder and no page should show it. */
  hidden?: true;
  /** The row version of each key as this view read it: a write names it as `expectedVersion`, so
   *  a page that went stale gets the 409 and the conflict UI rather than overwriting. */
  versions: { access: number; compat: number; policy: number };
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

/** The blocks of the update settings Revert can hand back to the manifest (the settings `update.metadataAccess` and `release.compatWindow`). */
export type UpdateSettingsBlock = "access" | "compat";

// ── distribution: delivery access + rollouts (P2b-04) ────────────────────────
/**
 * Who may download a deliverable (worker `services/distribution/access.ts`): the ONE answer the
 * downloads, the appcast and the portal read. The `app` row is manifest-owned until an operator
 * saves it; a pack with no row inherits the app's.
 */
export interface DeliveryAccess {
  /** The row version this view read: a write names it as `expectedVersion`. */
  version: number;
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

// ── distribution: storefronts and the listing (A-18j; worker `services/distribution/storefronts/`) ──

/** How an adapter performs one operation (`core/adapters/contract.ts` `Support`), as declared. */
export type SupportDto =
  | { mode: "api"; plane: "worker"; rules: string[] }
  | { mode: "ci"; plane: "ci"; tool: string; commands: string[] }
  | { mode: "pr"; plane: "pr"; repo: string }
  | {
      mode: "deep-link";
      link: string;
      verify:
        | { read: string; every: number; until: number }
        | "operator-assertion";
    }
  | { mode: "unsupported"; reason: string }
  /** PS-01: run on Polaris Key's own tables (the built-in storefront); shown as "Built in". */
  | { mode: "first-party"; plane: "worker"; handler: string };

export type StorefrontStepState =
  | "todo"
  | "pending"
  | "done"
  | "failed"
  | "ambiguous";

/** One input a step's request asks for. */
export interface StorefrontStepField {
  name: string;
  label: string;
  help?: string;
  value: string;
  required: boolean;
  options?: { value: string; label: string }[];
  maxLength?: number;
}

/** A console request a step names: an admin route, its body, its fields and its confirmation. */
export interface StorefrontStepRequest {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
  fields: StorefrontStepField[];
  confirm: "plain" | "typed";
  verb: string;
  consequences: string[];
}

export interface StorefrontStepDto {
  id: string;
  ops: string[];
  phase: "setup" | "listing" | "assets" | "store" | "submit";
  label: string;
  mode: SupportDto["mode"];
  typed: boolean;
  state: StorefrontStepState;
  stateAt: number | null;
  writes: string[];
  link: {
    url: string | null;
    verify: "read" | "operator-assertion";
    every: number | null;
    until: number | null;
    missing: string[];
  } | null;
  ci: { tool: string; commands: string[] } | null;
  pr: { repo: string } | null;
  run: StorefrontStepRequest | null;
  assert: StorefrontStepRequest | null;
  next: StorefrontStepRequest | null;
  handoff: { page: string; label: string } | null;
  copy: { label: string; value: string }[];
  detail: string | null;
  blockedBy: string | null;
}

export interface StorefrontDto {
  id: string;
  label: string;
  /**
   * A built-in store (PS-06): it runs on Polaris Key's own tables, so it has nothing to connect
   * and no flow; its tile opens the store's own panel. Optional for older Workers.
   */
  builtIn?: boolean;
  listingStore: string | null;
  connection: {
    state: "connected" | "not-configured" | "keyless";
    credential: string | null;
    credentialLabel: string | null;
    source: "console" | "secret" | null;
    lastError: string | null;
  };
  app: { id: string; name: string | null } | null;
  outlets: string[];
  readOnly: string | null;
  capabilities: { op: string; label: string; support: SupportDto }[];
  prerequisites: {
    id: string;
    label: string;
    state: "met" | "unmet" | "unknown";
    detail: string;
    page: string | null;
  }[];
  steps: StorefrontStepDto[];
  pushListing: { stageOnly: boolean } | null;
  confirmationLabel: string;
  /** Identifiers the flow shows; a value the manifest leaves empty is filled from the assignment. */
  identifiers?: Record<
    string,
    { value: string; source: "manifest" | "assigned" }
  >;
}

/** `GET …/distribution/storefronts`. */
export interface StorefrontsResponse {
  stores: StorefrontDto[];
  listing: {
    name: string | null;
    defaultLocale: string;
    locales: string[];
  } | null;
}

/** A step's or a push's outcome: the vendor's re-read, never the request. */
export interface StorefrontRunResult {
  ok: true;
  outcome: "written" | "existing" | "replayed";
  opId: string;
  resultIds: Record<string, string>;
  after: unknown;
  /** What the operator still finishes in the store's own console (decision 6: the older Play
   *  images a replaced set leaves, which Polaris Key never deletes). */
  followUp?: StorefrontFollowUp;
}

/** A run's follow-up: one sentence with the count, and the store page (or what its link lacks). */
export interface StorefrontFollowUp {
  count: number;
  text: string;
  url: string | null;
  missing: string[];
}

/** `POST …/steps/<op>/check`. */
export interface StorefrontCheckResult {
  ok: true;
  state: StorefrontStepState;
  satisfied: boolean;
  resultIds?: Record<string, string>;
  detail?: string | null;
}

export interface ListingSlotDto {
  slot: string;
  locale: string | null;
  group: string;
  kind: "human" | "derived" | "composed";
  state: "missing" | "review" | "accepted";
  spec: string | null;
  textAllowed: string;
  asset: {
    sha256: string;
    width: number | null;
    height: number | null;
    alpha: boolean;
    derivedFrom: string | null;
    source: string;
    modifiedAt: number;
    image: string;
    acceptedAt: number | null;
    acceptedBy: string | null;
  } | null;
}

export interface ListingLocaleDto {
  locale: string;
  name?: string;
  subtitle?: string;
  shortDescription?: string;
  description?: string;
  keywords?: string[];
  features?: string[];
  promotionalText?: string;
  source: string;
  provenance: Record<string, string>;
  modifiedAt: number;
  modifiedBy: string;
}

/** `GET …/distribution/listing` (A-18b). */
export interface ListingResponse {
  listing: {
    app: {
      defaultLocale: string;
      name?: string;
      developerName?: string;
      category?: string;
      contactEmail?: string;
      copyright?: string;
      urls?: Record<string, string>;
    };
    source: string;
    provenance: Record<string, string>;
    modifiedAt: number;
    modifiedBy: string;
  } | null;
  locales: ListingLocaleDto[];
  /** Fields a projection fills from the product (A-27.9): the name, accents and icon. */
  inherited?: Partial<
    Record<"name" | "tint" | "tintDark" | "icon-master", "presentation">
  >;
  overrides: {
    store: string;
    locale: string | null;
    field: string;
    value: string | string[];
  }[];
  limits: Record<string, number | { maxItems: number; maxItemChars: number }>;
  stores: { store: string; label: string }[];
  overrideStores: string[];
  modelFields: string[];
}

export interface ListingFitIssue {
  store: string;
  field: string;
  from: string;
  locale: string | null;
  issue: string;
  severity: "warn" | "block";
  limit: number | null;
  actual: number | null;
  unit: string | null;
  proposal?: string;
}

/** `GET …/distribution/listing/fit`. */
export interface ListingFitResponse {
  exists: boolean;
  release: string | null;
  stores: {
    store: string;
    label: string;
    status: "green" | "amber" | "red";
    issues: ListingFitIssue[];
    cells: {
      field: string;
      from: string;
      locale: string | null;
      plane: "api" | "copy" | "manual";
      status: "green" | "amber" | "red";
      present: boolean;
    }[];
  }[];
}

/** One field of an import's diff (A-18c `ImportChange`). */
export interface ListingImportChange {
  /** `name`, `urls.website`, `locales.de-DE.description`. */
  field: string;
  locale: string | null;
  action: "add" | "replace" | "keep";
  current: string | string[] | Record<string, unknown> | null;
  currentSource: string | null;
  proposed: string | string[] | Record<string, unknown>;
  proposedSource: string;
  reason: string | null;
}

/** The import's preview (or, with `confirm`, what it applied). */
export interface ListingImportPreview {
  applied: boolean;
  digest: string;
  createsListing: boolean;
  defaultLocale: string;
  sources: {
    source: string;
    ref: string | null;
    ok: boolean;
    reason?: string;
    message?: string;
  }[];
  changes: ListingImportChange[];
  refused: { field: string; message?: string; [key: string]: unknown }[];
  skipped: { source: string; field: string; reason: string }[];
  written: string[];
}

/** `POST …/distribution/listing/import`: the preview (or result) and the model after it. */
export type ListingImportResponse = ListingResponse & {
  import: ListingImportPreview;
};

/** `GET …/distribution/listing/release-notes/<release>`. */
export interface ListingReleaseNotesResponse {
  notes: {
    releaseId: string;
    version: string;
    locales: {
      locale: string;
      text: string;
      short: string | null;
      /** `default` for the release record's own notes, shown until saved. */
      source: string;
      proposedShort: string | null;
      modifiedAt: number | null;
      modifiedBy: string | null;
    }[];
  };
  limits: { short: number; text: number };
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

// ── licenses ──────────────────────────────────────────────────────────────────
export type LicenseStatus = "active" | "disabled";
export type KeyStatus = "active" | "revoked";

/** The licence list's largest page (the Worker's `LICENSE_PAGE_MAX`). */
export const LICENSE_PAGE_MAX = 90;

export interface LicensePage {
  licenses: LicenseSummary[];
  nextCursor: string | null;
  /** LX-27c.4: whether an invitation can reach this product's licences, and why not. First page. */
  holders?: {
    invitations: boolean;
    invitationsOff: "identity_off" | "auto_link_off" | "no_mail" | null;
  };
  /** What the filters match, and by state. First page only (the Worker sends them without a cursor). */
  total?: number;
  counts?: {
    active: number;
    expiring: number;
    expired: number;
    disabled: number;
  };
}

/** The list's server-side narrowing: the Worker filters on these before it pages. */
export interface LicenseListFilter {
  holder?: string;
  batch?: string;
  tier?: string;
  /** One computed state: active, expiring, expired or disabled. */
  state?: string;
}

export interface LicenseSummary {
  id: string;
  name: string;
  email: string;
  status: LicenseStatus;
  activatedAt: number;
  /** LX-27c: when the last invitation email went out; `null` when none did. */
  invitedAt?: number | null;
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
  /** How the licence was minted: by an operator, a sign-in, or an auto-issue. */
  origin?: LicenseOrigin;
  /** Whether it may be deleted, and every reason it may not. */
  deletion?: LicenseDeletion;
  modifiedBy?: string;
  modifiedAt?: number;
  /** LX-14a: the licence's own device limit; `null` inherits. */
  deviceLimit?: number | null;
  /** The limit the Worker enforces at the next activation (0: no limit), and its source. */
  effectiveDeviceLimit?: number;
  deviceLimitSource?: DeviceLimitSource;
  /** What "Use inherited limit" falls back to: the tier's, an entitlement's or the product's. */
  inheritedDeviceLimit?: number;
  inheritedDeviceLimitSource?: Exclude<DeviceLimitSource, "license">;
  /** LX-32: every limit with the layer it came from (the Worker's one resolver). */
  terms?: LicenseTerms;
  /**
   * LX-26 (S-24 D1): floating or assigned, derived by the Worker from the licence's account and
   * its own email. Absent from an older Worker: the console then derives it from `email`.
   */
  holder?: LicenseHolder;
  /** PX-W17: the owner as this product sees them, `null` while floating or waiting. */
  ownerSubject?: string | null;
  /** LX-28: the batch the licence was created in, `null` for a licence created on its own. */
  batchId?: string | null;
  /** PX-W9: the licence's key entries; `null` with Identity off. */
  keyEntries?: { used: number; limit: number } | null;
}

/**
 * Who holds a licence (S-24 §5.1, D1): **floating** (no account and no email: anyone with the
 * key), or **assigned**, in an account or waiting for its email to be verified. `email` is the
 * licence's own, never the account's.
 */
export type LicenseHolder =
  | { kind: "floating" }
  | { kind: "assigned"; inAccount: boolean; email?: string };

/** A licence batch (LX-28): up to 500 floating licences created together under one label. */
export interface LicenseBatch {
  id: string;
  label: string;
  /** How many licences the batch created. */
  count: number;
  tier: string | null;
  /** The operator's session sub. */
  createdBy: string;
  createdAt: number;
  /** Licences of the batch that have ever had a device bound. */
  used: number;
  /** Active licences never used: what Disable unused keys would disable. */
  unused: number;
  /** Licences of the batch that are disabled, used or not. */
  disabled: number;
}

/** How a licence's holder last moved (LX-30): I-12's relink, Make floating or Reassign. */
export type LicenseHolderMoveKind = "relink" | "floating" | "reassign";

/** `GET users/licenses/<id>/relinks`: one move of one licence, with its 72-hour undo. */
export interface LicenseHolderMove {
  id: string;
  kind: LicenseHolderMoveKind;
  reason: string;
  actorName: string | null;
  createdAt: number;
  undoUntil: number;
  undoneAt: number | null;
  undoable: boolean;
  fromSubject: string | null;
  toSubject: string | null;
  /** The holder's name and email before the move (`null` for a relink, which keeps them). */
  from: { name: string | null; email: string | null } | null;
  to: { name: string | null; email: string | null } | null;
  devicesSignedOut: number;
}

/** Make floating (LX-30): a step-up action; `confirm` is the licence's name, else its id. */
export interface MakeFloatingBody {
  reason: string;
  confirm: string;
  signOutDevices?: boolean;
}

/** Reassign (LX-30): a step-up action; `confirm` is the licence's name, else its id. */
export interface ReassignLicenseBody {
  email: string;
  name?: string | null;
  reason: string;
  confirm: string;
}

/** What Make floating and Reassign answer. Never whether the new address has an account (D4). */
export interface HolderMoveResult {
  ok: true;
  relinkId: string;
  undoUntil: number;
  noticesSent: number;
  alert: boolean;
  /** Make floating only: how many devices were signed out. */
  devicesSignedOut?: number;
}

/** Where a licence's effective device limit comes from, most specific first (LX-14a). */
export type DeviceLimitSource = "license" | "tier" | "entitlement" | "product";

export type LicenseOrigin = "admin" | "oidc" | "enroll";

/** One reason a licence cannot be deleted (`issued_active`, `store_grants`, `store_purchases`). */
export interface LicenseDeleteReason {
  code: string;
  message: string;
}

export interface LicenseDeletion {
  allowed: boolean;
  reasons: LicenseDeleteReason[];
}

/** One row of the "Clean up duplicates" list. */
export interface LicenseCleanupCandidate {
  id: string;
  name: string;
  email: string;
  status: LicenseStatus;
  tier: string | null;
  /** The owner's pairwise subject, when it has one. */
  accountSubject: string | null;
  deviceCount: number;
  lastSeen: number | null;
  /** Always `duplicate`: the account holds another usable licence (`keeps`), which stays. */
  reason: "duplicate";
  keeps: string;
  deletion: LicenseDeletion;
}

export interface LicenseBulkDeleteResult {
  ok: boolean;
  deleted: { id: string; devices: number }[];
  refused: { id: string; reasons: LicenseDeleteReason[] }[];
  notFound: string[];
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
  /** The row version this view read: a write names it as `expectedVersion`. */
  version: number;
  policy: FingerprintPolicyDto;
  /** `manifest` means a resync still owns it; `admin` means an operator has taken it over. */
  source: "manifest" | "admin";
}

/**
 * What sits above a licence's overrides (U-03; worker `services/license/admin/licenses.ts`
 * `configOverridesView`). The licence layer is always read and always editable (U-27); an older
 * Worker also sent a `phase` and a `runNotBefore`, which this console ignores.
 */
export interface LicenseConfigOverrides {
  /** An account owns the licence. An unowned licence has no account layer. */
  owned: boolean;
  /** The owner's subject on this product, for the Users record link. */
  ownerSubject: string | null;
  /** The portal's Activate License page: an offer for the customer, never forced. */
  signUpUrl: string | null;
}

export interface LicenseDetail extends LicenseSummary {
  groups?: string[];
  maxOfflineDays?: number | null;
  /** LX-14a: the devices holding a seat, with the dormancy cutoff the seat check and the
   *  PATCH's `overLimit` apply (a dormant device's seat is reclaimed at the next activation). */
  seatDeviceCount?: number;
  overrides: RedactedPayload;
  /** U-03. Absent from an older Worker, which reads as an unowned licence. */
  configOverrides?: LicenseConfigOverrides;
  keys: KeyDto[];
  devices: DeviceDto[];
}

export interface CreateLicenseBody {
  /** LX-26: an `email` assigns the licence; without one it is floating. */
  name?: string;
  email?: string;
  /** Omitted: the tier's term (`policyExpiryDays` from now). `null`: no expiry. */
  expiresAt?: number | null;
  profile?: string;
  profiles?: string[];
  tier?: string;
  maxOfflineDays?: number;
  channels?: string[];
  minVersion?: string;
  maxVersion?: string;
  /** LX-27: the licence's own device limit; omitted inherits. */
  deviceLimit?: number;
  /** LX-27: `email: true` mails the first key to `email` in the same request. LX-27c:
   *  `invite: true` mails an invitation (a sign-in link, no key) instead; exclusive with `email`. */
  delivery?: { email?: boolean; invite?: boolean };
  /** LX-27c: `false` mints no key; valid only with `delivery.invite`. */
  key?: boolean;
}

/** LX-28: `POST …/license/batches`: up to 500 floating licences under one label. */
export interface CreateLicenseBatchBody {
  label: string;
  count: number;
  tier: string;
  deviceLimit?: number | null;
  expiresAt?: number | null;
  maxOfflineDays?: number;
  channels?: string[];
  minVersion?: string;
  maxVersion?: string;
}

/** LX-27: how the key email went. */
export type KeyEmailOutcome = "sent" | "queued" | "failed";
/** LX-27c: how an invitation went. */
export type InviteOutcome = "sent" | "failed";
/** Why a key email did not go out (`delivered.reason`, and a 409's `reason`). */
export type KeyEmailFailure =
  | "no_mail_binding"
  | "address_unusable"
  | "suppressed"
  | "daily_cap"
  | "provider_refused";

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
  /** LX-14a: the licence's own device limit, a positive integer; `null` inherits again. */
  deviceLimit?: number | null;
}

// ── offline bundles ───────────────────────────────────────────────────────────
/**
 * What to mint into one offline activation bundle. The server
 * (`packages/worker/src/console/handlers/bundles.ts`) decides what actually rides inside by ENABLEMENT,
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
  /** ST-01b: `console` once created or edited in the console; a resync leaves it alone. */
  source?: "manifest" | "console";
  /** LX-33.7: the product's Default tier (used when a license names no tier). Its limits follow
   *  the product's license defaults and it cannot be deleted. Absent on an older Worker. */
  implicit?: boolean;
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

// ── package feeds (F-11; worker `console/handlers/feeds.ts`) ───────────────────────────

/** The ecosystems a package feed serves (`@polaris-key/manifest` PACKAGE_ECOSYSTEMS): the six of
 *  tier 1, then tier 3's Cargo (F-30) and Go (F-31). */
export type FeedEcosystem =
  | "npm"
  | "pypi"
  | "swift"
  | "maven"
  | "oci"
  | "godot"
  | "cargo"
  | "go";

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
  /** public, customers, or "customers, packages gated individually" (F-34.5). */
  accessDisplay?: string;
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
  /** Who last wrote it: an admin subject, or `manifest` for a row the ingest provisioned. */
  updatedBy: string | null;
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
  /** Platform scope: each ecosystem's kill switch and size ceiling (`null` before its row exists). */
  policies?: {
    ecosystem: FeedEcosystem;
    label: string;
    policy: FeedPolicy | null;
  }[];
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
  /** public, customers, or "customers, packages gated individually" (F-34.5). */
  accessDisplay?: string;
  namespace: Record<string, unknown>;
  /** Where the namespace came from: provisioned from `.pkey/release`, or set in the console. */
  namespaceSource?: "manifest" | "console";
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
   * panel renders (F-12).
   */
  extensions: string[];
  accessModes: { mode: string; available: boolean }[];
  /** F-21: the ecosystem's packages with no delivery gate, which `entitled` refuses every
   *  licence token for. */
  ungatedPackages?: { id: string; name: string }[];
}

// ── registry tokens (F-21; worker `console/handlers/registryTokens.ts`) ────────────────────────

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
  /** F-33b.3: an owner-wide read token, retired; it works until it expires. */
  legacy?: boolean;
}

/** A read service token (a `pkeyci_` holding only `packages:read`): never the token or its hash. */
export interface ServiceTokenDto {
  /** `cit_…`: revoke it with `POST …/tokens/<tokenId>/revoke`. */
  tokenId: string;
  label: string;
  scopes: string[];
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  /** The token's last four characters; `null` for a token made before F-33b.4. */
  hint: string | null;
  revokedAt: number | null;
  /** From the audit trail: `admin:<who>`, or `null` when it is not there. */
  revokedBy: string | null;
  /** `manual` (this token) or `revoke_all` (the product-wide revoke); `null` with `revokedBy`. */
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

export interface RegistryTokenFeed {
  ecosystem: FeedEcosystem;
  label: string;
  enabled: boolean;
  accessMode: string;
  baseUrl: string | null;
  /** The feed's namespace (npm `scope`, Maven `groupPrefixes`, …): the setup snippets name it. */
  namespace?: Record<string, unknown>;
}

export interface RegistryTokensDto {
  owner: string;
  registryOrigin: string | null;
  /** The username clients send beside the token (`__token__`). */
  username: string;
  tokens: RegistryTokenDto[];
  /** F-33b.3: the product's read service tokens (none for a licence filter). */
  serviceTokens?: ServiceTokenDto[];
  feeds: RegistryTokenFeed[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    urlDefaultDays: number;
    perOwner: number;
    perLicense: number;
    /** F-22: a publish token's default and longest expiry, and the ecosystems it may name. */
    serviceDefaultDays?: number;
    serviceMaxDays?: number;
    publishDefaultDays?: number;
    publishMaxDays?: number;
    publishEcosystems?: FeedEcosystem[];
  };
}

export interface MintRegistryTokenBody {
  label: string;
  ecosystems?: FeedEcosystem[] | null;
  expiresInDays?: number;
  /** `"service"` (F-33b.3) mints a `pkeyci_` read service token: only `label` and
   *  `expiresInDays` (1 to 365, default 90) apply. `"owner"` is for publish tokens only. */
  binding: "owner" | "license" | "service";
  licenseId?: string;
  presentation?: "header" | "url";
  /** `["publish"]` for a publish token (owner-bound, named ecosystems): F-22's native clients and
   *  F-23's `docker push`. */
  scopes?: ("read" | "publish")[];
}

/** The answer to a `binding: "service"` mint. */
export interface MintedServiceToken {
  ok: true;
  /** The `pkeyci_` plaintext: in this answer only. */
  token: string;
  view: ServiceTokenDto;
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
    kind: "oidc" | "static" | "console" | "registry" | "unknown";
    publisher: string | null;
    runUrl: string | null;
    tokenId: string | null;
    /** F-22: the native client that published (`npm`, `twine`, `swift`, `maven`), or null. */
    client?: string | null;
    /** F-23: `oci-push` when the version came through `docker push`. */
    via?: "oci-push" | null;
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

// A gated action refused for a stale step-up goes to the step-up sign-in and back.
export { setStepUpRedirectForTests, startStepUp } from "./lib/stepUp.js";

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
  ...platformApi,
  ...productsApi,
  ...coreApi,
  ...configApi,
  /**
   * ST-52: the palette's entity search. The query goes in the body, never the URL: a pasted key
   * must not reach request logs. A pasted licence key resolves to `key` (its licence) and is never
   * echoed; a key the member may not read answers `key: null`, like an unknown one.
   */
  search: (q: string) =>
    call<SearchDto>("/manage/api/search", {
      method: "POST",
      body: JSON.stringify({ q }),
    }),
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
  /** ST-12: the device trust policy, its source and the version a write must carry. */
  trustPolicy: async (slug: string): Promise<TrustPolicyResponse> =>
    trustPolicyOf(await getSetting(slug, TRUST_POLICY_KEY)),
  /** A relaxing change also carries `reason` and `confirm` and needs a fresh step-up. */
  putTrustPolicy: async (
    slug: string,
    { policy, ...guard }: TrustPolicyWrite,
  ): Promise<TrustPolicyResponse> =>
    trustPolicyOf(
      (
        await writeSetting(slug, TRUST_POLICY_KEY, "PATCH", {
          value: policy,
          ...guard,
        })
      ).setting,
    ),
  resetTrustPolicy: async (
    slug: string,
    guard: TrustPolicyGuard,
  ): Promise<TrustPolicyResponse> =>
    trustPolicyOf(
      (await writeSetting(slug, TRUST_POLICY_KEY, "DELETE", guard)).setting,
    ),
  // ── update settings (the generic settings API: `update.metadataAccess`,
  //    `release.compatWindow`, `update.operatorPolicy`) ────────────────────────
  updateSettings: async (slug: string): Promise<UpdateSettings> =>
    updateSettingsOf(await getSettings(slug, UPDATE_KEYS)),
  /**
   * Each key the body names is one write, carrying the version the page loaded (`versions`, from
   * the `UpdateSettings` it shows). The three blocks are three registry keys and the generic API
   * writes one key per request, so a save that spans blocks is several requests; the pages each
   * save one block, so in practice it is one. The merge base for a partial compat window or
   * operator policy is the view the page loaded too.
   */
  saveUpdateSettings: async (
    slug: string,
    body: UpdateSettingsBody,
    cur: UpdateSettings,
  ): Promise<UpdateSettings> => {
    if (body.metadataAccess !== undefined)
      await writeSetting(slug, UPDATE_ACCESS_KEY, "PATCH", {
        value: body.metadataAccess,
        expectedVersion: cur.versions.access,
      });
    if (body.compatMin !== undefined || body.compatMax !== undefined)
      await writeSetting(slug, UPDATE_COMPAT_KEY, "PATCH", {
        value: {
          min: body.compatMin ?? cur.compatMin,
          max: body.compatMax ?? cur.compatMax,
        },
        expectedVersion: cur.versions.compat,
      });
    if (
      body.minimumSystemVersion !== undefined ||
      body.requireSparkleSignature !== undefined
    ) {
      const min =
        body.minimumSystemVersion === undefined
          ? cur.minimumSystemVersion
          : body.minimumSystemVersion;
      await writeSetting(slug, UPDATE_POLICY_KEY, "PATCH", {
        value: {
          requireSparkleSignature:
            body.requireSparkleSignature ?? cur.requireSparkleSignature,
          ...(min === null ? {} : { minimumSystemVersion: min }),
        },
        expectedVersion: cur.versions.policy,
      });
    }
    return updateSettingsOf(await getSettings(slug, UPDATE_KEYS));
  },
  /** Hand the named blocks back to the manifest. Changes nothing live — the manifest re-applies
   *  on the NEXT resync (worker `core/settings/columns.ts`). */
  revertUpdateSettings: async (
    slug: string,
    fields: UpdateSettingsBlock[],
    cur: UpdateSettings,
  ): Promise<UpdateSettings> => {
    for (const block of fields)
      await writeSetting(
        slug,
        block === "access" ? UPDATE_ACCESS_KEY : UPDATE_COMPAT_KEY,
        "DELETE",
        {
          expectedVersion:
            block === "access" ? cur.versions.access : cur.versions.compat,
        },
      );
    return updateSettingsOf(await getSettings(slug, UPDATE_KEYS));
  },

  // ── distribution: delivery access + rollouts (P2b-04; the setting `distribution.access`) ──
  deliveryAccess: async (slug: string): Promise<DeliveryAccess> =>
    deliveryAccessOf(await getSetting(slug, DELIVERY_ACCESS_KEY)),
  saveDeliveryAccess: async (
    slug: string,
    body: {
      mode: ReleaseAccess;
      deliverable?: string;
      /** A pack's delivery gate, for `entitled`: the catalog flag a license must grant (`null` clears it). */
      entitlement?: string | null;
    },
    /** The `DeliveryAccess.version` the page loaded. */
    expectedVersion: number,
  ): Promise<DeliveryAccess> => {
    return deliveryAccessOf(
      (
        await writeSetting(slug, DELIVERY_ACCESS_KEY, "PATCH", {
          value: {
            [body.deliverable ?? "app"]: {
              mode: body.mode,
              ...(body.entitlement !== undefined
                ? { entitlement: body.entitlement }
                : {}),
            },
          },
          expectedVersion,
        })
      ).setting,
    );
  },
  /** Hand the app's delivery access back to the manifest; it re-applies on the next resync. */
  revertDeliveryAccess: async (
    slug: string,
    expectedVersion: number,
  ): Promise<DeliveryAccess> => {
    return deliveryAccessOf(
      (
        await writeSetting(slug, DELIVERY_ACCESS_KEY, "DELETE", {
          expectedVersion,
        })
      ).setting,
    );
  },
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

  // ── distribution: storefronts and the listing (A-18j) ─────────────────────
  storefronts: (slug: string) =>
    call<StorefrontsResponse>(`${p(slug)}/distribution/storefronts`),
  storefrontSlots: (slug: string) =>
    call<{ slots: ListingSlotDto[] }>(
      `${p(slug)}/distribution/storefronts/slots`,
    ),
  /** Accept exactly the bytes shown (`sha256`); 409 `asset_changed` when they moved since. */
  acceptListingAsset: (
    slug: string,
    body: { slot: string; locale: string | null; sha256: string },
  ) =>
    call<{ ok: true; accepted: boolean }>(
      `${p(slug)}/distribution/storefronts/slots/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /**
   * A flow step's request, as the server's plan names it (`run`, `assert`, `next`): an absolute
   * console path under `/manage/api/`, or one relative to the product's API. One
   * `Idempotency-Key` per operator intent.
   */
  storefrontRequest: (
    slug: string,
    path: string,
    method: string,
    body: Record<string, unknown>,
    opts?: { idempotencyKey?: string } | null,
  ) => {
    const absolute = path.startsWith("/");
    if (absolute && (!path.startsWith("/manage/api/") || path.includes("..")))
      throw new Error(`a flow step may only call the console API: ${path}`);
    return call<Record<string, unknown>>(
      absolute ? path : `${p(slug)}/${path.split("/").map(enc).join("/")}`,
      {
        method: method === "PUT" ? "PUT" : "POST",
        body: JSON.stringify(body ?? {}),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    );
  },
  /** A deep-linked step: `{}` runs its verifier read, `{assert: true}` records it done. */
  storefrontCheck: (
    slug: string,
    store: string,
    op: string,
    body: { assert?: boolean; poll?: boolean },
  ) =>
    call<StorefrontCheckResult>(
      `${p(slug)}/distribution/storefronts/${enc(store)}/steps/${enc(op)}/check`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
  /** "Push listing" (text and accepted images; plain confirm; always staged where the store stages, never sent for review). */
  pushListing: (
    slug: string,
    store: string,
    body: { stageOnly?: boolean },
    opts?: { idempotencyKey?: string } | null,
  ) =>
    call<StorefrontRunResult>(
      `${p(slug)}/distribution/storefronts/${enc(store)}/push-listing`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    ),
  listing: (slug: string) =>
    call<ListingResponse>(`${p(slug)}/distribution/listing`),
  putListing: (slug: string, body: Record<string, unknown>) =>
    call<ListingResponse>(`${p(slug)}/distribution/listing`, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
    }),
  putListingOverride: (
    slug: string,
    body: {
      store: string;
      locale?: string | null;
      field: string;
      value: string | string[] | null;
    },
  ) =>
    call<Record<string, unknown>>(`${p(slug)}/distribution/listing/overrides`, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
    }),
  listingFit: (slug: string, release?: string | null) =>
    call<ListingFitResponse>(
      `${p(slug)}/distribution/listing/fit${release ? `?release=${enc(release)}` : ""}`,
    ),
  /** Without `confirm`: the field-by-field diff (nothing is written). With the diff's `digest`: apply it. */
  listingImport: (slug: string, body: Record<string, unknown>) =>
    call<ListingImportResponse>(`${p(slug)}/distribution/listing/import`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  listingReleaseNotes: (slug: string, release: string) =>
    call<ListingReleaseNotesResponse>(
      `${p(slug)}/distribution/listing/release-notes/${enc(release)}`,
    ),
  putListingReleaseNotes: (
    slug: string,
    release: string,
    body: { locale: string; text: string | null; short?: string | null },
  ) =>
    call<Record<string, unknown>>(
      `${p(slug)}/distribution/listing/release-notes/${enc(release)}`,
      { method: "PUT", body: JSON.stringify(body ?? {}) },
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

  // ── sync: Cloud Sync usage (U-05.19) ───────────────────────────────────────
  /** The Usage page's facts: the aggregate, today's UTC counters, tier labels and limits. */
  syncUsage: (slug: string) => call<SyncUsageResponse>(`${p(slug)}/sync/usage`),

  // ── licenses ────────────────────────────────────────────────────────────────
  /** One page of the list (P0-29): newest first, `nextCursor` null on the last. */
  licensesPage: (
    slug: string,
    page: { cursor?: string | null; limit?: number } & LicenseListFilter = {},
  ) => {
    const search = new URLSearchParams();
    for (const k of ["holder", "batch", "tier", "state"] as const)
      if (page[k]) search.set(k, page[k]);
    if (page.limit) search.set("limit", String(page.limit));
    if (page.cursor) search.set("cursor", page.cursor);
    const qs = search.toString();
    return call<LicensePage>(
      `${p(slug)}/license/licenses${qs ? `?${qs}` : ""}`,
    );
  },
  /** Every licence, page by page: for the views that need the whole set (counts, pickers). */
  licenses: async (slug: string): Promise<{ licenses: LicenseSummary[] }> => {
    const licenses: LicenseSummary[] = [];
    let cursor: string | null = null;
    do {
      const page: LicensePage = await api.licensesPage(slug, {
        cursor,
        limit: LICENSE_PAGE_MAX,
      });
      licenses.push(...page.licenses);
      cursor = page.nextCursor;
    } while (cursor);
    return { licenses };
  },
  license: (slug: string, id: string) =>
    call<LicenseDetail>(`${p(slug)}/license/licenses/${enc(id)}`),
  createLicense: (slug: string, body: CreateLicenseBody) =>
    call<{
      licenseId: string;
      /** Absent when the request sent `key: false` (an invitation only). */
      key?: string;
      delivered?: {
        email?: KeyEmailOutcome;
        invite?: InviteOutcome;
        reason?: KeyEmailFailure;
      };
      license: LicenseSummary;
    }>(`${p(slug)}/license/licenses`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchLicense: (slug: string, id: string, body: PatchLicenseBody) =>
    call<{
      ok: true;
      id: string;
      /** Present when a tier or device-limit change lands below the active device count.
       *  Existing devices are grandfathered; new activations are refused until the count
       *  drops. */
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
  /** Typed confirmation: `confirm` is `delete <id>`. */
  deleteLicense: (slug: string, id: string, confirm: string) =>
    call<{ ok: true; id: string; devices: number }>(
      `${p(slug)}/license/licenses/${enc(id)}`,
      { method: "DELETE", body: JSON.stringify({ confirm }) },
    ),
  /** Typed confirmation: `confirm` is `delete <n> licenses` (`delete 1 license`). */
  deleteLicenses: (slug: string, ids: string[], confirm: string) =>
    call<LicenseBulkDeleteResult>(`${p(slug)}/license/deletions`, {
      method: "POST",
      body: JSON.stringify({ ids, confirm }),
    }),
  licenseCleanupCandidates: (slug: string) =>
    call<{ candidates: LicenseCleanupCandidate[] }>(
      `${p(slug)}/license/deletions/candidates`,
    ),

  // ── license batches (LX-28, LX-30) ──────────────────────────────────────────────
  /** One page of the product's batches, newest first. */
  licenseBatches: (
    slug: string,
    page: { limit?: number; cursor?: string } = {},
  ) => {
    const q = new URLSearchParams();
    if (page.limit !== undefined) q.set("limit", String(page.limit));
    if (page.cursor) q.set("cursor", page.cursor);
    const qs = q.toString();
    return call<{ batches: LicenseBatch[]; nextCursor?: string | null }>(
      `${p(slug)}/license/batches${qs ? `?${qs}` : ""}`,
    );
  },
  createLicenseBatch: (slug: string, body: CreateLicenseBatchBody) =>
    call<{
      batchId: string;
      licenses: { licenseId: string; key: string }[];
      batch: LicenseBatch;
      expiresAt: number | null;
    }>(`${p(slug)}/license/batches`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  licenseBatch: (slug: string, id: string) =>
    call<LicenseBatch>(`${p(slug)}/license/batches/${enc(id)}`),
  /** Typed confirmation: `confirm` is the batch label. */
  disableUnusedLicenses: (slug: string, batchId: string, confirm: string) =>
    call<{ disabled: number }>(
      `${p(slug)}/license/batches/${enc(batchId)}/disable-unused`,
      { method: "POST", body: JSON.stringify({ confirm }) },
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
  /** LX-27: mint a key labelled "Sent by email", mail it to the licence's address. */
  sendLicenseKey: (
    slug: string,
    id: string,
    revokeOthers = false,
    context?: "assigned",
  ) =>
    call<{
      key: string;
      hash: string;
      delivered: { email: KeyEmailOutcome; reason?: KeyEmailFailure };
      revoked: number;
    }>(`${p(slug)}/license/licenses/${enc(id)}/send-key`, {
      method: "POST",
      body: JSON.stringify({ revokeOthers, ...(context ? { context } : {}) }),
    }),
  /** LX-27c.2: mail the invitation again to a waiting licence. Mints nothing. */
  sendLicenseInvite: (slug: string, id: string, context?: "assigned") =>
    call<{ delivered: { invite: InviteOutcome; reason?: KeyEmailFailure } }>(
      `${p(slug)}/license/licenses/${enc(id)}/send-invite`,
      { method: "POST", body: JSON.stringify(context ? { context } : {}) },
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

  /** LX-30: the licence's holder moves, newest first, with their undo windows. */
  licenseHolderMoves: (slug: string, licenseId: string) =>
    call<{ relinks: LicenseHolderMove[] }>(
      `${p(slug)}/users/licenses/${enc(licenseId)}/relinks`,
    ),
  /** LX-30: needs a step-up (403 `step_up_required` otherwise). */
  makeLicenseFloating: (
    slug: string,
    licenseId: string,
    body: MakeFloatingBody,
  ) =>
    call<HolderMoveResult>(
      `${p(slug)}/users/licenses/${enc(licenseId)}/make-floating`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** LX-30: needs a step-up (403 `step_up_required` otherwise). */
  reassignLicenseHolder: (
    slug: string,
    licenseId: string,
    body: ReassignLicenseBody,
  ) =>
    call<HolderMoveResult>(
      `${p(slug)}/users/licenses/${enc(licenseId)}/reassign`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Needs a step-up, within 72 hours of the relink. */
  undoRelink: (slug: string, relinkId: string, body: { reason: string }) =>
    call<{ ok: true; licenseId: string; subject: string | null }>(
      `${p(slug)}/users/relinks/${enc(relinkId)}/undo`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // ── product settings (LX-06: the row-backed slice of S-18 §4.7's settings API) ─────
  /** The row-backed settings of one settings-hub area, with the value in force. */
  productSettings: (slug: string, area?: string) =>
    call<{ settings: ProductSetting[] }>(
      `${p(slug)}/settings/effective${area ? `?area=${encodeURIComponent(area)}` : ""}`,
    ),
  /** ST-17: the console's claims against the last applied manifest, and the last apply's plan. */
  settingsDrift: (slug: string) =>
    call<SettingsDrift>(`${p(slug)}/settings/drift`),
  /** Set a setting in the console: on a repo-linked product this claims it from the manifest. */
  updateProductSetting: (
    slug: string,
    key: string,
    body: {
      value: unknown;
      expectedVersion: number;
      reason?: string;
      /** The setting's key, typed back for a change the registry confirms at L2. */
      confirm?: string;
    },
  ) =>
    call<{ ok: true; claimed: boolean; setting: ProductSetting }>(
      `${p(slug)}/settings/${encodeURIComponent(key)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** Revert a console setting to the manifest (or to its default on a manual product). */
  revertProductSetting: (
    slug: string,
    key: string,
    body: { expectedVersion: number; reason?: string; confirm?: string },
  ) =>
    call<{
      ok: true;
      applied: boolean;
      message?: string;
      setting: ProductSetting;
    }>(`${p(slug)}/settings/${encodeURIComponent(key)}`, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  // ── offline bundles ─────────────────────────────────────────────────────────
  /** Mint one offline activation bundle for an air-gapped device. Re-minting is cheap — the
   *  result is a signed artifact, not a secret the server forgets. */
  mintBundle: (slug: string, body: MintBundleBody) =>
    call<MintBundleResult>(`${p(slug)}/bundles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── enrollment & fingerprint policy (the settings `license.fingerprint`, `license.autoIssue`) ──
  fingerprintPolicy: async (slug: string): Promise<FingerprintPolicyResponse> =>
    fingerprintOf(await getSetting(slug, FINGERPRINT_KEY)),
  /** A partial patch: what the body omits keeps the policy the page loaded (`cur`), whose
   *  version the write carries. */
  updateFingerprintPolicy: async (
    slug: string,
    patch: Partial<FingerprintPolicyDto>,
    cur: Pick<FingerprintPolicyResponse, "policy" | "version">,
  ): Promise<FingerprintPolicyResponse> => {
    return fingerprintOf(
      (
        await writeSetting(slug, FINGERPRINT_KEY, "PATCH", {
          value: { ...cur.policy, ...patch },
          expectedVersion: cur.version,
        })
      ).setting,
    );
  },
  /** Both policies go back to the manifest (the auto-issue one only when it is claimed). */
  revertFingerprintPolicy: async (
    slug: string,
    expectedVersion: number,
  ): Promise<FingerprintPolicyResponse> => {
    const reverted = await writeSetting(slug, FINGERPRINT_KEY, "DELETE", {
      expectedVersion,
    });
    // The auto-issue policy is the secondary key of this revert; the page does not load it, so
    // it is read here, and only to learn whether the console holds it.
    const auto = await getSetting(slug, AUTO_ISSUE_KEY);
    if (auto.source === "console")
      await writeSetting(slug, AUTO_ISSUE_KEY, "DELETE", {
        expectedVersion: auto.version,
      });
    return fingerprintOf(reverted.setting);
  },

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
  /** F-33b.4: a read service token (`binding: "service"`), answered once with the `pkeyci_` value. */
  mintServiceToken: (scope: FeedScope, body: MintRegistryTokenBody) =>
    call<MintedServiceToken>(`${feedsBase(scope)}/tokens`, {
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

/**
 * The admin API client. Reads are called directly; WRITES go through `mutate()` in
 * `console/data/mutations.ts`, which runs each write's declared invalidation (ADMIN.md §5.4).
 * `test/mutations.test.ts` fails if a view calls a write on `api` directly.
 */

// ── The generic settings API (S-18 §4.7) as the pages that used bespoke routes read it ───────
// `GET …/settings/<key>`, `PATCH|DELETE …/settings/<key>`: one route family for every
// product setting. The pages keep their view models (`UpdateSettings`, `DeliveryAccess`,
// `FingerprintPolicyResponse`, `TrustPolicyResponse`); these functions build them.

const settingPath = (slug: string, key: string): string =>
  `/manage/api/products/${encodeURIComponent(slug)}/settings/${encodeURIComponent(key)}`;

async function getSetting(slug: string, key: string): Promise<ProductSetting> {
  return (await call<{ setting: ProductSetting }>(settingPath(slug, key)))
    .setting;
}

/**
 * Several settings by key, in parallel. A key the caller may not view answers 403 and is left out
 * (ST-29): the view built from the rest says what it could not read.
 */
async function getSettings(
  slug: string,
  keys: readonly string[],
): Promise<Map<string, ProductSetting>> {
  const got = await Promise.allSettled(keys.map((k) => getSetting(slug, k)));
  const out = new Map<string, ProductSetting>();
  got.forEach((r, i) => {
    if (r.status === "fulfilled") out.set(keys[i]!, r.value);
    else if (!(r.reason instanceof ApiError && r.reason.status === 403))
      throw r.reason;
  });
  return out;
}

async function writeSetting(
  slug: string,
  key: string,
  method: "PATCH" | "DELETE",
  body: object,
): Promise<{ setting: ProductSetting }> {
  return call<{ setting: ProductSetting }>(settingPath(slug, key), {
    method,
    body: JSON.stringify(body),
  });
}

/** The console's two owners of a block a resync can also write. */
const ownerOf = (s: ProductSetting): SettingsSource =>
  s.source === "console" ? "admin" : "manifest";

const TRUST_POLICY_KEY = "core.trustPolicy";
const FINGERPRINT_KEY = "license.fingerprint";
const AUTO_ISSUE_KEY = "license.autoIssue";
const DELIVERY_ACCESS_KEY = "distribution.access";
const UPDATE_ACCESS_KEY = "update.metadataAccess";
const UPDATE_COMPAT_KEY = "release.compatWindow";
const UPDATE_POLICY_KEY = "update.operatorPolicy";
const UPDATE_KEYS = [
  UPDATE_ACCESS_KEY,
  UPDATE_COMPAT_KEY,
  UPDATE_POLICY_KEY,
] as const;

function trustPolicyOf(s: ProductSetting): TrustPolicyResponse {
  return {
    ok: true,
    policy: s.value as TrustPolicyDto,
    source: s.source === "console" ? "admin" : "default",
    version: s.version,
  };
}

function fingerprintOf(s: ProductSetting): FingerprintPolicyResponse {
  return {
    version: s.version,
    policy: s.value as FingerprintPolicyDto,
    source: ownerOf(s),
  };
}

function updateSettingsOf(by: Map<string, ProductSetting>): UpdateSettings {
  // The API lists only the keys whose area the caller holds (ST-29): a member of Ship builds
  // without Settings does not get the access mode, which the view then says it could not read.
  const access = by.get(UPDATE_ACCESS_KEY);
  const compat = by.get(UPDATE_COMPAT_KEY);
  const policy = by.get(UPDATE_POLICY_KEY);
  const window = (compat?.value ?? { min: "", max: "" }) as {
    min: string;
    max: string;
  };
  const operator = (policy?.value ?? {}) as {
    requireSparkleSignature?: boolean;
    minimumSystemVersion?: string;
  };
  return {
    metadataAccess: (access?.value ?? "public") as ReleaseAccess,
    accessSource: access ? ownerOf(access) : "manifest",
    compatMin: window.min,
    compatMax: window.max,
    compatSource: compat ? ownerOf(compat) : "manifest",
    minimumSystemVersion: operator.minimumSystemVersion ?? null,
    requireSparkleSignature: operator.requireSparkleSignature !== false,
    configured: access?.blocked === undefined,
    ...(access ? {} : { hidden: true as const }),
    versions: {
      access: access?.version ?? 0,
      compat: compat?.version ?? 0,
      policy: policy?.version ?? 0,
    },
  };
}

const ACCESS_MODES: ReleaseAccess[] = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
];

function deliveryAccessOf(s: ProductSetting): DeliveryAccess {
  const rows = Object.entries(
    (s.value ?? {}) as Record<
      string,
      {
        mode: ReleaseAccess;
        entitlement: string | null;
        source: SettingsSource;
        modifiedAt: number;
      }
    >,
  );
  const app = rows.find(([id]) => id === "app")?.[1];
  return {
    version: s.version,
    modes: ACCESS_MODES,
    // Fail closed, as the worker does: no `app` row reads `entitled`.
    app: {
      deliverableId: "app",
      mode: app?.mode ?? "entitled",
      source: app?.source ?? "manifest",
    },
    deliverables: rows.map(([deliverableId, r]) => ({
      deliverableId,
      mode: r.mode,
      entitlement: r.entitlement,
      source: r.source,
      modifiedAt: r.modifiedAt,
    })),
  };
}

/** `GET …/sync/usage` (U-05.19): counts and bytes only, no person, subject or device. */
export type SyncUsageResponse =
  | { enabled: false }
  | {
      enabled: true;
      usage: {
        bytes: number;
        people: number;
        settingsBytes: number;
        recordBytes: number;
        fileBytes: number;
        revisionBytes: number;
        computedAt: number;
        breakdown: {
          byTier: {
            tierId: string | null;
            people: number;
            bytes: number;
            medianBytes: number;
            over80: number;
          }[];
          byKind: {
            settings: number;
            records: number;
            files: number;
            revisions: number;
          };
          byPlatform: {
            platform: string | null;
            peopleThisWeek: number;
            lastSyncAt: number;
          }[];
        };
      };
      today: { day: string; syncs: number; conflicts: number };
      tiers: { id: string; label: string; bytes: number | null }[];
      defaultBytes: number;
      /** The platform pause (U-05.21): `null` while writes run; `reason` only for Platform. */
      paused?: {
        since: number | null;
        by: string | null;
        reason: string | null;
      } | null;
    };

export const api: AdminApi = rawApi;

/** `GET /manage/api/search` (ST-52; worker `console/handlers/search.ts`). */
export interface SearchLicenseDto {
  product: string;
  productName: string;
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  expiresAt: number | null;
  tier: string | null;
}

export interface SearchDto {
  key: (SearchLicenseDto & { licenseId: string }) | null;
  licenses: SearchLicenseDto[];
  people: {
    product: string;
    productName: string;
    subject: string;
    name: string | null;
    email: string | null;
  }[];
}
