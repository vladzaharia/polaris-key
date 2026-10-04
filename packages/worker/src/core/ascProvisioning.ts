/**
 * Team provisioning on App Store Connect (A-17b; notes/S-14 §4, §5.1, §5.2, §7, §8.1 steps 2–4).
 *
 * The TEAM scope of A-17: what the New-app wizard does before any app record exists, so nothing
 * here can be pinned to a product yet. Every function takes an `AscClient` on the platform team
 * key (built by `connectors/asc/platform.ts`, the one reviewed builder), so every write passes
 * A-17a's deny-by-default write gate before a token is minted:
 *
 *   - **Bundle ids**: find by identifier (`filter[identifier]`, exact match kept client-side),
 *     list, and register (`POST /v1/bundleIds`). A duplicate answers 409
 *     `ENTITY_ERROR.ATTRIBUTE.INVALID` (A-17h); the ledger re-reads it by identifier and reports
 *     it as `existing`. Never rename or delete (the gate has no rule for either).
 *   - **Capabilities**: list a bundle id's capabilities and enable the wizard's types
 *     (`WIZARD_CAPABILITIES`), one ledger step per type, read-before-write by the deterministic id
 *     `<bundleIdResourceId>_<TYPE>` (A-17h). There is no `APP_ATTEST` capability type (A-17h): the
 *     wizard shows App Attest as an entitlement in the Godot export preset, with no portal step.
 *     App Groups and iCloud switch on here, but their identifiers are portal-only (S-14 §5.2).
 *   - **App lookup** by bundle id (`GET /v1/apps?filter[bundleId]=`): the wizard polls it while
 *     the operator creates the app record in the portal, because `POST /v1/apps` does not exist.
 *   - **Signing expiry**: certificates and profiles, READ only, projected to name, type, platform,
 *     state and expiry. Never a certificate's content or serial, never a profile's content: the
 *     gate refuses every certificate write and every profile delete anyway.
 *
 * Audit: a write is ONE `platform.asc.<op>` row in the platform trail (`ledger.ts` →
 * `recordAscAudit`, scope `team`), with Apple's before and after projections. Reads are not
 * audited, but the key open behind them is (`platform_credential.use`, A-16).
 */

import type { Db } from "./platform.js";
import type { AdminSession } from "./adminApi.js";
import {
  ascPath,
  attr,
  findIncluded,
  relId,
  single,
  type AscClient,
  type AscResource,
} from "./asc/client.js";
import { performStoreWrite, type StoreWriteResult } from "./storefront/ledger.js";
import { GATE_CAPABILITY_TYPES } from "./storefront/rules/appStore.js";

// ── The wizard's capability list ─────────────────────────────────────────────────────────────

export interface WizardCapability {
  /** Apple's `capabilityType`, or `APP_ATTEST` for the entitlement-only row. */
  type: string;
  label: string;
  /** `capability`: enabled on the App ID here. `entitlement`: nothing to do on the App ID. */
  kind: "capability" | "entitlement";
  /** What the operator still does elsewhere, when anything. */
  note: string | null;
}

/**
 * What the New-app wizard offers (S-14 §8.1 step 3). Every `capability` type is in the write
 * gate's `GATE_CAPABILITY_TYPES` (checked at load), so the gate never refuses a type offered here.
 */
export const WIZARD_CAPABILITIES: readonly WizardCapability[] = [
  {
    type: "IN_APP_PURCHASE",
    label: "In-App Purchase",
    kind: "capability",
    note: null,
  },
  {
    type: "PUSH_NOTIFICATIONS",
    label: "Push Notifications",
    kind: "capability",
    note: "the APNs key is created in the portal (Keys)",
  },
  {
    type: "APPLE_ID_AUTH",
    label: "Sign in with Apple",
    kind: "capability",
    note: null,
  },
  { type: "GAME_CENTER", label: "Game Center", kind: "capability", note: null },
  {
    type: "ASSOCIATED_DOMAINS",
    label: "Associated Domains",
    kind: "capability",
    note: "the domains go in the app's entitlements",
  },
  {
    type: "APP_GROUPS",
    label: "App Groups",
    kind: "capability",
    note: "assign the group identifier in the portal (Identifiers): there is no API for it",
  },
  {
    type: "ICLOUD",
    label: "iCloud",
    kind: "capability",
    note: "assign the iCloud container in the portal (Identifiers): there is no API for it",
  },
  {
    type: "APP_ATTEST",
    label: "App Attest",
    kind: "entitlement",
    note: "entitlement in the export preset; no portal step",
  },
];

