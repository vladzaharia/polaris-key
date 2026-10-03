/**
 * Whether — and how — the Microsoft Store connector runs for one product (P5-04).
 *
 * It runs when the product declares a live `ms-store` outlet in `.pkey/distribution` whose
 * identity names the app's Store ID (`productId`), AND an operator has stored an active
 * `ms-partner-center` outlet credential (P5-01), AND that credential is PINNED to the same Store
 * ID (`OUTLET_CREDENTIAL_PINS`, the P5-02f pin). Without all three the poller skips the product
 * before any call and the console's `GET …/distribution/connectors/ms-store` says why (`inert`).
 *
 * **Why the pin.** A Partner Center Entra app with the Manager role reaches every app of the
 * seller account, and the `productId` is manifest-owned (every resync rewrites `dist_outlets`).
 * Without the pin a repo writer could aim the operator's credential at any app of the account and
 * read its submissions into this product. The connector only reads, so the harm is disclosure
 * and a polluted availability record rather than a store change — but the rule is the same as
 * for App Store Connect and Google Play: the manifest may only name the app the operator chose.
 *
 * **Channels.** The non-flighted submission is the `stable` channel. Package flights map through
 * the outlet's `flights` identity (declared channel → flight, named by its Partner Center
 * friendly name or its flight id). A flight Partner Center lists that no outlet maps is stored
 * and shown, never written, and never read beyond the flight list.
 *
 * Credential choice: one bound to one of the product's `ms-store` outlets (`outletId`) wins over
 * an unbound one; ties go to the lowest id. The pin is checked on the credential chosen. Only
 * metadata is read here — listing never selects the sealed column — so resolving opens nothing.
 */

import type { Db } from "../../../../core/platform.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import { listOutlets, parseJsonColumn } from "../../outlets.js";

export const MSSTORE_CONNECTOR = "ms-store";
export const MSSTORE_LABEL = "Microsoft Store";
export const MSSTORE_OUTLET_KINDS = ["ms-store"] as const;
export const MSSTORE_CREDENTIAL_KIND = "ms-partner-center";

/** The channel the non-flighted submission serves. */
export const MAIN_CHANNEL = "stable";

/** A Store ID (the manifest's rule, re-checked: it becomes a URL segment). */
export const STORE_ID = /^[A-Za-z0-9]{12}$/;
/** A flight reference in the manifest: a friendly name or a flight id (the manifest's rule). */
const FLIGHT_REF = /^[A-Za-z0-9][A-Za-z0-9 ._:()-]{0,99}$/;
/** A channel name as `dist_rollouts` keys it. */
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MsStoreRoute {
  outletId: string;
  channel: string;
}

export interface MsStoreSetup {
  product: string;
  /** The Store ID: the `applicationId` of every API path. */
  productId: string;
  outlets: Array<{ outletId: string; flights: Record<string, string> }>;
  /** The routes of the non-flighted submission: every outlet, channel `stable`. */
  mainRoutes: MsStoreRoute[];
  /** Every (flight reference → routes) the manifest declares. */
  flightRefs: Map<string, MsStoreRoute[]>;
  credentialId: string;
}

export type MsStoreInertReason =
  | "no_outlet"
  | "no_credential"
  | "pin_missing"
  | "pin_mismatch";

export interface MsStoreInert {
  reason: MsStoreInertReason;
  message: string;
  manifestProductId: string | null;
  credential: string | null;
  pinnedProductId: string | null;
}

export type MsStoreSetupResolution =
  | { setup: MsStoreSetup; inert: null }
  | { setup: null; inert: MsStoreInert };

export function isPinReason(
  reason: MsStoreInertReason,
): reason is "pin_missing" | "pin_mismatch" {
  return reason === "pin_missing" || reason === "pin_mismatch";
}

const inert = (
  reason: MsStoreInertReason,
  message: string,
  rest: Partial<Omit<MsStoreInert, "reason" | "message">> = {},
): MsStoreSetupResolution => ({
  setup: null,
  inert: {
    reason,
    message,
    manifestProductId: rest.manifestProductId ?? null,
    credential: rest.credential ?? null,
    pinnedProductId: rest.pinnedProductId ?? null,
  },
});

