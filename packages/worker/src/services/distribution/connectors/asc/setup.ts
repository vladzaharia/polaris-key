/**
 * Whether — and how — the App Store Connect connector runs for one product (P5-02).
 *
 * It runs when the product declares an `app-store` or `testflight` outlet in `.pkey/distribution`
 * (live, with the App Store Connect app id `appleId` in its identity) AND an operator has stored
 * an active `asc-api-key` outlet credential (P5-01). Without both, the webhook route answers the
 * service not-found shape and the poller skips the product.
 *
 * Credential choice: a credential bound to one of the product's Apple outlets (`outletId`) wins
 * over an unbound one; ties go to the lowest id. Only metadata is read here — listing never
 * selects the sealed column — so resolving the setup opens nothing.
 */

import type { Db } from "../../../../core/platform.js";
import { listOutletCredentials } from "../../../../core/outletCredentials.js";
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
  /** The `asc-api-key` credential id. */
  apiKeyId: string;
  /** The `asc-webhook-secret` credential id, if one is stored. */
  webhookSecretId: string | null;
}

const APPLE_ID = /^[0-9]{1,20}$/;

/** The product's App Store Connect setup, or `null` when the connector does not run for it. */
export async function ascSetup(
  db: Db,
  product: string,
): Promise<AscSetup | null> {
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
  if (!app) return null;
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
  const pick = (kind: string): string | null => {
    const ofKind = creds.filter((c) => c.kind === kind);
    const bound = ofKind.find(
      (c) => c.outletId !== null && appleOutlets.has(c.outletId),
    );
    const unbound = ofKind.find((c) => c.outletId === null);
    return (bound ?? unbound)?.id ?? null;
  };
  const apiKeyId = pick("asc-api-key");
  if (!apiKeyId) return null;
  return {
    product,
    appleId: app.appleId!,
    bundleId: app.bundleId,
    appStoreOutlet: appStore?.id ?? null,
    testflightOutlet: testflight?.id ?? null,
    apiKeyId,
    webhookSecretId: pick("asc-webhook-secret"),
  };
}

/** The outlet id for an outlet kind under this setup. */
export function outletFor(
  setup: AscSetup,
  kind: "app-store" | "testflight",
): string | null {
  return kind === "app-store" ? setup.appStoreOutlet : setup.testflightOutlet;
}
