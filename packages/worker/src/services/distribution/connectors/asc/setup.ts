/**
 * Whether — and how — the App Store Connect connector runs for one product (P5-02).
 *
 * It runs when the product declares an `app-store` or `testflight` outlet in `.pkey/distribution`
 * (live, with the App Store Connect app id `appleId` in its identity) AND an operator has stored
 * an active `asc-api-key` outlet credential (P5-01) AND that credential is PINNED to the same
 * `appleId` (P5-02f). Without all three, the webhook route answers the service not-found shape,
 * the poller skips the product, every control is refused, and the console's
 * `GET …/distribution/connectors/asc` says why (`inert`).
 *
 * **Why the pin.** The `appleId` is manifest-owned — every resync rewrites `dist_outlets` from the
 * repo — while the key is the operator's, and a team key sees every app of the team. Without the
 * pin a repo writer could aim the operator's key, and the console's irreversible `release` and
 * `phased-release/complete`, at any of those apps (THREAT-MODEL.md, "Who picks the outlet's
 * app"). With it, the manifest can only name the app the operator already chose; a manifest that
 * changes its `appleId` makes the connector inert until a platform admin re-pins
 * (`PUT …/outlet-credentials/<id>` with `{kind, pin}`, audited `outlet_credential.pin`). A missing
 * pin is refused like a wrong one, so a credential stored before pins existed does nothing.
 *
 * Credential choice: a credential bound to one of the product's Apple outlets (`outletId`) wins
 * over an unbound one; ties go to the lowest id. The pin is checked on the credential chosen —
 * another credential's matching pin never stands in for it. Only metadata is read here — listing
 * never selects the sealed column — so resolving the setup opens nothing.
 *
 * **The platform fallback (A-16).** A product with NO active `asc-api-key` of its own falls back
 * to the platform's team key (`app-store.api-key`: the console credential, else the
 * `PLATFORM_ASC_API_KEY` Worker secret). The team key sees every app of the team, so the pin is
 * just as mandatory: the product's PLATFORM pin (`platform_credential_pins`, set when a platform
 * admin assigns the app to the product) must equal the manifest's `appleId`, or the connector is
 * inert with the same reasons. A product's own key always takes precedence — an own key that is
 * unpinned or mis-pinned is inert, it never falls through to the team key. The token is minted by
 * `platformAscToken`, which re-checks the pin before its memo, and the open inside it checks it a
 * third time; one app can hold at most one product's platform pin (a table constraint).
 */

import type { Db, Env } from "../../../../core/platform.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import {
  platformPin,
  resolvePlatformCredential,
  type PlatformCredentialSource,
} from "../../../../core/platformCredentials.js";
import { listOutlets, parseJsonColumn } from "../../outlets.js";

export const ASC_CONNECTOR = "asc";
export const ASC_LABEL = "App Store Connect";
export const ASC_OUTLET_KINDS = ["app-store", "testflight"] as const;

export interface AscSetup {
  product: string;
  /** The App Store Connect app id (digits), from the outlet identity. */
  appleId: string;
  bundleId: string | null;
  /** The live `app-store`-kind outlet, if declared. */
  appStoreOutlet: string | null;
  /** The live `testflight`-kind outlet for the same app, if declared. */
  testflightOutlet: string | null;
  /** The API key the connector authenticates with: the product's own, or the platform's. */
  credential: AscCredentialRef;
  /** The `asc-webhook-secret` credential id, if one is stored. */
  webhookSecretId: string | null;
}

/** Which `asc-api-key` a setup uses (A-16). */
export type AscCredentialRef =
  | { source: "product"; credentialId: string }
  | { source: "platform"; origin: PlatformCredentialSource };

/** The platform credential the fallback uses. */
export const ASC_PLATFORM_CREDENTIAL = "app-store.api-key" as const;

/** A stable, non-secret label for a credential ref: the product credential's id, or
 *  `platform:app-store.api-key`. Rate budgets and the console key by it. */
export function ascCredentialLabel(ref: AscCredentialRef): string {
  return ref.source === "product"
    ? ref.credentialId
    : `platform:${ASC_PLATFORM_CREDENTIAL}`;
}

/** Why the connector does not run for a product. The pin reasons are the operator's to fix. */
export type AscInertReason =
  | "no_outlet"
  | "no_api_key"
  | "pin_missing"
  | "pin_mismatch";

export interface AscInert {
  reason: AscInertReason;
  /** A sentence for the console: what is missing and who fixes it. */
  message: string;
  /** The app the manifest's outlet names, when it names one. */
  manifestAppleId: string | null;
  /** The `asc-api-key` credential the setup chose, when there is one. */
  apiKeyCredential: string | null;
  /** The app that credential is pinned to (`null`: not pinned). */
  pinnedAppleId: string | null;
  /** Whose key the setup chose: the product's, the platform's team key (A-16), or none. */
  credentialSource: "product" | "platform" | null;
}

export type AscSetupResolution =
  | { setup: AscSetup; inert: null }
  | { setup: null; inert: AscInert };

const APPLE_ID = /^[0-9]{1,20}$/;

/** The product's App Store Connect setup, or `null` when the connector does not run for it. */
export async function ascSetup(
  env: Env,
  db: Db,
  product: string,
): Promise<AscSetup | null> {
  return (await resolveAscSetup(env, db, product)).setup;
}

