/**
 * The App Store side of the platform connection (A-16): an App Store Connect client on the
 * platform's TEAM key, and the listing of every app that key can see with its distribution
 * status.
 *
 *   - `platformAscClient` — the reusable entry point (A-17's provisioning builds on it): the same
 *     `AscClient` the connector uses (fixed host, `redirect: "manual"`, bodies read through
 *     `readCappedText`, a `links.next` followed only to the same origin), its bearer minted from
 *     the platform key for a TEAM-WIDE purpose. Every key open is audited in the platform trail
 *     with the admin on whose behalf it ran. It is for the platform admin surface only: a
 *     product's connector never uses it — it goes through `setup.ts`, whose token is gated by the
 *     product's pin.
 *   - `listPlatformAscApps` — every app of the team (at most `MAX_APP_PAGES` pages of 200), each
 *     with its newest App Store versions and review state (`appVersionState`), its newest
 *     TestFlight versions, and — for at most `MAX_PHASED_LOOKUPS` apps whose newest version is
 *     live or about to be — the phased release. Cached briefly (`platformApps.ts`).
 */

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import {
  platformAscToken,
  transientAscToken,
} from "../../../../core/outletTokens.js";
import type {
  OutletCredentialMeta,
  TransientOutletCredential,
} from "../../../../core/outletCredentials.js";
import {
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import type { PlatformEventActor } from "../../../../core/ops/platformEvents.js";
import {
  AscClient,
  AscError,
  ascPath,
  attr,
  numAttr,
  single,
  type AscResource,
  type FetchImpl,
} from "../../../../core/asc/client.js";
import { recordTeamRate } from "../../../../core/storefront/budget.js";
import { ASC_PLATFORM_CREDENTIAL } from "./setup.js";
import {
  appCount,
  checked,
  hiddenAssignedApps,
  storeUnavailable,
  type CheckFact,
  type CredentialCheck,
} from "../credentialCheck.js";
import {
  cachedPlatformApps,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
  type PlatformStoreApp,
} from "../platformApps.js";

export interface PlatformAscOptions {
  env: Env;
  db: Db;
  /** The admin on whose behalf the team key is used (the platform audit's actor). */
  actor: PlatformEventActor;
  /** The audited `use` of a key open, e.g. `asc:platform-apps`. */
  use: string;
  now: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

/** An App Store Connect client on the platform team key, or `null` when none is usable. */
export async function platformAscClient(
  o: PlatformAscOptions,
): Promise<AscClient | null> {
  if (!(await resolvePlatformCredential(o.env, o.db, ASC_PLATFORM_CREDENTIAL)))
    return null;
  return new AscClient({
    token: () => platformAscToken(o.env, o.db, { team: o.actor }, o.use, o.now),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
}

/** At most this many pages of 200 apps (1,000 apps) are read. */
export const MAX_APP_PAGES = 5;
/** Versions per app the listing asks for (each `include` is capped at 50 by Apple). */
const VERSIONS_PER_APP = 5;
/** At most this many phased-release lookups (one request each) per listing. */
export const MAX_PHASED_LOOKUPS = 20;

/** App Store version states in which a phased release can be running or about to start. */
const PHASED_STATES = new Set([
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "PROCESSING_FOR_APP_STORE",
]);

function relIds(r: AscResource, name: string): string[] {
  const d = r.relationships?.[name]?.data;
  return Array.isArray(d)
    ? d.filter((x) => typeof x?.id === "string").map((x) => x.id)
    : [];
}

function versionView(v: AscResource) {
  return {
    id: v.id,
    platform: attr(v, "platform"),
    versionString: attr(v, "versionString"),
    // The review/release state (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `PENDING_DEVELOPER_RELEASE`,
    // `READY_FOR_DISTRIBUTION`, …); `appStoreState` is Apple's deprecated spelling.
    state: attr(v, "appVersionState") ?? attr(v, "appStoreState"),
    releaseType: attr(v, "releaseType"),
    createdDate: attr(v, "createdDate"),
  };
}

type VersionView = ReturnType<typeof versionView>;

/** Read the team's apps from App Store Connect (uncached). */
async function fetchAscApps(
  client: AscClient,
): Promise<{ apps: PlatformStoreApp[]; truncated: boolean }> {
  const { data, included } = await client.getAll(
    ascPath("apps"),
    {
      limit: "200",
      include: "appStoreVersions,preReleaseVersions",
      "limit[appStoreVersions]": String(VERSIONS_PER_APP),
      "limit[preReleaseVersions]": String(VERSIONS_PER_APP),
      "fields[apps]": "name,bundleId,sku,appStoreVersions,preReleaseVersions",
      "fields[appStoreVersions]":
        "platform,versionString,appStoreState,appVersionState,releaseType,createdDate",
      "fields[preReleaseVersions]": "version,platform",
    },
    MAX_APP_PAGES,
  );
  const byKey = new Map(included.map((r) => [`${r.type}/${r.id}`, r]));
  const pick = (type: string, ids: string[]) =>
    ids
      .map((id) => byKey.get(`${type}/${id}`))
      .filter((r): r is AscResource => r !== undefined);

  const APPLE_ID = /^[0-9]{1,20}$/;
  const apps: Array<PlatformStoreApp & { newest: VersionView | null }> = [];
  for (const app of data) {
    if (app.type !== "apps" || !APPLE_ID.test(app.id)) continue;
    const versions = pick("appStoreVersions", relIds(app, "appStoreVersions"))
      .map(versionView)
      .sort((a, b) =>
        String(b.createdDate ?? "").localeCompare(String(a.createdDate ?? "")),
      );
    const testflight = pick(
      "preReleaseVersions",
      relIds(app, "preReleaseVersions"),
    ).map((p) => ({
      id: p.id,
      version: attr(p, "version"),
      platform: attr(p, "platform"),
    }));
    const bundleId = attr(app, "bundleId");
    apps.push({
      appId: app.id,
      name: attr(app, "name"),
      pins: bundleId ? { "app-store.in-app-purchase-key": bundleId } : {},
      identifiers: { bundleId, sku: attr(app, "sku") },
      status: {
        appStore: { versions, phasedRelease: null },
        testflight: { versions: testflight },
      },
      newest: versions[0] ?? null,
    });
  }
  apps.sort((a, b) =>
    (a.name ?? a.appId).localeCompare(b.name ?? b.appId, "en"),
  );

  let lookups = 0;
  let truncated = false;
  for (const app of apps) {
    const v = app.newest;
    if (!v || !v.state || !PHASED_STATES.has(v.state)) continue;
    if (lookups >= MAX_PHASED_LOOKUPS) {
      truncated = true;
      continue;
    }
    lookups++;
    const doc = await client.getOrNull(
      ascPath("appStoreVersions", v.id, "appStoreVersionPhasedRelease"),
    );
    const phr = single(doc);
    if (phr)
      (app.status.appStore as { phasedRelease: unknown }).phasedRelease = {
        versionId: v.id,
        state: attr(phr, "phasedReleaseState"),
        currentDayNumber: numAttr(phr, "currentDayNumber"),
        startDate: attr(phr, "startDate"),
        totalPauseDuration: numAttr(phr, "totalPauseDuration"),
      };
  }
  // `getAll` stops at MAX_APP_PAGES; a full last page means there may be more.
  if (data.length >= 200 * MAX_APP_PAGES) truncated = true;
  return {
    apps: apps.map(({ newest: _newest, ...rest }) => rest),
    truncated,
  };
}

/**
 * Every app the platform's team key can see, with its distribution status. Throws
 * `PlatformStoreNotConfigured` when no platform key is usable and `PlatformStoreUnavailable`
 * (a status line) when App Store Connect refuses; records the outcome on the console credential's
 * health columns.
 */
export async function listPlatformAscApps(
  o: PlatformAscOptions & { refresh?: boolean },
): Promise<PlatformAppsListing> {
  const ref = await resolvePlatformCredential(
    o.env,
    o.db,
    ASC_PLATFORM_CREDENTIAL,
  );
  if (!ref) throw new PlatformStoreNotConfigured("app-store");
  return cachedPlatformApps(
    o.env,
    "app-store",
    ref.version,
    o.refresh === true,
    async () => {
      const client = (await platformAscClient(o))!;
      try {
        const { apps, truncated } = await fetchAscApps(client);
        await recordPlatformCredentialResult(
          o.db,
          ASC_PLATFORM_CREDENTIAL,
          { ok: true },
          o.now,
        );
        return {
          store: "app-store",
          source: ref.source,
          fetchedAt: o.now,
          truncated,
          apps,
        };
      } catch (e) {
        const status = e instanceof AscError ? e.status : 502;
        const message =
          e instanceof AscError
            ? e.message
            : "App Store Connect listing failed";
        await recordPlatformCredentialResult(
          o.db,
          ASC_PLATFORM_CREDENTIAL,
          { ok: false, error: message },
          o.now,
        );
        throw new PlatformStoreUnavailable("app-store", status, message);
      } finally {
        // The team key's budget is shared with every product's poller (core/storefront/budget.ts).
        await recordTeamRate(o.env, "app-store", client.lastRate, o.now);
      }
    },
  );
}

// ── the live check (UX-69, SETUP.md D42) ────────────────────────────────────────────────────

export interface AscCheckOptions {
  /** The UNSAVED key, validated (a P-256 `.p8`, a key id, an issuer id). */
  cred: TransientOutletCredential<"asc-api-key">;
  now: number;
  /** The Apple IDs products are assigned on this connection (the primary credential's pins). */
  assigned: readonly string[];
  /** The display metadata of the key connected now, if any (to spot another team). */
  current: OutletCredentialMeta | null;
  fetchImpl?: FetchImpl;
}

/** Apple IDs per `filter[id]` lookup (Apple caps a filter list well above this). */
const CHECK_FILTER_IDS = 50;

/**
 * Check an unsaved App Store Connect API key with ONE read: `GET /v1/apps?limit=200` (names and
 * bundle ids only), and — only when products are assigned apps beyond that first page — one
 * `filter[id]` read for those. GETs through `AscClient`, so the write gate stands in front of it
 * anyway; no user, key, certificate or device endpoint is touched (S-14 §7.5). No retries: a
 * 429 is answered as "check again", not waited out.
 */
export async function checkAscApiKey(
  o: AscCheckOptions,
): Promise<CredentialCheck> {
  const { keyId, issuerId } = o.cred.meta as {
    keyId: string;
    issuerId: string;
  };
  const token = await transientAscToken(o.cred, o.now);
  const client = new AscClient({
    token: () => Promise.resolve(token),
    maxRetries: 0,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  let doc;
  try {
    doc = await client.get(ascPath("apps"), {
      limit: "200",
      "fields[apps]": "name,bundleId",
    });
  } catch (e) {
    return ascRefusal(e);
  }
  const apps = (Array.isArray(doc?.data) ? doc.data : []).filter(
    (a) => a.type === "apps",
  );
  const paging = (doc as { meta?: { paging?: { total?: unknown } } } | null)
    ?.meta?.paging;
  const total =
    typeof paging?.total === "number" && paging.total >= apps.length
      ? paging.total
      : apps.length;
  const facts: CheckFact[] = [
    { label: "Issuer ID (team)", value: issuerId },
    { label: "Key ID", value: keyId },
    { label: "Apps", value: String(total) },
  ];
  const names = apps
    .map((a) => attr(a, "name"))
    .filter((n): n is string => typeof n === "string")
    .slice(0, 3);
  if (names.length > 0)
    facts.push({
      label: total > names.length ? "First apps" : "Apps seen",
      value: names.join(", "),
    });

  const seen = new Set(apps.map((a) => a.id));
  let hidden = o.assigned.filter((id) => !seen.has(id));
  if (hidden.length > 0 && total > apps.length) {
    try {
      const more = await client.get(ascPath("apps"), {
        "filter[id]": hidden.slice(0, CHECK_FILTER_IDS).join(","),
        "fields[apps]": "bundleId",
        limit: String(CHECK_FILTER_IDS),
      });
      const found = new Set(
        (Array.isArray(more?.data) ? more.data : []).map((a) => a.id),
      );
      hidden = hidden.filter((id) => !found.has(id));
    } catch (e) {
      return ascRefusal(e);
    }
  }
  if (hidden.length > 0) return hiddenAssignedApps(hidden, facts, "key");
  if (o.current?.issuerId && o.current.issuerId !== issuerId)
    return checked(
      "warning",
      "wrong-account",
      "This key belongs to another team than the one connected now",
      `Its issuer ID is ${issuerId}; the key connected now is from ${o.current.issuerId}. Saving it moves the connection to that team.`,
      facts,
    );
  if (total === 0)
    return checked(
      "warning",
      "permission",
      "App Store Connect accepted the key, but it sees no apps",
      "The team has no apps yet, or the key's access is limited to apps it was not given. Create the app record in App Store Connect, or use a key with access to all apps.",
      facts,
    );
  return checked(
    "valid",
    "ok",
    `Team ${issuerId.split("-")[0]} · ${appCount(total)}`,
    null,
    facts,
  );
}

/** App Store Connect's refusal of a key, in words. */
function ascRefusal(e: unknown): CredentialCheck {
  // Not an answer at all (no connection, DNS, a reset): App Store Connect answered nothing.
  if (!(e instanceof AscError)) return storeUnavailable("App Store Connect", 0);
  if (e.status === 401)
    return checked(
      "invalid",
      "rejected",
      "App Store Connect did not accept this key",
      "The key ID, issuer ID and .p8 must all come from the same key, and the key must not be revoked. Compare them with Users and Access → Integrations → App Store Connect API.",
      [],
      { status: 401 },
    );
  if (e.status === 403)
    return checked(
      "invalid",
      "permission",
      "This key's role cannot read the team's apps",
      "Polaris Key needs a team key (not an individual key) with the App Manager or Admin role and access to all apps. Generate one in Users and Access → Integrations → App Store Connect API.",
      [],
      { status: 403 },
    );
  return storeUnavailable("App Store Connect", e.status);
}
