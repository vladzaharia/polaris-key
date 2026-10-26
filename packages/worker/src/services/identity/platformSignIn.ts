/**
 * Platform sign-in audiences (CC-01 auto sign-in, D-A1; I-42.2): what a Google or Apple token from
 * the product's own app is checked against. Declared in `.pkey/product` (`identity.platformSignIn`)
 * or in the console, stored as the settings rows in `settings.ts`.
 *
 * Apple bundle ids in force are the declared ids plus the bundle ids of the App Store and
 * TestFlight outlets in the last applied manifest (the manifest does not union them itself).
 * The platform's own login-card clients are reserved: a product may not name one (`reservedFrom`).
 */

import type { ParsedManifest } from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import { getManifestSnapshot } from "../../core/manifestSnapshot.js";
import {
  readRowSettings,
  type RowSettingProduct,
} from "../../core/rowSettings.js";
import { reservedValueIn } from "../../core/settings/rules.js";
import { tryParseJson } from "../../platform/json.js";
import { PLATFORM_SIGN_IN_SETTINGS } from "./settings.js";

/** The audiences of one product, as the exchange verifies against. */
export interface PlatformSignInAudiences {
  google: { serverClientId: string | null; clientIds: string[] };
  apple: {
    teamId: string | null;
    /** Declared ids plus the App Store and TestFlight outlets', deduplicated, declared first. */
    bundleIds: string[];
    /** The part that came from outlets (read-only in the console). */
    outletBundleIds: string[];
  };
  nearby: boolean;
}

/** The bundle ids of a manifest's App Store and TestFlight outlets, sorted, deduplicated. */
export function outletAppleBundleIds(
  distribution:
    | Pick<NonNullable<ParsedManifest["distribution"]>, "outlets">
    | undefined,
): string[] {
  const out = new Set<string>();
  for (const o of distribution?.outlets ?? [])
    if (
      (o.kind === "app-store" || o.kind === "testflight") &&
      typeof o.identity?.bundleId === "string"
    )
      out.add(o.identity.bundleId);
  return [...out].sort();
}

/** `declared` then `outlet` ids, each once. */
export function unionBundleIds(
  declared: readonly string[],
  outlet: readonly string[],
): string[] {
  return [...new Set([...declared, ...outlet])];
}

/**
 * The first audience a manifest names that the platform reserves, or `null`. Checks every Google
 * client id and every Apple bundle id, the outlets' included.
 */
export function reservedAudienceIn(
  manifest: Pick<ParsedManifest, "identity" | "distribution">,
  env: Readonly<Record<string, unknown>>,
): string | null {
  const ps = manifest.identity?.platformSignIn;
  const pick = (key: string) =>
    PLATFORM_SIGN_IN_SETTINGS.find((d) => d.key === key)!;
  const candidates: [string, unknown][] = [
    [
      "identity.platformSignIn.google.serverClientId",
      ps?.google?.serverClientId,
    ],
    ["identity.platformSignIn.google.clientIds", ps?.google?.clientIds],
    [
      "identity.platformSignIn.apple.bundleIds",
      unionBundleIds(
        ps?.apple?.bundleIds ?? [],
        outletAppleBundleIds(manifest.distribution),
      ),
    ],
  ];
  for (const [key, value] of candidates) {
    const hit = reservedValueIn(pick(key), value, env);
    if (hit !== null) return hit;
  }
  return null;
}

/** The product's audiences in force: the settings rows, plus the last applied manifest's outlets. */
export async function readPlatformSignIn(
  db: Db,
  product: RowSettingProduct,
): Promise<PlatformSignInAudiences> {
  const views = await readRowSettings(db, product, PLATFORM_SIGN_IN_SETTINGS);
  const at = (key: string): unknown =>
    views.find((v) => v.def.key === key)!.value;
  const snap = await getManifestSnapshot(db, product.slug);
  const parsed = snap
    ? (tryParseJson(snap.manifest_json) as Partial<ParsedManifest> | undefined)
    : undefined;
  const outletBundleIds = outletAppleBundleIds(parsed?.distribution);
  return {
    google: {
      serverClientId:
        (at("identity.platformSignIn.google.serverClientId") as
          | string
          | null) ?? null,
      clientIds: at("identity.platformSignIn.google.clientIds") as string[],
    },
    apple: {
      teamId:
        (at("identity.platformSignIn.apple.teamId") as string | null) ?? null,
      bundleIds: unionBundleIds(
        at("identity.platformSignIn.apple.bundleIds") as string[],
        outletBundleIds,
      ),
      outletBundleIds,
    },
    nearby: at("identity.nearby") as boolean,
  };
}