for (const c of WIZARD_CAPABILITIES)
  if (c.kind === "capability" && !GATE_CAPABILITY_TYPES.includes(c.type))
    throw new Error(`wizard capability ${c.type} is not admitted by the gate`);

/** The types `enableCapability` accepts (the wizard's `capability` rows). */
export const ENABLEABLE_CAPABILITIES: readonly string[] =
  WIZARD_CAPABILITIES.filter((c) => c.kind === "capability").map((c) => c.type);

// ── Validation ───────────────────────────────────────────────────────────────────────────────

export const BUNDLE_PLATFORMS = ["IOS", "MAC_OS", "UNIVERSAL"] as const;
export type BundlePlatform = (typeof BUNDLE_PLATFORMS)[number];

/**
 * An explicit bundle identifier: reverse-DNS, at least two labels, letters, digits, `-` and `.`
 * only. No wildcard (`*`): a wildcard App ID cannot carry In-App Purchase or push.
 */
const BUNDLE_IDENTIFIER =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isBundleIdentifier(v: unknown): v is string {
  return typeof v === "string" && v.length <= 155 && BUNDLE_IDENTIFIER.test(v);
}

/** Apple's resource id of a bundle id (`HPA5436NK7`). */
export function isBundleResourceId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{1,40}$/.test(v);
}

/** The App ID's description: Apple refuses special characters, so letters, digits and spaces. */
export function isBundleName(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(v);
}

