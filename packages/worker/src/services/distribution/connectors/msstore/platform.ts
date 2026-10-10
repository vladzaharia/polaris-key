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

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
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
import {
  MSSTORE_PLATFORM_CREDENTIAL,
  platformMsStoreToken,
  transientMsStoreToken,
} from "./token.js";
import { TokenExchangeError } from "../../../../core/outletTokens.js";
import type {
  OutletCredentialMeta,
  TransientOutletCredential,
} from "../../../../core/outletCredentials.js";
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

// ── the live check (UX-69, SETUP.md D42) ────────────────────────────────────────────────────

export interface MsStoreCheckOptions {
  /** The UNSAVED Partner Center app (tenant, client id and secret, seller id). */
  cred: TransientOutletCredential<"ms-partner-center">;
  now: number;
  /** The Store IDs products are assigned on this connection. */
  assigned: readonly string[];
  current: OutletCredentialMeta | null;
  fetchImpl?: FetchImpl;
}

/**
 * Microsoft Entra's refusals the check can name (AADSTS numbers from the token endpoint's
 * `error_codes`; learn.microsoft.com/entra/identity-platform/reference-error-codes).
 */
function entraRefusal(
  e: TokenExchangeError,
  facts: CheckFact[],
): CredentialCheck {
  const sub = e.code?.subCode ?? null;
  const status = { status: e.status };
  if (sub === 7000222)
    return checked(
      "invalid",
      "expired",
      "This client secret has expired",
      "Create a new client secret for the app in Microsoft Entra ID → App registrations → Certificates & secrets, and paste its Value.",
      facts,
      { ...status, field: "value.clientSecret" },
    );
  if (sub === 7000215)
    return checked(
      "invalid",
      "rejected",
      "Microsoft Entra did not accept this client secret",
      "Paste the secret's Value, not its Secret ID. Both are shown once, when the secret is created in App registrations → Certificates & secrets.",
      facts,
      { ...status, field: "value.clientSecret" },
    );
  if (sub === 700016)
    return checked(
      "invalid",
      "wrong-account",
      "No app with this client ID exists in this tenant",
      "Check the tenant ID and the client ID (Application ID) on the app's Overview in Microsoft Entra ID: they must be the same app registration.",
      facts,
      { ...status, field: "value.clientId" },
    );
  if (sub === 90002 || sub === 900023)
    return checked(
      "invalid",
      "not-found",
      "Microsoft Entra has no such tenant",
      "Use the Directory (tenant) ID from the app's Overview in Microsoft Entra ID.",
      facts,
      { ...status, field: "value.tenantId" },
    );
  return checked(
    "invalid",
    "rejected",
    "Microsoft Entra did not accept this app's credentials",
    "Check the tenant ID, client ID and client secret against the app registration in Microsoft Entra ID.",
    facts,
    status,
  );
}

/**
 * Check an unsaved Partner Center app: Entra's client-credentials exchange (which proves the
 * tenant, app and secret), then ONE read of the Store submission API's `/v1.0/my/applications`
 * (which proves the app was added to Partner Center with a role, and names what it sees). GET
 * only; `redirect: "manual"`; capped bodies; fixed hosts.
 */
export async function checkMsPartnerCenter(
  o: MsStoreCheckOptions,
): Promise<CredentialCheck> {
  const m = o.cred.meta as {
    tenantId: string;
    clientId: string;
    sellerId: string;
  };
  const facts: CheckFact[] = [
    { label: "Tenant ID", value: m.tenantId },
    { label: "Client ID", value: m.clientId },
    { label: "Seller ID", value: m.sellerId },
  ];
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  let bearer: string;
  try {
    bearer = await transientMsStoreToken(o.cred, fetchImpl);
  } catch (e) {
    if (e instanceof TokenExchangeError) {
      if (e.status >= 400 && e.status < 500) return entraRefusal(e, facts);
      return storeUnavailable("Microsoft Entra", e.status);
    }
    if (e instanceof Error && /tenantId is invalid/.test(e.message))
      return checked(
        "invalid",
        "format",
        "This is not a tenant ID",
        "Use the Directory (tenant) ID, a GUID, or the tenant's verified domain (contoso.onmicrosoft.com).",
        [],
        { field: "value.tenantId" },
      );
    return storeUnavailable("Microsoft Entra", 0);
  }

  const url = new URL("/v1.0/my/applications", STORE_API_ORIGIN);
  url.searchParams.set("top", String(APP_PAGE));
  url.searchParams.set("skip", "0");
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
      },
    });
  } catch {
    return storeUnavailable("Partner Center", 0);
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return checked(
      "invalid",
      "permission",
      "This app is not added to Partner Center",
      `Microsoft Entra accepted it, but the Store API did not. In Partner Center → Account settings → User management → Microsoft Entra applications, add ${m.clientId} with the Manager role, then check again.`,
      facts,
      { status: res.status },
    );
  }
  if (!res.ok || isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    return storeUnavailable("Partner Center", res.status);
  }
  let doc: { value?: unknown; totalCount?: unknown };
  try {
    doc = JSON.parse(
      await readCappedText(res, MAX_RESPONSE_BYTES, () => new Error("large")),
    ) as typeof doc;
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error("not an object");
  } catch {
    return storeUnavailable("Partner Center", 502);
  }
  const value = (Array.isArray(doc.value) ? doc.value : []).filter(
    (v): v is Record<string, unknown> => !!v && typeof v === "object",
  );
  const total =
    typeof doc.totalCount === "number" && doc.totalCount >= value.length
      ? doc.totalCount
      : value.length;
  facts.push({ label: "Apps", value: String(total) });
  const names = value
    .map((a) => (typeof a.primaryName === "string" ? a.primaryName : null))
    .filter((n): n is string => n !== null)
    .slice(0, 3)
    .map((n) => n.slice(0, 80));
  if (names.length > 0)
    facts.push({ label: "First apps", value: names.join(", ") });
  const seen = new Set(
    value.map((a) => (typeof a.id === "string" ? a.id : "")),
  );
  const hidden =
    total > value.length ? [] : o.assigned.filter((id) => !seen.has(id));
  if (hidden.length > 0) return hiddenAssignedApps(hidden, facts, "app");
  if (o.current?.sellerId && o.current.sellerId !== m.sellerId)
    return checked(
      "warning",
      "wrong-account",
      "This app is for another seller account than the one connected now",
      `Its seller ID is ${m.sellerId}; the app connected now is for ${o.current.sellerId}. Saving it moves the connection to that seller.`,
      facts,
    );
  return checked(
    "valid",
    "ok",
    `Seller ${m.sellerId} · ${appCount(total)}`,
    null,
    facts,
  );
}
