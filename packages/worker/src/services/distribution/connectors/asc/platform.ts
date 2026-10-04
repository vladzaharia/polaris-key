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

import type { Db, Env } from "../../../../core/platform.js";
import { platformAscToken } from "../../../../core/outletTokens.js";
import {
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import type { PlatformEventActor } from "../../../../core/platformEvents.js";
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
        // The team key's budget is shared with every product's poller (core/asc/budget.ts).
        await recordTeamRate(o.env, "app-store", client.lastRate, o.now);
      }
    },
  );
}