/** A name derived from the identifier when the operator gives none (`gg.acme.djdl` → `gg acme djdl`). */
export function defaultBundleName(identifier: string): string {
  return identifier
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

// ── Views (what the admin API answers) ───────────────────────────────────────────────────────

export interface BundleIdView {
  id: string;
  identifier: string | null;
  name: string | null;
  platform: string | null;
  /** The team prefix Apple shows beside the identifier (`seedId`). */
  seedId: string | null;
}

export function bundleIdView(r: AscResource): BundleIdView {
  return {
    id: r.id,
    identifier: attr(r, "identifier"),
    name: attr(r, "name"),
    platform: attr(r, "platform"),
    seedId: attr(r, "seedId"),
  };
}

export interface AppView {
  appId: string;
  name: string | null;
  bundleId: string | null;
  sku: string | null;
  primaryLocale: string | null;
}

export function appView(r: AscResource): AppView {
  return {
    appId: r.id,
    name: attr(r, "name"),
    bundleId: attr(r, "bundleId"),
    sku: attr(r, "sku"),
    primaryLocale: attr(r, "primaryLocale"),
  };
}

const BUNDLE_FIELDS = "identifier,name,platform,seedId";

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

/** The bundle id with exactly this identifier, or null (Apple's filter is not exact on its own). */
export async function findBundleId(
  client: AscClient,
  identifier: string,
): Promise<AscResource | null> {
  const { data } = await client.getAll(
    ascPath("bundleIds"),
    {
      "filter[identifier]": identifier,
      "fields[bundleIds]": BUNDLE_FIELDS,
      limit: "200",
    },
    2,
  );
  return (
    data.find(
      (r) => r.type === "bundleIds" && attr(r, "identifier") === identifier,
    ) ?? null
  );
}

/** One bundle id by Apple's resource id, or null. */
export async function getBundleId(
  client: AscClient,
  id: string,
): Promise<AscResource | null> {
  const r = single(
    await client.getOrNull(ascPath("bundleIds", id), {
      "fields[bundleIds]": BUNDLE_FIELDS,
    }),
  );
  return r && r.type === "bundleIds" ? r : null;
}

/** At most this many pages of 200 bundle ids are listed. */
export const MAX_BUNDLE_PAGES = 3;

/** The team's bundle ids (bounded), sorted by identifier. */
export async function listBundleIds(
  client: AscClient,
): Promise<{ bundleIds: BundleIdView[]; truncated: boolean }> {
  const { data } = await client.getAll(
    ascPath("bundleIds"),
    { "fields[bundleIds]": BUNDLE_FIELDS, limit: "200" },
    MAX_BUNDLE_PAGES,
  );
  const bundleIds = data
    .filter((r) => r.type === "bundleIds")
    .map(bundleIdView)
    .sort((a, b) =>
      String(a.identifier ?? a.id).localeCompare(String(b.identifier ?? b.id)),
    );
  return { bundleIds, truncated: data.length >= 200 * MAX_BUNDLE_PAGES };
}

/** A bundle id's capabilities as Apple reports them. */
export async function listCapabilities(
  client: AscClient,
  bundleResourceId: string,
): Promise<AscResource[]> {
  const { data } = await client.getAll(
    ascPath("bundleIds", bundleResourceId, "bundleIdCapabilities"),
    { "fields[bundleIdCapabilities]": "capabilityType", limit: "200" },
    1,
  );
  return data.filter((r) => r.type === "bundleIdCapabilities");
}

/** Apple's deterministic capability id (A-17h). */
export function capabilityId(bundleResourceId: string, type: string): string {
  return `${bundleResourceId}_${type}`;
}

function findCapability(
  caps: readonly AscResource[],
  bundleResourceId: string,
  type: string,
): AscResource | null {
  const id = capabilityId(bundleResourceId, type);
  return (
    caps.find((c) => c.id === id || attr(c, "capabilityType") === type) ?? null
  );
}

/**
 * The wizard's list for one bundle id: every offered row with whether it is on. Types Apple
 * reports that the wizard does not offer are listed as `other` (shown, never changed).
 */
export function capabilitiesView(
  caps: readonly AscResource[],
  bundleResourceId: string,
) {
  const offered = WIZARD_CAPABILITIES.map((c) => ({
    ...c,
    enabled:
      c.kind === "capability"
        ? findCapability(caps, bundleResourceId, c.type) !== null
        : null,
  }));
  const known = new Set(WIZARD_CAPABILITIES.map((c) => c.type));
  const other = caps
    .map((c) => attr(c, "capabilityType"))
    .filter((t): t is string => t !== null && !known.has(t))
    .sort();
  return { capabilities: offered, other };
}

/** The app whose bundle id is exactly `identifier`, or null (S-14 §5.1 step 3). */
export async function lookupAppByBundleId(
  client: AscClient,
  identifier: string,
): Promise<AscResource | null> {
  const { data } = await client.getAll(
    ascPath("apps"),
    {
      "filter[bundleId]": identifier,
      "fields[apps]": "name,bundleId,sku,primaryLocale",
      limit: "200",
    },
    1,
  );
  return (
    data.find((r) => r.type === "apps" && attr(r, "bundleId") === identifier) ??
    null
  );
}

// ── Signing expiry (read only) ───────────────────────────────────────────────────────────────

/** Days before expiry at which an item is flagged. */
export const EXPIRY_WARNING_DAYS = 30;

export type ExpiryState = "ok" | "expiring" | "expired" | "unknown";

export interface SigningItem {
  id: string;
  name: string | null;
  type: string | null;
  platform: string | null;
  /** Profiles only: `ACTIVE` | `INVALID`. */
  state: string | null;
  /** Profiles only: the identifier of the bundle id the profile is for. */
  bundleId: string | null;
  expirationDate: string | null;
  daysLeft: number | null;
  expiry: ExpiryState;
}

function expiryOf(
  date: string | null,
  now: number,
): { daysLeft: number | null; expiry: ExpiryState } {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t)) return { daysLeft: null, expiry: "unknown" };
  const daysLeft = Math.floor((t / 1000 - now) / 86400);
  return {
    daysLeft,
    expiry:
      t / 1000 <= now
        ? "expired"
        : daysLeft < EXPIRY_WARNING_DAYS
          ? "expiring"
          : "ok",
  };
}

const byExpiry = (a: SigningItem, b: SigningItem) =>
  String(a.expirationDate ?? "9999").localeCompare(
    String(b.expirationDate ?? "9999"),
  );

/** At most this many pages of 200 certificates and of 200 profiles. */
export const MAX_SIGNING_PAGES = 2;

/**
 * Certificates and profiles with their expiry (S-14 §4: read-only expiry warnings). The field
 * lists name only what is shown: a certificate's `certificateContent` and `serialNumber` and a
 * profile's `profileContent` are never requested, so they never reach the Worker.
 */
