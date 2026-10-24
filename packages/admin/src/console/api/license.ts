/**
 * The license slice of the console API (P0-32.22): licenses, batches, keys, devices, holders, bundles, tiers and the fingerprint policy.
 * Types and the `licenseApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { LicenseTerms } from "../../../../worker/src/core/licensing/terms.js";
import type { OverrideUpdate, RedactedPayload } from "./config.js";
import {
  AUTO_ISSUE_KEY,
  FINGERPRINT_KEY,
  fingerprintOf,
  getSetting,
  writeSetting,
} from "./settings.js";
import { call, enc, p } from "./transport.js";

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
  deletion: LicenseDeletion;
  modifiedBy?: string;
  modifiedAt?: number;
  /** LX-14a: the licence's own device limit; `null` inherits. */
  deviceLimit?: number | null;
  /** The limit the Worker enforces at the next activation (0: no limit), and its source. */
  effectiveDeviceLimit: number;
  deviceLimitSource: DeviceLimitSource;
  /** What "Use inherited limit" falls back to: the tier's, an entitlement's or the product's. */
  inheritedDeviceLimit: number;
  inheritedDeviceLimitSource: Exclude<DeviceLimitSource, "license">;
  /** LX-32: every limit with the layer it came from (the Worker's one resolver). */
  terms: LicenseTerms;
  /**
   * LX-26 (S-24 D1): floating or assigned, derived by the Worker from the licence's account and
   * its own email.
   */
  holder: LicenseHolder;
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
 * `configOverridesView`). The licence layer is always read and always editable (U-27).
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
  seatDeviceCount: number;
  overrides: RedactedPayload;
  /** U-03. */
  configOverrides: LicenseConfigOverrides;
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
   *  the product's license defaults and it cannot be deleted. */
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

export const licenseApi = {
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
      const page: LicensePage = await licenseApi.licensesPage(slug, {
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
};
