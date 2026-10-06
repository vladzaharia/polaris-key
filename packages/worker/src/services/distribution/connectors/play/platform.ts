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
import {
  platformGoogleAccessToken,
  TokenExchangeError,
  transientGoogleAccessToken,
} from "../../../../core/outletTokens.js";
import type {
  OutletCredentialMeta,
  TransientOutletCredential,
} from "../../../../core/outletCredentials.js";
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

// ── the live check (UX-69, SETUP.md D42) ────────────────────────────────────────────────────

export interface PlayCheckOptions {
  /** The UNSAVED service-account key, validated (an RSA key, Google's token endpoint). */
  cred: TransientOutletCredential<"google-service-account">;
  now: number;
  /** The package names products are assigned on this connection. */
  assigned: readonly string[];
  current: OutletCredentialMeta | null;
  fetchImpl?: FetchImpl;
}

/** Apps read by the check: one page. Enough to name the account and spot assigned apps. */
const CHECK_PAGE = 1000;
const GOOGLE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * `error.status` and the first `error.details[].reason` of a Google error body (enum tokens such
 * as `PERMISSION_DENIED`, `SERVICE_DISABLED`), never its message. Reads at most 64 KiB.
 */
async function googleErrorReasons(res: Response): Promise<string[]> {
  try {
    const doc = JSON.parse(
      await readCappedText(res, 64 * 1024, () => new Error("too large")),
    ) as { error?: { status?: unknown; details?: unknown } };
    const out: string[] = [];
    const status = doc?.error?.status;
    if (typeof status === "string" && GOOGLE_REASON.test(status))
      out.push(status);
    for (const d of Array.isArray(doc?.error?.details)
      ? doc.error.details.slice(0, 10)
      : []) {
      const reason = (d as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string" && GOOGLE_REASON.test(reason))
        out.push(reason);
    }
    return out;
  } catch {
    await res.body?.cancel().catch(() => undefined);
    return [];
  }
}

/**
 * Check an unsaved Play service-account key: Google's token exchange (which proves the key is
 * live), then ONE page of the Play Developer Reporting API's `apps:search` (which proves the
 * service account was invited to a Play Console and names what it sees). Read-only: no edit is
 * opened. `redirect: "manual"`, capped bodies, one fixed host each.
 */
export async function checkPlayServiceAccount(
  o: PlayCheckOptions,
): Promise<CredentialCheck> {
  const email = (o.cred.meta as { clientEmail: string }).clientEmail;
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  let token: string;
  try {
    token = await transientGoogleAccessToken(
      o.cred,
      [PLAY_REPORTING_SCOPE],
      o.now,
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof TokenExchangeError && e.status >= 400 && e.status < 500)
      return checked(
        "invalid",
        "rejected",
        "Google did not accept this service-account key",
        e.code?.error === "invalid_grant"
          ? `The key was deleted or disabled, or ${email} no longer exists. Create a new JSON key for the service account (Google Cloud → IAM → Service accounts → Keys) and paste it.`
          : `Google refused the key for ${email}. Create a new JSON key for the service account (Google Cloud → IAM → Service accounts → Keys) and paste it.`,
        [{ label: "Service account", value: email }],
        { status: e.status },
      );
    return storeUnavailable(
      "Google",
      e instanceof TokenExchangeError ? e.status : 0,
    );
  }

  const url = new URL("/v1beta1/apps:search", PLAY_REPORTING_ORIGIN);
  url.searchParams.set("pageSize", String(CHECK_PAGE));
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    return storeUnavailable("Google Play", 0);
  }
  const facts: CheckFact[] = [{ label: "Service account", value: email }];
  if (res.status === 401 || res.status === 403) {
    const reasons = await googleErrorReasons(res);
    if (reasons.includes("SERVICE_DISABLED"))
      return checked(
        "invalid",
        "permission",
        "The Play Developer Reporting API is turned off for this key's Cloud project",
        "Polaris Key lists your apps through it. Enable the Google Play Developer Reporting API (and the Google Play Android Developer API) in the service account's Google Cloud project, then check again.",
        facts,
        { status: res.status },
      );
    return checked(
      "invalid",
      "permission",
      "This service account is not in your Play Console",
      `Invite ${email} in Play Console → Users and permissions, with access to your apps (Admin, or Release manager on each app), then check again. A new invitation can take a few minutes to apply.`,
      facts,
      { status: res.status },
    );
  }
  if (!res.ok || isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    return storeUnavailable("Google Play", res.status);
  }
  let doc: { apps?: unknown; nextPageToken?: unknown };
  try {
    doc = JSON.parse(
      await readCappedText(res, MAX_RESPONSE_BYTES, () => new Error("large")),
    ) as typeof doc;
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error("not an object");
  } catch {
    return storeUnavailable("Google Play", 502);
  }
  const apps = (Array.isArray(doc.apps) ? doc.apps : [])
    .map((a) => a as { packageName?: unknown; displayName?: unknown })
    .filter(
      (a): a is { packageName: string; displayName?: unknown } =>
        typeof a.packageName === "string" && PACKAGE_NAME.test(a.packageName),
    );
  const more = typeof doc.nextPageToken === "string";
  facts.push({ label: "Apps", value: `${apps.length}${more ? "+" : ""}` });
  const names = apps
    .map((a) => (typeof a.displayName === "string" ? a.displayName : null))
    .filter((n): n is string => n !== null)
    .slice(0, 3)
    .map((n) => n.slice(0, 80));
  if (names.length > 0)
    facts.push({ label: "First apps", value: names.join(", ") });

  const seen = new Set(apps.map((a) => a.packageName));
  // Past one page an unseen package may just be on a later page: no warning then.
  const hidden = more ? [] : o.assigned.filter((p) => !seen.has(p));
  if (hidden.length > 0)
    return hiddenAssignedApps(hidden, facts, "service account");
  if (apps.length === 0)
    return checked(
      "warning",
      "permission",
      "Google accepted the key, but the service account sees no apps",
      `Invite ${email} in Play Console → Users and permissions with access to your apps, then check again. A new invitation can take a few minutes to apply.`,
      facts,
    );
  if (o.current?.clientEmail && o.current.clientEmail !== email)
    facts.push({
      label: "Replaces",
      value: o.current.clientEmail,
    });
  return checked(
    "valid",
    "ok",
    `${email.split("@")[0]} · ${appCount(apps.length, more)}`,
    null,
    facts,
  );
}
