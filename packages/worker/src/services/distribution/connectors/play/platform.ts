/**
 * The Google Play side of the platform connection (A-16): the developer account's service
 * account, held once for the platform, and the listing of every app it can see with its track
 * status.
 *
 *   - **Which apps.** The Android Publisher API cannot enumerate apps; the Play Developer
 *     Reporting API can (`GET /v1beta1/apps:search`, every app the account may access). It is
 *     read at most `MAX_SEARCH_PAGES` pages of 1,000, on the fixed Reporting origin, with
 *     `redirect: "manual"` and a capped body, like every Play call.
 *   - **Track status (opt-in, `?tracks=1`).** For at most `MAX_TRACK_LOOKUPS` apps (in name order) one short edit is
 *     opened, its tracks listed and the edit deleted (`edits.insert` → `edits.tracks.list` →
 *     `edits.delete`, never committed) — the same discipline as the connector's poll: nothing is
 *     held open. Apps past the cap are listed without tracks (`truncated`). A-18e: each lookup
 *     first takes that package's EDIT LEASE (`lease.ts`, purpose `lister`); while another caller
 *     holds it (a provisioning run), that app is listed with a "busy" `tracksError` and no edit.
 *   - **Tokens.** From `platformGoogleAccessToken` for a TEAM-WIDE purpose, on behalf of the
 *     admin who asked (the platform audit's actor). A product's connector never uses this path.
 */

import type { Db, Env } from "../../../../core/platform.js";
import { platformGoogleAccessToken } from "../../../../core/outletTokens.js";
import {
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import type { PlatformEventActor } from "../../../../core/platformEvents.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  ANDROID_PUBLISHER_SCOPE,
  GoogleApiClient,
  MAX_RESPONSE_BYTES,
  PLAY_REPORTING_ORIGIN,
  PLAY_REPORTING_SCOPE,
  PlayError,
  PlayPublisher,
  type FetchImpl,
} from "./client.js";
import { errorLine } from "./run.js";
import { PlayEditLeaseHeld, withPlayEditLease } from "./lease.js";
import { PLAY_PLATFORM_CREDENTIAL } from "./setup.js";
import {
  cachedPlatformApps,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
  type PlatformStoreApp,
} from "../platformApps.js";

export interface PlatformPlayOptions {
  env: Env;
  db: Db;
  actor: PlatformEventActor;
  use: string;
  now: number;
  fetchImpl?: FetchImpl;
  refresh?: boolean;
  /** Read each app's tracks (a short, deleted edit per app). Opt-in only — never from the
   *  assignment path, which needs app ids alone. */
  tracks?: boolean;
}

export const MAX_SEARCH_PAGES = 3;
export const MAX_TRACK_LOOKUPS = 10;
const PAGE_TOKEN = /^[A-Za-z0-9_=+/.-]{1,512}$/;
const PACKAGE_NAME =
  /^(?=.{1,255}$)[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** A team-wide token at `scope` from the platform service account. */
function teamToken(o: PlatformPlayOptions, scope: string) {
  return () =>
    platformGoogleAccessToken(
      o.env,
      o.db,
      { team: o.actor },
      [scope],
      o.use,
      o.now,
      o.fetchImpl ?? ((u, i) => fetch(u, i)),
    );
}

/** `apps:search`, every page up to the cap. */
async function searchApps(o: PlatformPlayOptions): Promise<{
  apps: Array<{ packageName: string; displayName: string | null }>;
  more: boolean;
}> {
  const token = await teamToken(o, PLAY_REPORTING_SCOPE)();
  if (!token) throw new PlayError(401, "GET", "apps.search");
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const out: Array<{ packageName: string; displayName: string | null }> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const url = new URL("/v1beta1/apps:search", PLAY_REPORTING_ORIGIN);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok || isRedirect(res)) {
      await res.body?.cancel().catch(() => undefined);
      throw new PlayError(res.status, "GET", "apps.search");
    }
    let doc: { apps?: unknown; nextPageToken?: unknown };
    try {
      doc = JSON.parse(
        await readCappedText(
          res,
          MAX_RESPONSE_BYTES,
          () => new PlayError(502, "GET", "apps.search"),
        ),
      ) as typeof doc;
    } catch {
      throw new PlayError(502, "GET", "apps.search");
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new PlayError(502, "GET", "apps.search");
    for (const a of Array.isArray(doc.apps) ? doc.apps : []) {
      const r = a as { packageName?: unknown; displayName?: unknown };
      if (typeof r.packageName === "string" && PACKAGE_NAME.test(r.packageName))
        out.push({
          packageName: r.packageName,
          displayName:
            typeof r.displayName === "string"
              ? r.displayName.slice(0, 200)
              : null,
        });
    }
    pageToken =
      typeof doc.nextPageToken === "string" &&
      PAGE_TOKEN.test(doc.nextPageToken)
        ? doc.nextPageToken
        : null;
    if (!pageToken) return { apps: out, more: false };
  }
  return { apps: out, more: true };
}

