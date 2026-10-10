/**
 * App Store app setup for one product (A-17c; notes/S-14 §8.1 steps 6, 8, 9 and 10). Reached
 * like P5-02's controls — `POST /manage/api/products/<slug>/distribution/connectors/asc/setup/…`
 * — so the session, CSRF, rate-limit and platform-admin gates have already run.
 *
 *     setup/notifications-url          PATCH /v1/apps/{id}  the four subscriptionStatusUrl* (V2,
 *                                      production and sandbox), then a verification read
 *     setup/notifications-url/verify   GET   /v1/apps/{id}  (read only)
 *     setup/notifications-test         POST  /inApps/v1/notifications/test  (App Store Server API)
 *     setup/notifications-test/status  GET   /inApps/v1/notifications/test/{token}, plus the
 *                                      hook's own stored TEST event
 *     setup/beta-group                 POST  /v1/betaGroups  (internal or external)
 *     setup/beta-testers               POST  /v1/betaTesters, or the group's betaTesters linkage
 *     setup/availability               POST  /v2/appAvailabilities  (all territories; only while
 *                                      the app has none)
 *     setup/price                      POST  /v1/appPriceSchedules  (free; only while the app has
 *                                      no price schedule)
 *     setup/checklist                  the portal-only steps, ticked by the operator (no Apple call)
 *
 * **The pinned app, never the request's.** Every write targets the app the product's setup
 * resolves server-side (`resolveAscSetup`: the manifest's `appleId`, pinned by the operator or by
 * A-16's platform pin). One addition for the New-app wizard, which runs before the repo declares
 * an Apple outlet: with no outlet at all and no `asc-api-key` of the product's own, the platform
 * team key's PLATFORM PIN for the product names the app (A-16 sets it when a platform admin
 * assigns the app). Any manifest that names an app still wins, and a mismatch stays refused.
 * A beta group a request names is re-read with `include=app` and must be this app's.
 *
 * **Idempotent and audited (A-17a).** Each Apple write is one `performStoreWrite` step under the
 * request's `Idempotency-Key` header: natural-key read first (the four URL attributes, the group
 * name, the tester, the existing availability or price schedule), the gated write, a re-read, one
 * audit row (`distribution.asc.<op>`) and the ledger row with Apple's before and after.
 *
 * **The App Store Server Notifications URL (A-17h).** Apple answers the `PATCH` 200 and echoes the
 * URL, but did not persist it in the live check. So the control never trusts the echo: the
 * re-read after the write is the verification read, and when it does not show the URL in both
 * environments the answer carries the fallback — the App Information deep link and the URL to
 * paste — with `persisted: false`. `notifications-url/verify` repeats the read once the operator
 * has pasted it, and the test notification proves delivery end to end: Apple sends `TEST` to the
 * configured URL and the hook stores it (`commerce/index.ts`, `APP_STORE_EVENTS`).
 *
 * **Testers' emails are sent to Apple once and never stored.** A tester's natural key and request
 * hash carry `testerDigest` (keyed with the pepper and the never-stored Idempotency-Key), the
 * ledger projection keeps the tester's state only, and neither the answer nor the audit row
 * names an email.
 *
 * **Portal checklist.** Operator assertions, never verified: a tick stored per product in
 * Distribution's connector settings (`asc-setup`), audited.
 */

