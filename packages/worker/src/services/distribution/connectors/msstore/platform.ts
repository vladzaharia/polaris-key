/**
 * The Microsoft Store side of the platform connection (A-16): the seller account's Partner Center
 * app, held once for the platform, and the listing of every app the seller can see.
 *
 *   - **Which apps.** `GET /v1.0/my/applications` (the Store submission API), paged by `top`/`skip`
 *     (never by `@nextLink`) for at most `MAX_APP_PAGES` pages of 100, on the fixed Store origin
 *     with `redirect: "manual"` and a capped body. Each app carries its Store ID, name, package
 *     family name and its last-published and pending submission ids.
 *   - **Status.** For at most `MAX_STATUS_LOOKUPS` apps with a pending submission, that
 *     submission is read (GET only — the connector sends nothing else either) for its `status`
 *     (`CommitStarted`, `PreProcessing`, `Certification`, `Release`, `Published`, …).
 *   - **Tokens.** From `platformMsStoreToken` for a TEAM-WIDE purpose, on behalf of the admin.
 */

import type { Db, Env } from "../../../../core/platform.js";
import {
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import type { PlatformEventActor } from "../../../../core/platformEvents.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import {
  MAX_RESPONSE_BYTES,
  MsStoreClient,
  MsStoreError,
  STORE_API_ORIGIN,
  SUBMISSION_ID,
  type FetchImpl,
} from "./client.js";
import { errorLine } from "./poll.js";
import { STORE_ID } from "./setup.js";
import { MSSTORE_PLATFORM_CREDENTIAL, platformMsStoreToken } from "./token.js";
import {
  cachedPlatformApps,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
  type PlatformStoreApp,
} from "../platformApps.js";

export interface PlatformMsStoreOptions {
  env: Env;
  db: Db;
  actor: PlatformEventActor;
  use: string;
  now: number;
  fetchImpl?: FetchImpl;
  refresh?: boolean;
}

export const APP_PAGE = 100;
export const MAX_APP_PAGES = 5;
export const MAX_STATUS_LOOKUPS = 10;

function submissionId(v: unknown): string | null {
  const id = (v as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && SUBMISSION_ID.test(id) ? id : null;
}

async function fetchMsStoreApps(
  o: PlatformMsStoreOptions,
): Promise<{ apps: PlatformStoreApp[]; truncated: boolean }> {
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const token = () =>
    platformMsStoreToken(
      o.env,
      o.db,
      { team: o.actor },
      o.use,
      o.now,
      fetchImpl,
    );
  const bearer = await token();
  if (!bearer) throw new MsStoreError(401, "applications");
  const raw: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (let page = 0; page < MAX_APP_PAGES; page++) {
    const url = new URL("/v1.0/my/applications", STORE_API_ORIGIN);
    url.searchParams.set("top", String(APP_PAGE));
    url.searchParams.set("skip", String(page * APP_PAGE));
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
      },
    });
    if (!res.ok || isRedirect(res)) {
      await res.body?.cancel().catch(() => undefined);
      throw new MsStoreError(res.status, "applications");
    }
    let doc: { value?: unknown; totalCount?: unknown };
    try {
      doc = JSON.parse(
        await readCappedText(
          res,
          MAX_RESPONSE_BYTES,
          () => new MsStoreError(502, "applications"),
        ),
      ) as typeof doc;
    } catch {
      throw new MsStoreError(502, "applications");
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new MsStoreError(502, "applications");
    const value = Array.isArray(doc.value) ? doc.value : [];
    for (const v of value)
      if (v && typeof v === "object") raw.push(v as Record<string, unknown>);
    const total =
      typeof doc.totalCount === "number" ? doc.totalCount : raw.length;
    if (value.length < APP_PAGE || raw.length >= total) break;
    if (page === MAX_APP_PAGES - 1) truncated = true;
  }

  const apps: PlatformStoreApp[] = [];
  let lookups = 0;
  for (const a of raw) {
    const id = typeof a.id === "string" && STORE_ID.test(a.id) ? a.id : null;
    if (!id) continue;
    const pending = submissionId(a.pendingApplicationSubmission);
    let pendingStatus: string | null = null;
    let statusError: string | null = null;
    if (pending) {
      if (lookups < MAX_STATUS_LOOKUPS) {
        lookups++;
        try {
          const sub = await new MsStoreClient({
            applicationId: id,
            token,
            fetchImpl,
          }).submission(pending);
          pendingStatus = typeof sub.status === "string" ? sub.status : null;
        } catch (e) {
          statusError = errorLine(e);
        }
      } else truncated = true;
    }
    const str = (v: unknown) =>
      typeof v === "string" ? v.slice(0, 200) : null;
    apps.push({
      appId: id,
      name: str(a.primaryName),
      pins: {},
      identifiers: {
        packageFamilyName: str(a.packageFamilyName),
        packageIdentityName: str(a.packageIdentityName),
      },
      status: {
        firstPublishedDate: str(a.firstPublishedDate),
        lastPublishedSubmission: submissionId(
          a.lastPublishedApplicationSubmission,
        ),
        pendingSubmission: pending,
        pendingStatus,
        statusError,
      },
    });
  }
  apps.sort((x, y) =>
    (x.name ?? x.appId).localeCompare(y.name ?? y.appId, "en"),
  );
  return { apps, truncated };
}

/** Every app the platform's Partner Center app can see (see the header). */
export async function listPlatformMsStoreApps(
  o: PlatformMsStoreOptions,
): Promise<PlatformAppsListing> {
  const ref = await resolvePlatformCredential(
    o.env,
    o.db,
    MSSTORE_PLATFORM_CREDENTIAL,
  );
  if (!ref) throw new PlatformStoreNotConfigured("microsoft-store");
  return cachedPlatformApps(
    o.env,
    "microsoft-store",
    ref.version,
    o.refresh === true,
    async () => {
      try {
        const { apps, truncated } = await fetchMsStoreApps(o);
        await recordPlatformCredentialResult(
          o.db,
          MSSTORE_PLATFORM_CREDENTIAL,
          { ok: true },
          o.now,
        );
        return {
          store: "microsoft-store",
          source: ref.source,
          fetchedAt: o.now,
          truncated,
          apps,
        };
      } catch (e) {
        const message = errorLine(e);
        await recordPlatformCredentialResult(
          o.db,
          MSSTORE_PLATFORM_CREDENTIAL,
          { ok: false, error: message },
          o.now,
        );
        throw new PlatformStoreUnavailable(
          "microsoft-store",
          e instanceof MsStoreError ? e.status : 502,
          message,
        );
      }
    },
  );
}