const inert = (
  reason: AscInertReason,
  message: string,
  rest: Partial<Omit<AscInert, "reason" | "message">> = {},
): AscSetupResolution => ({
  setup: null,
  inert: {
    reason,
    message,
    manifestAppleId: rest.manifestAppleId ?? null,
    apiKeyCredential: rest.apiKeyCredential ?? null,
    pinnedAppleId: rest.pinnedAppleId ?? null,
    credentialSource: rest.credentialSource ?? null,
  },
});

/** The product's App Store Connect setup, or why the connector does not run for it. */
export async function resolveAscSetup(
  env: Env,
  db: Db,
  product: string,
): Promise<AscSetupResolution> {
  const outlets = (await listOutlets(db, product)).filter(
    (o) =>
      o.removed_at === null &&
      (ASC_OUTLET_KINDS as readonly string[]).includes(o.kind),
  );
  const withApp = outlets
    .map((o) => {
      const identity = parseJsonColumn(o.identity_json);
      const rec =
        identity && typeof identity === "object" && !Array.isArray(identity)
          ? (identity as Record<string, unknown>)
          : {};
      const appleId =
        typeof rec.appleId === "string" && APPLE_ID.test(rec.appleId)
          ? rec.appleId
          : null;
      const bundleId = typeof rec.bundleId === "string" ? rec.bundleId : null;
      return { id: o.outlet_id, kind: o.kind, appleId, bundleId };
    })
    .filter((o) => o.appleId !== null);
  const appStore = withApp.find((o) => o.kind === "app-store") ?? null;
  const app = appStore ?? withApp[0];
  if (!app)
    return inert(
      "no_outlet",
      "declare an app-store or testflight outlet with an appleId in .pkey/distribution",
    );
  // One app per product connector: a `testflight` outlet naming another app is not this one's.
  const testflight =
    withApp.find((o) => o.kind === "testflight" && o.appleId === app.appleId) ??
    null;

  const appleOutlets = new Set(
    [appStore?.id, testflight?.id].filter((x): x is string => !!x),
  );
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active",
  );
  const pick = (kind: string) => {
    const ofKind = creds.filter((c) => c.kind === kind);
    const bound = ofKind.find(
      (c) => c.outletId !== null && appleOutlets.has(c.outletId),
    );
    const unbound = ofKind.find((c) => c.outletId === null);
    return bound ?? unbound ?? null;
  };
  const appleId = app.appleId!;
  const apiKey = pick("asc-api-key");
  const setupFor = (credential: AscCredentialRef): AscSetupResolution => ({
    setup: {
      product,
      appleId,
      bundleId: app.bundleId,
      appStoreOutlet: appStore?.id ?? null,
      testflightOutlet: testflight?.id ?? null,
      credential,
      webhookSecretId: pick("asc-webhook-secret")?.id ?? null,
    },
    inert: null,
  });
  if (!apiKey) {
    // A-16: no key of the product's own — fall back to the platform team key, pin required.
    const platform = await resolvePlatformCredential(
      env,
      db,
      ASC_PLATFORM_CREDENTIAL,
    );
    if (!platform)
      return inert(
        "no_api_key",
        "a platform admin must store an asc-api-key outlet credential pinned to this app, or configure the platform App Store Connect connection and assign this app to the product",
        { manifestAppleId: appleId },
      );
    const pinned = await platformPin(db, ASC_PLATFORM_CREDENTIAL, product);
    if (pinned === null)
      return inert(
        "pin_missing",
        `the platform App Store Connect key is not assigned to an app for this product: a platform admin must assign app ${appleId} to ${product} (Platform → Store connections; PUT /manage/api/platform/store-connections/app-store/apps/${appleId}/product) after checking that this is the product's app`,
        { manifestAppleId: appleId, credentialSource: "platform" },
      );
    if (pinned !== appleId)
      return inert(
        "pin_mismatch",
        `.pkey/distribution names app ${appleId}, but the platform App Store Connect key is assigned to app ${pinned} for this product: nothing is read or changed until the manifest names the assigned app again, or a platform admin assigns app ${appleId} to ${product} after checking that this is the product's app`,
        {
          manifestAppleId: appleId,
          pinnedAppleId: pinned,
          credentialSource: "platform",
        },
      );
    return setupFor({ source: "platform", origin: platform.source });
  }
  const pin = checkOutletCredentialPin(apiKey, appleId);
  if (!pin.ok)
    return inert(
      pin.reason,
      pin.reason === "pin_missing"
        ? `the asc-api-key credential ${apiKey.id} is not pinned to an app: a platform admin must pin it to ${appleId} (PUT …/outlet-credentials/${apiKey.id} with {"kind":"asc-api-key","pin":"${appleId}"}) after checking that this is the product's app`
        : `.pkey/distribution names app ${appleId}, but the asc-api-key credential ${apiKey.id} is pinned to app ${pin.pinned}: nothing is read or changed until the manifest names the pinned app again, or a platform admin re-pins the credential to ${appleId} after checking that this is the product's app`,
      {
        manifestAppleId: appleId,
        apiKeyCredential: apiKey.id,
        pinnedAppleId: pin.pinned,
        credentialSource: "product",
      },
    );
  return setupFor({ source: "product", credentialId: apiKey.id });
}

/** The outlet id for an outlet kind under this setup. */
export function outletFor(
  setup: AscSetup,
  kind: "app-store" | "testflight",
): string | null {
  return kind === "app-store" ? setup.appStoreOutlet : setup.testflightOutlet;
}