import { renderDeepLink } from "../../../../core/storefront/deeplinks.js";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import { audit } from "../../../../core/console/audit.js";
import { listOutletCredentials } from "../../../../core/outletCredentials.js";
import {
  platformPin,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import {
  AscError,
  AscWriteDenied,
  ascPath,
  ascPathV,
  attr,
  relId,
  single,
  type AscDocument,
  type AscResource,
} from "../../../../core/asc/client.js";
import {
  testerDigest,
  isIdempotencyKey,
  listStoreOperations,
  performStoreWrite,
  type StoreWriteResult,
} from "../../../../core/storefront/ledger.js";
import type { StoreProjection } from "../../../../core/storefront/audit.js";
import { readConnectorSettings, writeConnectorSettings } from "../settings.js";
import { APP_STORE_EVENTS } from "../../commerce/index.js";
import {
  appStoreCredential,
  getTestNotificationStatus,
  isTestNotificationToken,
  requestTestNotification,
  type AppleServerContext,
  type AppleServerEnvironment,
} from "../../commerce/apple.js";
import { StoreUnavailable } from "../../commerce/http.js";
import type { AscRun } from "./apply.js";
import {
  refuse,
  type ConnectorControl,
  type ControlContext,
  type ControlResult,
} from "./controls.js";
import { ascRun, finishRun } from "./run.js";
import {
  ASC_PLATFORM_CREDENTIAL,
  resolveAscSetup,
  type AscSetup,
} from "./setup.js";

// ── Deep links (undocumented by Apple: S-14 §4 [I]) ──────────────────────────────────────────

/**
 * App Store Connect and developer-portal pages for the portal-only steps, rendered from the one
 * deep-link table every store shares (`core/storefront/deeplinks.ts`, A-18a): a moved page is a
 * one-line fix there. A-17f's wizard reads them from the answers, never builds its own.
 */
export const ASC_DEEP_LINKS = {
  appInformation: (appleId: string) =>
    renderDeepLink("app-store.app-information", { appId: appleId }),
  appPrivacy: (appleId: string) =>
    renderDeepLink("app-store.app-privacy", { appId: appleId }),
  appStoreVersion: (appleId: string) =>
    renderDeepLink("app-store.version", { appId: appleId }),
  agreements: () => renderDeepLink("app-store.agreements"),
  identifiers: () => renderDeepLink("app-store.identifiers"),
} as const;

// ── The portal checklist (S-14 §8.1 step 10) ─────────────────────────────────────────────────

/** The settings slot of the checklist (`dist_connector_settings`; not a store connector). */
export const ASC_SETUP_SETTINGS = "asc-setup";

/** The portal-only steps an operator ticks. Order is the console's. */
export const ASC_CHECKLIST = [
  {
    item: "app_privacy",
    label: "App Privacy details",
    link: (id: string | null) => (id ? ASC_DEEP_LINKS.appPrivacy(id) : null),
  },
  {
    item: "agreements",
    label: "Agreements, tax and banking (paid apps and in-app purchases)",
    link: () => ASC_DEEP_LINKS.agreements(),
  },
  {
    item: "capability_identifiers",
    label: "App Group and iCloud container identifiers (if those are on)",
    link: () => ASC_DEEP_LINKS.identifiers(),
  },
  {
    item: "app_information",
    label: "App Information: category, age rating, content rights",
    link: (id: string | null) =>
      id ? ASC_DEEP_LINKS.appInformation(id) : null,
  },
  {
    item: "screenshots",
    label: "Screenshots and the App Store listing",
    link: (id: string | null) =>
      id ? ASC_DEEP_LINKS.appStoreVersion(id) : null,
  },
] as const;

export type AscChecklistItem = (typeof ASC_CHECKLIST)[number]["item"];

interface StoredTick {
  at: number;
  by: string;
}

function isChecklistItem(v: unknown): v is AscChecklistItem {
  return ASC_CHECKLIST.some((c) => c.item === v);
}

/** The stored ticks, normalised (an unknown item or a malformed tick is dropped). */
async function readTicks(
  db: Db,
  product: string,
): Promise<Partial<Record<AscChecklistItem, StoredTick>>> {
  const stored = await readConnectorSettings(db, product, ASC_SETUP_SETTINGS);
  const raw = stored?.value.checklist;
  const out: Partial<Record<AscChecklistItem, StoredTick>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isChecklistItem(k) || !v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (typeof t.at === "number" && typeof t.by === "string")
      out[k] = { at: t.at, by: t.by };
  }
  return out;
}

export interface AscChecklistView {
  item: AscChecklistItem;
  label: string;
  /** The page to do it in; null when the page needs the app id and none is known yet. */
  link: string | null;
  done: boolean;
  doneAt: number | null;
  doneBy: string | null;
}

export async function checklistView(
  db: Db,
  product: string,
  appleId: string | null,
): Promise<AscChecklistView[]> {
  const ticks = await readTicks(db, product);
  return ASC_CHECKLIST.map((c) => {
    const t = ticks[c.item];
    return {
      item: c.item,
      label: c.label,
      link: (c.link as (id: string | null) => string | null)(appleId),
      done: t !== undefined,
      doneAt: t?.at ?? null,
      doneBy: t?.by ?? null,
    };
  });
}

/**
 * The setup's progress for the console (`GET …/distribution/connectors/asc`, `provisioning`):
 * the checklist and the product's newest ledger rows (op, state, Apple ids, Apple's status and
 * code on a failure). Nothing personal: a tester's row names a digest.
 */
export async function provisioningView(
  db: Db,
  product: string,
  appleId: string | null,
): Promise<{
  checklist: AscChecklistView[];
  operations: Array<{
    opId: string;
    op: string;
    state: string;
    resultIds: Record<string, string>;
    appleStatus: number | null;
    appleCode: string | null;
    createdAt: number;
    finishedAt: number | null;
  }>;
}> {
  const rows = await listStoreOperations(db, { scope: "product", product }, 50);
  return {
    checklist: await checklistView(db, product, appleId),
    operations: rows.map((r) => ({
      opId: r.op_id,
      op: r.op,
      state: r.state,
      resultIds: parseIds(r.result_ids_json),
      appleStatus: r.vendor_status,
      appleCode: r.vendor_code,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    })),
  };
}

