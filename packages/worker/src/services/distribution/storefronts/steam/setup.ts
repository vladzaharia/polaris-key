/**
 * Which Steam app the Steam storefront adapter acts on for one product, and with which key
 * (A-18g; the same rules as P5-04's Microsoft Store setup and A-17c's App Store setup).
 *
 *   - **The app** is the lowest live `steam` outlet's `appId` in `.pkey/distribution`. With no
 *     Steam outlet declared yet (a product being set up for Steam) and no `steam-publisher-key`
 *     of its own, the platform group key's PLATFORM PIN for the product names it (A-16: a platform
 *     admin assigned the app to the product after checking it).
 *   - **The key** is the product's own `steam-publisher-key` (bound to one of those outlets, else
 *     unbound), which must be PINNED to the app; else, with no own key at all, the platform group
 *     key (`steam.publisher-key`), whose pin must be the app. A mis-pinned own key never falls
 *     through to the platform key. Metadata only: nothing is opened here.
 *
 * Without all of that the adapter is inert and says why, in the connectors' vocabulary.
 */

import { effectiveTrackMap } from "@polaris-key/manifest";
import { parseJsonColumn } from "../../../../platform/json.js";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import {
  platformCredentialHandle,
  platformPin,
  resolvePlatformCredential,
} from "../../../../core/platformCredentials.js";
import { STEAM_NUMERIC_ID } from "../../../../core/steam/client.js";
import { STEAM_PLATFORM_CREDENTIAL } from "../../commerce/steam.js";
import { listOutlets } from "../../outlets.js";
import {
  platformFallback,
  platformFallbackMessage,
} from "../../connectors/platformFallback.js";

export const STEAM_CREDENTIAL_KIND = "steam-publisher-key";

export interface SteamSetup {
  product: string;
  appId: string;
  /** The declared channel → branch map of the outlets naming the app (identity `branches`). */
  branches: Record<string, string>;
  outletIds: string[];
  credentialId: string;
  credentialSource: "product" | "platform";
}

export type SteamInertReason =
  | "no_outlet"
  | "no_credential"
  | "pin_missing"
  | "pin_mismatch";

export interface SteamInert {
  reason: SteamInertReason;
  message: string;
  appId: string | null;
}

export type SteamSetupResolution =
  | { setup: SteamSetup; inert: null }
  | { setup: null; inert: SteamInert };

const inert = (
  reason: SteamInertReason,
  message: string,
  appId: string | null,
): SteamSetupResolution => ({
  setup: null,
  inert: { reason, message, appId },
});

function identityOf(json: string): Record<string, unknown> {
  const v = parseJsonColumn(json);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function branchesOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [channel, branch] of Object.entries(v as Record<string, unknown>))
    if (typeof branch === "string" && BRANCH.test(branch))
      out[channel] = branch;
  return out;
}

/** The product's Steam setup, or why the adapter is inert for it. */
export async function resolveSteamSetup(
  env: Env,
  db: Db,
  product: string,
): Promise<SteamSetupResolution> {
  const outlets = (await listOutlets(db, product))
    .filter((o) => o.removed_at === null && o.kind === "steam")
    .map((o) => {
      const identity = identityOf(o.identity_json);
      const raw =
        typeof identity.appId === "number"
          ? String(identity.appId)
          : identity.appId;
      return {
        outletId: o.outlet_id,
        appId:
          typeof raw === "string" && STEAM_NUMERIC_ID.test(raw) ? raw : null,
        branches: effectiveTrackMap("steam", branchesOf(identity.branches)),
      };
    })
    .filter((o) => o.appId !== null);
  const own = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === STEAM_CREDENTIAL_KIND,
  );

  const primary = outlets[0];
  if (!primary) {
    // A product being set up for Steam: the platform pin names the app (no own key only).
    if (
      own.length === 0 &&
      (await resolvePlatformCredential(env, db, STEAM_PLATFORM_CREDENTIAL))
    ) {
      const pinned = await platformPin(db, STEAM_PLATFORM_CREDENTIAL, product);
      if (pinned !== null && STEAM_NUMERIC_ID.test(pinned))
        return {
          setup: {
            product,
            appId: pinned,
            branches: {},
            outletIds: [],
            credentialId: platformCredentialHandle(STEAM_PLATFORM_CREDENTIAL),
            credentialSource: "platform",
          },
          inert: null,
        };
      return inert(
        "pin_missing",
        `no Steam app is assigned to ${product}: a platform admin assigns one in Platform → Store connections after checking that it is this product's app`,
        null,
      );
    }
    return inert(
      "no_outlet",
      "declare a steam outlet with an appId in .pkey/distribution",
      null,
    );
  }
  const appId = primary.appId!;
  const naming = outlets.filter((o) => o.appId === appId);
  const branches: Record<string, string> = {};
  for (const o of naming) Object.assign(branches, o.branches);
  const outletIds = naming.map((o) => o.outletId);
  const setupWith = (
    credentialId: string,
    credentialSource: "product" | "platform",
  ): SteamSetupResolution => ({
    setup: {
      product,
      appId,
      branches,
      outletIds,
      credentialId,
      credentialSource,
    },
    inert: null,
  });

  if (own.length === 0) {
    const f = await platformFallback(
      env,
      db,
      product,
      STEAM_PLATFORM_CREDENTIAL,
      appId,
    );
    if (!f.ok)
      return inert(
        f.reason,
        platformFallbackMessage("Steam", "steam", "app id", appId, product, f),
        appId,
      );
    return setupWith(f.handle, "platform");
  }
  const ids = new Set(outletIds);
  const credential =
    own.find((c) => c.outletId !== null && ids.has(c.outletId)) ??
    own.find((c) => c.outletId === null);
  if (!credential)
    return inert(
      "no_credential",
      "a platform admin must store a steam-publisher-key credential pinned to this app",
      appId,
    );
  const pin = checkOutletCredentialPin(credential, appId);
  if (!pin.ok)
    return inert(
      pin.reason,
      pin.reason === "pin_missing"
        ? `the steam-publisher-key credential ${credential.id} is not pinned to an app: a platform admin must pin it to ${appId} after checking that this is the product's app`
        : `.pkey/distribution names Steam app ${appId}, but the steam-publisher-key credential ${credential.id} is pinned to ${pin.pinned}: nothing is read or changed until they agree`,
      appId,
    );
  return setupWith(credential.id, "product");
}