export async function signingExpiry(client: AscClient, now: number) {
  const certs = await client.getAll(
    ascPath("certificates"),
    {
      "fields[certificates]":
        "name,displayName,certificateType,platform,expirationDate",
      limit: "200",
    },
    MAX_SIGNING_PAGES,
  );
  const profiles = await client.getAll(
    ascPath("profiles"),
    {
      "fields[profiles]":
        "name,profileType,profileState,platform,expirationDate,bundleId",
      include: "bundleId",
      "fields[bundleIds]": "identifier",
      limit: "200",
    },
    MAX_SIGNING_PAGES,
  );
  const certificates: SigningItem[] = certs.data
    .filter((r) => r.type === "certificates")
    .map((r) => {
      const expirationDate = attr(r, "expirationDate");
      return {
        id: r.id,
        name: attr(r, "displayName") ?? attr(r, "name"),
        type: attr(r, "certificateType"),
        platform: attr(r, "platform"),
        state: null,
        bundleId: null,
        expirationDate,
        ...expiryOf(expirationDate, now),
      };
    })
    .sort(byExpiry);
  const profileItems: SigningItem[] = profiles.data
    .filter((r) => r.type === "profiles")
    .map((r) => {
      const expirationDate = attr(r, "expirationDate");
      const bundle = findIncluded(
        profiles.included,
        "bundleIds",
        relId(r, "bundleId"),
      );
      return {
        id: r.id,
        name: attr(r, "name"),
        type: attr(r, "profileType"),
        platform: attr(r, "platform"),
        state: attr(r, "profileState"),
        bundleId: attr(bundle, "identifier"),
        expirationDate,
        ...expiryOf(expirationDate, now),
      };
    })
    .sort(byExpiry);
  const all = [...certificates, ...profileItems];
  return {
    warningDays: EXPIRY_WARNING_DAYS,
    expiring: all.filter((i) => i.expiry === "expiring").length,
    expired: all.filter((i) => i.expiry === "expired").length,
    certificates,
    profiles: profileItems,
    truncated:
      certs.data.length >= 200 * MAX_SIGNING_PAGES ||
      profiles.data.length >= 200 * MAX_SIGNING_PAGES,
  };
}

// ── Writes (each one idempotent ledger step through the gate) ────────────────────────────────

export interface TeamWriteContext {
  db: Db;
  client: AscClient;
  session: AdminSession;
  now: number;
  /** The console's `Idempotency-Key` for this user intent. */
  idempotencyKey: string;
}

/** Register a bundle id, or find the one that already has this identifier. */
export function registerBundleId(
  c: TeamWriteContext,
  input: { identifier: string; name: string; platform: BundlePlatform },
): Promise<StoreWriteResult> {
  return performStoreWrite(c.db, {
    key: {
      store: "app-store",
      scope: "team",
      product: null,
      op: "bundle_id.register",
      naturalKey: input.identifier,
      idempotencyKey: c.idempotencyKey,
    },
    request: input,
    session: c.session,
    now: c.now,
    find: () => findBundleId(c.client, input.identifier),
    write: async () =>
      single(
        await c.client.post(ascPath("bundleIds"), {
          data: {
            type: "bundleIds",
            attributes: {
              identifier: input.identifier,
              name: input.name,
              platform: input.platform,
            },
          },
        }),
      ),
    reread: (id) => getBundleId(c.client, id),
    resultIds: (r) => ({ bundleId: r.id }),
    summary: (r) =>
      `Registered bundle id ${attr(r, "identifier") ?? input.identifier} (${attr(r, "platform") ?? input.platform}) on App Store Connect`,
  });
}

/** Enable one capability on a bundle id, or find it already on. */
export function enableCapability(
  c: TeamWriteContext,
  input: { bundleResourceId: string; identifier: string; type: string },
): Promise<StoreWriteResult> {
  if (!ENABLEABLE_CAPABILITIES.includes(input.type))
    throw new Error(`capability ${input.type} is not offered`);
  const id = capabilityId(input.bundleResourceId, input.type);
  const findIt = async () =>
    findCapability(
      await listCapabilities(c.client, input.bundleResourceId),
      input.bundleResourceId,
      input.type,
    );
  return performStoreWrite(c.db, {
    key: {
      store: "app-store",
      scope: "team",
      product: null,
      op: "capability.enable",
      naturalKey: id,
      idempotencyKey: c.idempotencyKey,
    },
    request: { bundleId: input.bundleResourceId, type: input.type },
    session: c.session,
    now: c.now,
    find: findIt,
    write: async () =>
      single(
        await c.client.post(ascPath("bundleIdCapabilities"), {
          data: {
            type: "bundleIdCapabilities",
            attributes: { capabilityType: input.type },
            relationships: {
              bundleId: {
                data: { type: "bundleIds", id: input.bundleResourceId },
              },
            },
          },
        }),
      ),
    // Apple has no GET of one capability: re-read the bundle id's list.
    reread: () => findIt(),
    resultIds: (r) => ({ capabilityId: r.id }),
    summary: () =>
      `Enabled ${input.type} on bundle id ${input.identifier} on App Store Connect`,
  });
}