function parseIds(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function parseProjection(json: string | null): StoreProjection | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as StoreProjection;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// ── The setup a control runs against ─────────────────────────────────────────────────────────

const APPLE_ID = /^[0-9]{1,20}$/;

type Resolved = { setup: AscSetup } | { refusal: ControlResult };

/**
 * The product's setup (`resolveAscSetup`), or — with no Apple outlet declared yet and no key of
 * the product's own — the platform team key's pin for the product (see the header).
 */
async function provisionSetup(
  env: Env,
  db: Db,
  product: string,
): Promise<Resolved> {
  const { setup, inert } = await resolveAscSetup(env, db, product);
  if (setup) return { setup };
  if (inert.reason === "pin_missing" || inert.reason === "pin_mismatch")
    return {
      refusal: refuse(409, `credential_${inert.reason}`, inert.message),
    };
  if (inert.reason === "no_outlet") {
    const own = (await listOutletCredentials(db, product)).some(
      (c) => c.status === "active" && c.kind === "asc-api-key",
    );
    const platform = own
      ? null
      : await resolvePlatformCredential(env, db, ASC_PLATFORM_CREDENTIAL);
    if (platform) {
      const pinned = await platformPin(db, ASC_PLATFORM_CREDENTIAL, product);
      if (pinned === null)
        return {
          refusal: refuse(
            409,
            "credential_pin_missing",
            `no app is assigned to ${product}: a platform admin assigns one in Platform → Store connections after checking that it is this product's app`,
          ),
        };
      if (APPLE_ID.test(pinned))
        return {
          setup: {
            product,
            appleId: pinned,
            bundleId: null,
            appStoreOutlet: null,
            testflightOutlet: null,
            credential: { source: "platform", origin: platform.source },
            webhookSecretId: null,
          },
        };
    }
  }
  return {
    refusal: refuse(
      404,
      "not_configured",
      "App Store Connect is not configured for this product: assign its app in Platform → Store connections, or declare an app-store or testflight outlet with an appleId and store an asc-api-key credential pinned to that app",
    ),
  };
}

/** Run `fn` against the product's setup; Apple's and the gate's refusals become answers. */
async function withSetupRun(
  c: ControlContext,
  fn: (run: AscRun, setup: AscSetup) => Promise<ControlResult>,
): Promise<ControlResult> {
  const resolved = await provisionSetup(c.env, c.db, c.product);
  if ("refusal" in resolved) return resolved.refusal;
  const { setup } = resolved;
  const run = ascRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: "asc:setup",
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return await fn(run, setup);
  } catch (e) {
    error = e;
    if (e instanceof AscWriteDenied)
      return refuse(409, "write_denied", e.message);
    if (e instanceof AscError)
      return refuse(
        e.status === 404
          ? 404
          : e.status >= 500 || e.status === 429 || e.status === 0
            ? 502
            : 409,
        "store_refused",
        e.code ? `${e.message} (${e.code})` : e.message,
      );
    if (e instanceof StoreUnavailable)
      return e.status === 401
        ? refuse(
            409,
            "server_key_unusable",
            "the In-App Purchase key for this app could not be used: check it in Distribution → Outlet credentials or Platform → Store connections",
          )
        : refuse(502, "store_unavailable", e.message);
    throw e;
  } finally {
    await finishRun(run, error);
  }
}

/** The request's Idempotency-Key, or the refusal. */
function idempotencyKeyOf(c: ControlContext): string | ControlResult {
  return isIdempotencyKey(c.idempotencyKey)
    ? c.idempotencyKey
    : refuse(
        428,
        "idempotency_key_required",
        "send an Idempotency-Key header (a UUID per intent): a retry with the same key replays instead of writing twice",
      );
}

/** A ledger step's outcome as an answer (a replay answers what the done row stored). */
function stepAnswer(r: Exclude<StoreWriteResult, { outcome: "conflict" }>): {
  outcome: "written" | "existing" | "replayed";
  opId: string;
  resultIds: Record<string, string>;
  after: StoreProjection | null;
} {
  if (r.outcome === "replayed")
    return {
      outcome: "replayed",
      opId: r.row.op_id,
      resultIds: parseIds(r.row.result_ids_json),
      after: parseProjection(r.row.after_json),
    };
  return {
    outcome: r.outcome,
    opId: r.opId,
    resultIds: r.resultIds,
    after: r.after,
  };
}

const conflict = (): ControlResult =>
  refuse(
    409,
    "idempotency_conflict",
    "this Idempotency-Key was used for a different request: send a new key for a new intent",
  );

// ── App Store Server Notifications URL ───────────────────────────────────────────────────────

/** P6-01's hook, the only URL the control (and the write gate) will point Apple at. */
export function appStoreNotificationsUrl(
  origin: string,
  product: string,
): string {
  return `${origin}/${product}/distribution/hooks/app-store`;
}

const ASN_VERSION = "V2";
const ASN_FIELDS = [
  "subscriptionStatusUrl",
  "subscriptionStatusUrlVersion",
  "subscriptionStatusUrlForSandbox",
  "subscriptionStatusUrlVersionForSandbox",
] as const;

function asnWanted(url: string): Record<(typeof ASN_FIELDS)[number], string> {
  return {
    subscriptionStatusUrl: url,
    subscriptionStatusUrlVersion: ASN_VERSION,
    subscriptionStatusUrlForSandbox: url,
    subscriptionStatusUrlVersionForSandbox: ASN_VERSION,
  };
}

/** Whether Apple's attributes carry exactly the wanted four. */
function asnMatches(
  attributes: Record<string, unknown> | undefined,
  url: string,
): boolean {
  const want = asnWanted(url);
  return ASN_FIELDS.every((k) => attributes?.[k] === want[k]);
}

function readAppAsn(run: AscRun, appleId: string): Promise<AscResource | null> {
  return run.client
    .get(ascPath("apps", appleId), {
      "fields[apps]": ["name", "bundleId", ...ASN_FIELDS].join(","),
    })
    .then(single);
}