/** A track list, summarised: id, then each release's name, status, fraction and version codes. */
function tracksView(doc: unknown) {
  const tracks = (doc as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.slice(0, 50).map((t) => {
    const tr = t as { track?: unknown; releases?: unknown };
    return {
      track: typeof tr.track === "string" ? tr.track : null,
      releases: (Array.isArray(tr.releases) ? tr.releases : [])
        .slice(0, 10)
        .map((r) => {
          const rel = r as Record<string, unknown>;
          return {
            name: typeof rel.name === "string" ? rel.name.slice(0, 200) : null,
            status: typeof rel.status === "string" ? rel.status : null,
            userFraction:
              typeof rel.userFraction === "number" ? rel.userFraction : null,
            versionCodes: Array.isArray(rel.versionCodes)
              ? rel.versionCodes
                  .filter((v): v is string => typeof v === "string")
                  .slice(0, 20)
              : [],
          };
        }),
    };
  });
}

async function readTracks(
  o: PlatformPlayOptions,
  packageName: string,
): Promise<ReturnType<typeof tracksView>> {
  const publisher = new PlayPublisher(
    new GoogleApiClient({
      origin: ANDROID_PUBLISHER_ORIGIN,
      packageName,
      token: teamToken(o, ANDROID_PUBLISHER_SCOPE),
      gated: true,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    }),
  );
  const leased = await withPlayEditLease(
    o.db,
    {
      packageName,
      purpose: "lister",
      actor: `admin:${o.actor.sub}`,
    },
    async () => {
      const edit = await publisher.insertEdit();
      try {
        return tracksView(await publisher.listTracks(edit));
      } finally {
        await publisher.deleteEdit(edit).catch(() => undefined);
      }
    },
  );
  if (!leased.ok)
    throw new PlayEditLeaseHeld(leased.held.purpose, leased.held.expiresAt);
  return leased.value;
}

async function fetchPlayApps(
  o: PlatformPlayOptions,
): Promise<{ apps: PlatformStoreApp[]; truncated: boolean }> {
  const { apps: found, more } = await searchApps(o);
  found.sort((a, b) =>
    (a.displayName ?? a.packageName).localeCompare(
      b.displayName ?? b.packageName,
      "en",
    ),
  );
  let truncated = more;
  const apps: PlatformStoreApp[] = [];
  for (const [i, a] of found.entries()) {
    let tracks: ReturnType<typeof tracksView> | null = null;
    let tracksError: string | null = null;
    if (!o.tracks) {
      // Not asked for: no edit is opened.
    } else if (i < MAX_TRACK_LOOKUPS) {
      try {
        tracks = await readTracks(o, a.packageName);
      } catch (e) {
        // One app the account cannot edit must not hide the rest: its status line is shown.
        tracksError =
          e instanceof PlayEditLeaseHeld
            ? `busy: a ${e.purpose} edit holds this app's edit lease`
            : errorLine(e);
      }
    } else truncated = true;
    apps.push({
      appId: a.packageName,
      name: a.displayName,
      pins: {},
      identifiers: { packageName: a.packageName },
      status: { tracks, tracksError },
    });
  }
  return { apps, truncated };
}

/** Every app the platform's Play service account can see, with track status (see the header). */
export async function listPlatformPlayApps(
  o: PlatformPlayOptions,
): Promise<PlatformAppsListing> {
  const ref = await resolvePlatformCredential(
    o.env,
    o.db,
    PLAY_PLATFORM_CREDENTIAL,
  );
  if (!ref) throw new PlatformStoreNotConfigured("google-play");
  return cachedPlatformApps(
    o.env,
    "google-play",
    // The track-status variant is cached apart from the plain list.
    o.tracks ? `${ref.version}:tracks` : ref.version,
    o.refresh === true,
    async () => {
      try {
        const { apps, truncated } = await fetchPlayApps(o);
        await recordPlatformCredentialResult(
          o.db,
          PLAY_PLATFORM_CREDENTIAL,
          { ok: true },
          o.now,
        );
        return {
          store: "google-play",
          source: ref.source,
          fetchedAt: o.now,
          truncated,
          apps,
        };
      } catch (e) {
        const message = errorLine(e);
        await recordPlatformCredentialResult(
          o.db,
          PLAY_PLATFORM_CREDENTIAL,
          { ok: false, error: message },
          o.now,
        );
        throw new PlatformStoreUnavailable(
          "google-play",
          e instanceof PlayError ? e.status : 502,
          message,
        );
      }
    },
  );
}