function identityOf(json: string): Record<string, unknown> {
  const v = parseJsonColumn(json);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function flightsOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [channel, flight] of Object.entries(v as Record<string, unknown>))
    if (
      CHANNEL.test(channel) &&
      channel !== MAIN_CHANNEL &&
      typeof flight === "string" &&
      FLIGHT_REF.test(flight)
    )
      out[channel] = flight;
  return out;
}

/** The routes a listed flight takes: those whose manifest reference is its id (any case) or its
 *  friendly name (exact). */
export function flightRoutes(
  setup: MsStoreSetup,
  flight: { flightId: string; friendlyName: string | null },
): MsStoreRoute[] {
  const out: MsStoreRoute[] = [];
  for (const [ref, routes] of setup.flightRefs)
    if (
      ref.toLowerCase() === flight.flightId.toLowerCase() ||
      (flight.friendlyName !== null && ref === flight.friendlyName)
    )
      for (const r of routes)
        if (
          !out.some((o) => o.outletId === r.outletId && o.channel === r.channel)
        )
          out.push(r);
  return out;
}

/** The product's Microsoft Store setup, or why the connector does not run for it. */
export async function resolveMsStoreSetup(
  db: Db,
  product: string,
): Promise<MsStoreSetupResolution> {
  const candidates = (await listOutlets(db, product))
    .filter(
      (o) =>
        o.removed_at === null &&
        (MSSTORE_OUTLET_KINDS as readonly string[]).includes(o.kind),
    )
    .map((o) => {
      const identity = identityOf(o.identity_json);
      return {
        outletId: o.outlet_id,
        productId:
          typeof identity.productId === "string" &&
          STORE_ID.test(identity.productId)
            ? identity.productId
            : null,
        flights: flightsOf(identity.flights),
      };
    })
    .filter((o) => o.productId !== null);
  // `listOutlets` orders by id: the lowest names the app.
  const primary = candidates[0];
  if (!primary)
    return inert(
      "no_outlet",
      "declare an ms-store outlet with a productId (the Store ID) in .pkey/distribution",
    );
  const productId = primary.productId!;
  const outlets = candidates
    .filter((o) => o.productId === productId)
    .map(({ outletId, flights }) => ({ outletId, flights }));

  const ids = new Set(outlets.map((o) => o.outletId));
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === MSSTORE_CREDENTIAL_KIND,
  );
  const credential =
    creds.find((c) => c.outletId !== null && ids.has(c.outletId)) ??
    creds.find((c) => c.outletId === null);
  if (!credential)
    return inert(
      "no_credential",
      "a platform admin must store an ms-partner-center outlet credential pinned to this app",
      { manifestProductId: productId },
    );
  const pin = checkOutletCredentialPin(credential, productId);
  if (!pin.ok)
    return inert(
      pin.reason,
      pin.reason === "pin_missing"
        ? `the ms-partner-center credential ${credential.id} is not pinned to an app: a platform admin must pin it to ${productId} (PUT …/outlet-credentials/${credential.id} with {"kind":"ms-partner-center","pin":"${productId}"}) after checking that this is the product's app`
        : `.pkey/distribution names Store ID ${productId}, but the ms-partner-center credential ${credential.id} is pinned to ${pin.pinned}: nothing is read until the manifest names the pinned app again, or a platform admin re-pins the credential to ${productId} after checking that this is the product's app`,
      {
        manifestProductId: productId,
        credential: credential.id,
        pinnedProductId: pin.pinned,
      },
    );

  const flightRefs = new Map<string, MsStoreRoute[]>();
  for (const o of outlets)
    for (const [channel, ref] of Object.entries(o.flights)) {
      const list = flightRefs.get(ref) ?? [];
      list.push({ outletId: o.outletId, channel });
      flightRefs.set(ref, list);
    }
  return {
    setup: {
      product,
      productId,
      outlets,
      mainRoutes: outlets.map((o) => ({
        outletId: o.outletId,
        channel: MAIN_CHANNEL,
      })),
      flightRefs,
      credentialId: credential.id,
    },
    inert: null,
  };
}