/** What Apple has for one environment: the URL (capped), its version, and whether it is ours. */
function asnEnvironment(
  app: AscResource | null,
  url: string,
  sandbox: boolean,
): { url: string | null; version: string | null; matches: boolean } {
  const u = attr(
    app,
    sandbox ? "subscriptionStatusUrlForSandbox" : "subscriptionStatusUrl",
  );
  const v = attr(
    app,
    sandbox
      ? "subscriptionStatusUrlVersionForSandbox"
      : "subscriptionStatusUrlVersion",
  );
  return {
    url: u === null ? null : u.slice(0, 512),
    version: v === null ? null : v.slice(0, 8),
    matches: u === url && v === ASN_VERSION,
  };
}

/** The portal fallback for a URL Apple did not persist (A-17h). */
function asnFallback(appleId: string, url: string) {
  return {
    deepLink: ASC_DEEP_LINKS.appInformation(appleId),
    url,
    version: ASN_VERSION,
    instructions:
      "In App Information → App Store Server Notifications, paste this URL as both the Production and the Sandbox Server URL, choose Version 2, save, then verify and send a test notification",
  };
}

const setNotificationsUrl: ConnectorControl = (c) => {
  const key = idempotencyKeyOf(c);
  if (typeof key !== "string") return Promise.resolve(key);
  return withSetupRun(c, async (run, setup) => {
    const url = appStoreNotificationsUrl(c.origin, c.product);
    const want = asnWanted(url);
    // The re-read after the write is the verification read; a failed one is "not verified".
    let verified: AscResource | null = null;
    const r = await performStoreWrite(c.db, {
      key: {
        store: "app-store",
        scope: "product",
        product: c.product,
        op: "app.notifications_url",
        naturalKey: setup.appleId,
        idempotencyKey: key,
      },
      request: { appleId: setup.appleId, ...want },
      session: c.session,
      now: c.now,
      find: () => readAppAsn(run, setup.appleId),
      satisfied: (app) => asnMatches(app.attributes, url),
      // A-17h: Apple answers this PATCH 200 with an echo of the URL it did not keep. The echo
      // is never evidence: returning null makes the ledger's after (and so a replay's answer)
      // the verification re-read, or the pre-read if that re-read fails.
      write: async () => {
        await run.client.patch(
          ascPath("apps", setup.appleId),
          {
            data: { type: "apps", id: setup.appleId, attributes: want },
          },
          // The gate admits the URL only on the origin this request arrived at.
          { hookOrigin: c.origin },
        );
        return null;
      },
      reread: async () => {
        verified = await readAppAsn(run, setup.appleId);
        return verified;
      },
      resultIds: (app) => ({ appleId: app.id }),
      summary: () =>
        `Set the App Store Server Notifications URL of app ${setup.appleId} to ${url} (V2, production and sandbox)`,
    });
    if (r.outcome === "conflict") return conflict();
    const step = stepAnswer(r);
    const persisted =
      step.outcome === "written"
        ? verified !== null &&
          asnMatches((verified as AscResource).attributes, url)
        : asnMatches(step.after?.attributes, url);
    return {
      ok: true,
      outcome: step.outcome,
      opId: step.opId,
      appleId: setup.appleId,
      url,
      version: ASN_VERSION,
      persisted,
      // A-17h: Apple accepts the PATCH without keeping it. The portal is the way that works.
      fallback: persisted ? null : asnFallback(setup.appleId, url),
    };
  });
};

const verifyNotificationsUrl: ConnectorControl = (c) =>
  withSetupRun(c, async (run, setup) => {
    const url = appStoreNotificationsUrl(c.origin, c.product);
    const app = await readAppAsn(run, setup.appleId);
    const production = asnEnvironment(app, url, false);
    const sandbox = asnEnvironment(app, url, true);
    const persisted = production.matches && sandbox.matches;
    return {
      ok: true,
      appleId: setup.appleId,
      url,
      version: ASN_VERSION,
      production,
      sandbox,
      persisted,
      fallback: persisted ? null : asnFallback(setup.appleId, url),
    };
  });

// ── The test notification round trip ────────────────────────────────────────────────────────

function environmentOf(v: unknown): AppleServerEnvironment | null {
  return v === "sandbox" ? "Sandbox" : v === "production" ? "Production" : null;
}

/** The App Store Server API context for the pinned app: Apple's bundle id and its key. */
async function serverContext(
  c: ControlContext,
  run: AscRun,
  setup: AscSetup,
): Promise<AppleServerContext | ControlResult> {
  const app = await readAppAsn(run, setup.appleId);
  const bundleId = attr(app, "bundleId");
  if (!bundleId)
    return refuse(
      502,
      "store_refused",
      "App Store Connect returned no bundle id for the app",
    );
  // The In-App Purchase key's pin is the bundle id (A-16): the product's own key pinned to it,
  // else the platform key with this product's pin on it.
  const credentialId = await appStoreCredential(
    c.env,
    c.db,
    c.product,
    bundleId,
  );
  if (!credentialId)
    return refuse(
      409,
      "no_server_key",
      `no In-App Purchase key is pinned to ${bundleId} for this product: store an app-store-server-key credential pinned to it, or assign the platform In-App Purchase key in Platform → Store connections`,
    );
  return {
    env: c.env,
    db: c.db,
    product: c.product,
    now: c.now,
    credentialId,
    bundleId,
  };
}

const sendTestNotification: ConnectorControl = (c, body) => {
  const environment = environmentOf(body.environment);
  if (!environment)
    return Promise.resolve(
      refuse(
        422,
        "invalid_body",
        'environment must be "sandbox" or "production"',
        ["environment"],
      ),
    );
  return withSetupRun(c, async (run, setup) => {
    const ctx = await serverContext(c, run, setup);
    if ("ok" in ctx) return ctx;
    const sent = await requestTestNotification(ctx, environment, "asc:setup");
    if (sent.status === "url_missing")
      return refuse(
        409,
        "notification_url_missing",
        `App Store Connect has no ${environment} Server Notifications URL for this app: set it (setup/notifications-url) or paste it in App Information (${ASC_DEEP_LINKS.appInformation(setup.appleId)})`,
      );
    if (sent.status === "refused")
      return refuse(
        409,
        "store_refused",
        `the App Store Server API refused the test notification${sent.errorCode !== null ? ` (errorCode ${sent.errorCode})` : ""}`,
      );
    await audit(
      c.db,
      c.product,
      c.session,
      c.now,
      "distribution.asc.notifications.test",
      { kind: "asc", id: setup.appleId },
      `Requested an App Store Server Notifications test (${environment}) for ${ctx.bundleId}`,
    );
    return {
      ok: true,
      environment: environment.toLowerCase(),
      testNotificationToken: sent.token,
      requestedAt: c.now,
    };
  });
};

const testNotificationStatus: ConnectorControl = (c, body) => {
  const environment = environmentOf(body.environment);
  const fields: string[] = [];
  if (!environment) fields.push("environment");
  if (!isTestNotificationToken(body.testNotificationToken))
    fields.push("testNotificationToken");
  const since =
    typeof body.since === "number" &&
    Number.isSafeInteger(body.since) &&
    body.since >= 0
      ? body.since
      : 0;
  if (fields.length > 0 || !environment)
    return Promise.resolve(
      refuse(
        422,
        "invalid_body",
        'environment ("sandbox" or "production") and testNotificationToken are required',
        fields,
      ),
    );
  return withSetupRun(c, async (run, setup) => {
    const ctx = await serverContext(c, run, setup);
    if ("ok" in ctx) return ctx;
    const status = await getTestNotificationStatus(
      ctx,
      environment,
      body.testNotificationToken as string,
      "asc:setup",
    );
    // The proof the hook got it: P6-01 stores every verified delivery, TEST included.
    const received = await c.db.first<{ received_at: number; outcome: string }>(
      `SELECT received_at, outcome FROM dist_connector_events
        WHERE product = ? AND connector = ? AND event_type = 'TEST' AND received_at >= ?
        ORDER BY received_at DESC LIMIT 1`,
      c.product,
      APP_STORE_EVENTS,
      since,
    );
    const attempts = status.found ? status.attempts : [];
    return {
      ok: true,
      environment: environment.toLowerCase(),
      found: status.found,
      attempts,
      delivered: attempts.some((a) => a.result === "SUCCESS"),
      received: received
        ? { at: received.received_at, outcome: received.outcome }
        : null,
    };
  });
};

// ── TestFlight groups and testers ────────────────────────────────────────────────────────────

/** A group name: Apple's display text. No `@` (a ledger natural key never carries one). */
const GROUP_NAME = /^[^\u0000-\u001f\u007f@]{1,50}$/;
const GROUP_ID = /^[A-Za-z0-9-]{1,128}$/;
const EMAIL = /^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,63}$/;
/** The most testers one request invites (each is a ledger step and up to three requests). */
export const MAX_TESTERS_PER_REQUEST = 25;

const GROUP_FIELDS =
  "name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLinkLimitEnabled,publicLinkLimit,feedbackEnabled";

const createBetaGroup: ConnectorControl = (c, body) => {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = body.kind;
  const fields: string[] = [];
  if (!GROUP_NAME.test(name)) fields.push("name");
  if (kind !== "internal" && kind !== "external") fields.push("kind");
  if (fields.length > 0)
    return Promise.resolve(
      refuse(
        422,
        "invalid_body",
        'name (1–50 characters, no @) and kind ("internal" or "external") are required',
        fields,
      ),
    );
  const key = idempotencyKeyOf(c);
  if (typeof key !== "string") return Promise.resolve(key);
  const internal = kind === "internal";
  return withSetupRun(c, async (run, setup) => {
    const r = await performStoreWrite(c.db, {
      key: {
        store: "app-store",
        scope: "product",
        product: c.product,
        op: "testflight.group.create",
        naturalKey: name,
        idempotencyKey: key,
      },
      request: { appleId: setup.appleId, name, internal },
      session: c.session,
      now: c.now,
      // Apple has no name filter for groups: list the app's and match (S-14 §7.3).
      find: async () => {
        const { data } = await run.client.getAll(
          ascPath("apps", setup.appleId, "betaGroups"),
          { limit: "200", "fields[betaGroups]": GROUP_FIELDS },
          3,
        );
        return data.find((g) => attr(g, "name") === name) ?? null;
      },
      write: async () =>
        single(
          await run.client.post(ascPath("betaGroups"), {
            data: {
              type: "betaGroups",
              attributes: internal
                ? { name, isInternalGroup: true, hasAccessToAllBuilds: true }
                : { name, isInternalGroup: false },
              relationships: {
                app: { data: { type: "apps", id: setup.appleId } },
              },
            },
          }),
        ),
      reread: async (id) =>
        single(
          await run.client.get(ascPath("betaGroups", id), {
            "fields[betaGroups]": GROUP_FIELDS,
          }),
        ),
      resultIds: (g) => ({ betaGroupId: g.id }),
      summary: () =>
        `Created the ${internal ? "internal" : "external"} TestFlight group "${name}" on app ${setup.appleId}`,
    });
    if (r.outcome === "conflict") return conflict();
    const step = stepAnswer(r);
    const isInternal = step.after?.attributes.isInternalGroup === true;
    if (isInternal !== internal)
      return refuse(
        409,
        "beta_group_name_taken",
        `the app already has an ${isInternal ? "internal" : "external"} group named "${name}": choose another name`,
      );
    return {
      ok: true,
      outcome: step.outcome,
      opId: step.opId,
      betaGroupId: step.resultIds.betaGroupId ?? step.after?.id ?? null,
      name,
      kind,
      group: step.after,
    };
  });
};

const TESTER_FIELDS = "inviteType,state";

/** The first resource of a collection document, or null. */
function firstOf(doc: AscDocument | null): AscResource | null {
  const d = doc?.data;
  const first = Array.isArray(d) ? d[0] : null;
  return first && typeof first.id === "string" ? first : null;
}

const addBetaTesters: ConnectorControl = (c, body) => {
  const groupId = body.betaGroupId;
  const raw = Array.isArray(body.emails) ? body.emails : null;
  const fields: string[] = [];
  if (typeof groupId !== "string" || !GROUP_ID.test(groupId))
    fields.push("betaGroupId");
  if (
    !raw ||
    raw.length === 0 ||
    raw.length > MAX_TESTERS_PER_REQUEST ||
    !raw.every(
      (e) => typeof e === "string" && e.length <= 254 && EMAIL.test(e.trim()),
    )
  )
    fields.push("emails");
  if (fields.length > 0)
    return Promise.resolve(
      refuse(
        422,
        "invalid_body",
        `betaGroupId and emails (1–${MAX_TESTERS_PER_REQUEST} addresses) are required`,
        fields,
      ),
    );
  const key = idempotencyKeyOf(c);
  if (typeof key !== "string") return Promise.resolve(key);
  // Deduplicated case-insensitively; the order is the request's, so outcomes line up with it.
  const emails = [
    ...new Set((raw as string[]).map((e) => e.trim().toLowerCase())),
  ];
  const group = groupId as string;
  return withSetupRun(c, async (run, setup) => {
    // A beta group id is all the request carries: it must be this app's.
    const g = single(
      await run.client.getOrNull(ascPath("betaGroups", group), {
        include: "app",
        "fields[betaGroups]": "name,isInternalGroup,app",
      }),
    );
    if (!g || relId(g, "app") !== setup.appleId)
      return refuse(
        404,
        "unknown_beta_group",
        `no beta group ${group} on this app`,
      );
    const groupName = attr(g, "name") ?? group;
    const results: Array<{
      outcome: "written" | "existing" | "replayed" | "failed" | "conflict";
      betaTesterId: string | null;
      appleStatus?: number;
      appleCode?: string | null;
    }> = [];
    for (const email of emails) {
      const digest = await testerDigest(
        "app-store",
        c.env.KEY_HASH_PEPPER,
        key,
        email,
      );
      const findInGroup = async () =>
        firstOf(
          await run.client.get(ascPath("betaTesters"), {
            "filter[email]": email,
            "filter[betaGroups]": group,
            "fields[betaTesters]": TESTER_FIELDS,
            limit: "1",
          }),
        );
      try {
        const r = await performStoreWrite(c.db, {
          key: {
            store: "app-store",
            scope: "product",
            product: c.product,
            op: "testflight.tester.add",
            naturalKey: `${group}:${digest}`,
            idempotencyKey: key,
          },
          // The digest stands for the email: the request hash is unsalted (ledger.ts).
          request: {
            appleId: setup.appleId,
            betaGroupId: group,
            tester: digest,
          },
          session: c.session,
          now: c.now,
          find: findInGroup,
          write: async () => {
            // A tester the app already has joins the group by linkage; a new one is invited.
            const known = firstOf(
              await run.client.get(ascPath("betaTesters"), {
                "filter[email]": email,
                "filter[apps]": setup.appleId,
                "fields[betaTesters]": TESTER_FIELDS,
                limit: "1",
              }),
            );
            if (known) {
              await run.client.post(
                ascPath("betaGroups", group, "relationships", "betaTesters"),
                { data: [{ type: "betaTesters", id: known.id }] },
              );
              return { type: "betaTesters", id: known.id };
            }
            return single(
              await run.client.post(ascPath("betaTesters"), {
                data: {
                  type: "betaTesters",
                  attributes: { email },
                  relationships: {
                    betaGroups: { data: [{ type: "betaGroups", id: group }] },
                  },
                },
              }),
            );
          },
          reread: async (id) =>
            single(
              await run.client.get(ascPath("betaTesters", id), {
                "fields[betaTesters]": TESTER_FIELDS,
              }),
            ),
          resultIds: (t) => ({ betaTesterId: t.id, betaGroupId: group }),
          // Never the email: a count of one, and the group.
          summary: () =>
            `Added a TestFlight tester to the group "${groupName}"`,
        });
        if (r.outcome === "conflict") {
          results.push({ outcome: "conflict", betaTesterId: null });
          continue;
        }
        const step = stepAnswer(r);
        results.push({
          outcome: step.outcome,
          betaTesterId: step.resultIds.betaTesterId ?? null,
        });
      } catch (e) {
        // Apple refused this address (an invalid or blocked email): record it and go on. A
        // transient failure (429, 5xx, network) or a gate refusal stops the whole request; the
        // done steps replay under the same key.
        if (
          e instanceof AscError &&
          e.status >= 400 &&
          e.status < 500 &&
          e.status !== 429
        ) {
          results.push({
            outcome: "failed",
            betaTesterId: null,
            appleStatus: e.status,
            appleCode: e.code,
          });
          continue;
        }
        throw e;
      }
    }
    const count = (o: string) => results.filter((x) => x.outcome === o).length;
    return {
      ok: true,
      betaGroupId: group,
      requested: emails.length,
      added: count("written"),
      alreadyMembers: count("existing") + count("replayed"),
      failed: count("failed"),
      conflicts: count("conflict"),
      // One per address, in the request's order (after de-duplication). No email is echoed.
      results,
    };
  });
};

// ── Availability and price defaults (S-14 §8.1 step 9) ───────────────────────────────────────

const TERRITORY = /^[A-Z]{3}$/;

const setDefaultAvailability: ConnectorControl = (c) => {
  const key = idempotencyKeyOf(c);
  if (typeof key !== "string") return Promise.resolve(key);
  return withSetupRun(c, async (run, setup) => {
    const find = async () =>
      single(
        await run.client.getOrNull(
          ascPath("apps", setup.appleId, "appAvailabilityV2"),
        ),
      );
    let territories = 0;
    const r = await performStoreWrite(c.db, {
      key: {
        store: "app-store",
        scope: "product",
        product: c.product,
        op: "app.availability",
        naturalKey: setup.appleId,
        idempotencyKey: key,
      },
      request: {
        appleId: setup.appleId,
        territories: "all",
        newTerritories: true,
      },
      session: c.session,
      now: c.now,
      // Any availability already set is the operator's: never changed here (a change could take
      // the app off sale; the gate admits this write only as a first-time set).
      find,
      write: async (existing) => {
        const { data } = await run.client.getAll(
          ascPath("territories"),
          { limit: "200", "fields[territories]": "currency" },
          3,
        );
        const ids = data.map((t) => t.id).filter((id) => TERRITORY.test(id));
        if (ids.length === 0) throw new AscError(502, "GET", "/v1/territories");
        territories = ids.length;
        return single(
          await run.client.post(
            ascPathV("v2", "appAvailabilities"),
            {
              data: {
                type: "appAvailabilities",
                attributes: { availableInNewTerritories: true },
                relationships: {
                  app: { data: { type: "apps", id: setup.appleId } },
                  territoryAvailabilities: {
                    data: ids.map((id) => ({
                      type: "territoryAvailabilities",
                      id: `\${ta-${id}}`,
                    })),
                  },
                },
              },
              included: ids.map((id) => ({
                type: "territoryAvailabilities",
                id: `\${ta-${id}}`,
                attributes: { available: true },
                relationships: {
                  territory: { data: { type: "territories", id } },
                },
              })),
            },
            { initial: existing === null },
          ),
        );
      },
      reread: () => find(),
      resultIds: (a) => ({ availabilityId: a.id }),
      summary: () =>
        `Made app ${setup.appleId} available in all ${territories} territories, and in new ones`,
    });
    if (r.outcome === "conflict") return conflict();
    const step = stepAnswer(r);
    return {
      ok: true,
      outcome: step.outcome,
      opId: step.opId,
      availabilityId: step.resultIds.availabilityId ?? null,
      territories: step.outcome === "written" ? territories : null,
      availableInNewTerritories:
        step.after?.attributes.availableInNewTerritories ?? null,
    };
  });
};

/** The App Store's price for "free" in a territory's price points. */
function isFree(point: AscResource): boolean {
  const p = attr(point, "customerPrice");
  return p !== null && p.trim() !== "" && Number(p) === 0;
}

const setFreePrice: ConnectorControl = (c, body) => {
  const base = body.baseTerritory === undefined ? "USA" : body.baseTerritory;
  if (typeof base !== "string" || !TERRITORY.test(base))
    return Promise.resolve(
      refuse(
        422,
        "invalid_body",
        "baseTerritory must be a three-letter territory code",
        ["baseTerritory"],
      ),
    );
  const key = idempotencyKeyOf(c);
  if (typeof key !== "string") return Promise.resolve(key);
  return withSetupRun(c, async (run, setup) => {
    const find = async () => {
      const schedule = single(
        await run.client.getOrNull(
          ascPath("apps", setup.appleId, "appPriceSchedule"),
          { include: "manualPrices,baseTerritory" },
        ),
      );
      if (!schedule) return null;
      // A schedule object with neither a base territory nor a price is not a price yet.
      const prices = schedule.relationships?.manualPrices?.data;
      const hasPrice = Array.isArray(prices) ? prices.length > 0 : !!prices;
      return hasPrice || relId(schedule, "baseTerritory") !== null
        ? schedule
        : null;
    };
    const r = await performStoreWrite(c.db, {
      key: {
        store: "app-store",
        scope: "product",
        product: c.product,
        op: "app.price",
        naturalKey: setup.appleId,
        idempotencyKey: key,
      },
      request: { appleId: setup.appleId, price: "free", baseTerritory: base },
      session: c.session,
      now: c.now,
      // An existing price is never changed here: that is a price change (typed, A-17e's).
      find,
      write: async (existing) => {
        const pricePoints = ascPath("apps", setup.appleId, "appPricePoints");
        const { data } = await run.client.getAll(
          pricePoints,
          {
            "filter[territory]": base,
            limit: "200",
            "fields[appPricePoints]": "customerPrice",
          },
          5,
        );
        const free = data.find(isFree);
        // No free tier in that territory: nothing was sent (Apple's 404 shape, no code).
        if (!free) throw new AscError(404, "GET", pricePoints);
        return single(
          await run.client.post(
            ascPath("appPriceSchedules"),
            {
              data: {
                type: "appPriceSchedules",
                relationships: {
                  app: { data: { type: "apps", id: setup.appleId } },
                  baseTerritory: { data: { type: "territories", id: base } },
                  manualPrices: {
                    data: [{ type: "appPrices", id: "${price-free}" }],
                  },
                },
              },
              included: [
                {
                  type: "appPrices",
                  id: "${price-free}",
                  attributes: { startDate: null },
                  relationships: {
                    appPricePoint: {
                      data: { type: "appPricePoints", id: free.id },
                    },
                  },
                },
              ],
            },
            { initial: existing === null },
          ),
        );
      },
      reread: () => find(),
      resultIds: (s) => ({ priceScheduleId: s.id }),
      summary: () =>
        `Set app ${setup.appleId}'s price to free (base territory ${base})`,
    });
    if (r.outcome === "conflict") return conflict();
    const step = stepAnswer(r);
    return {
      ok: true,
      outcome: step.outcome,
      opId: step.opId,
      priceScheduleId: step.resultIds.priceScheduleId ?? null,
      // "existing": the app already had a price, left as it was.
      free: step.outcome !== "existing",
      baseTerritory: base,
    };
  });
};

// ── The checklist control ────────────────────────────────────────────────────────────────────

const tickChecklist: ConnectorControl = async (c, body) => {
  const fields: string[] = [];
  if (!isChecklistItem(body.item)) fields.push("item");
  if (typeof body.done !== "boolean") fields.push("done");
  if (fields.length > 0)
    return refuse(
      422,
      "invalid_body",
      `item (${ASC_CHECKLIST.map((x) => x.item).join(", ")}) and done (boolean) are required`,
      fields,
    );
  const item = body.item as AscChecklistItem;
  const stored = await readConnectorSettings(
    c.db,
    c.product,
    ASC_SETUP_SETTINGS,
  );
  const ticks = await readTicks(c.db, c.product);
  if (body.done === true) ticks[item] = { at: c.now, by: c.session.sub };
  else delete ticks[item];
  await writeConnectorSettings(
    c.db,
    c.product,
    ASC_SETUP_SETTINGS,
    { ...(stored?.value ?? {}), checklist: ticks },
    c.session.sub,
    c.now,
  );
  const label = ASC_CHECKLIST.find((x) => x.item === item)!.label;
  await audit(
    c.db,
    c.product,
    c.session,
    c.now,
    `distribution.asc.checklist.${body.done ? "tick" : "untick"}`,
    { kind: "asc-checklist", id: item },
    `${body.done ? "Ticked" : "Unticked"} the App Store portal step "${label}" (an operator assertion; not verified)`,
  );
  const resolved = await resolveAscSetup(c.env, c.db, c.product);
  const appleId =
    resolved.setup?.appleId ??
    (await platformPin(c.db, ASC_PLATFORM_CREDENTIAL, c.product));
  return {
    ok: true,
    checklist: await checklistView(c.db, c.product, appleId),
  };
};

/** The setup controls, merged into the connector's table (`index.ts`). */
export const ASC_SETUP_CONTROLS: Readonly<Record<string, ConnectorControl>> = {
  "setup/notifications-url": setNotificationsUrl,
  "setup/notifications-url/verify": verifyNotificationsUrl,
  "setup/notifications-test": sendTestNotification,
  "setup/notifications-test/status": testNotificationStatus,
  "setup/beta-group": createBetaGroup,
  "setup/beta-testers": addBetaTesters,
  "setup/availability": setDefaultAvailability,
  "setup/price": setFreePrice,
  "setup/checklist": tickChecklist,
};
