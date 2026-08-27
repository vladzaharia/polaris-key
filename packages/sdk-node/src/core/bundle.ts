// Offline bundle import — wire contract v3 §7 step 5.
//
// Steps 1–4 are `@plrs/client-core`'s `inspectBundle`, which is where they belong: they are
// pure, isomorphic, and pinned byte-for-byte by `conformance/corpus/v2`'s `bundleCases`. What
// is left here is the one thing a host has that a verifier does not — a cache — and the one
// rule that goes with it:
//
//   NOTHING IS WRITTEN UNLESS EVERYTHING VERIFIED.
//
// That is structural rather than disciplinary: a refusal hands back no documents at all, so
// there is no partial result available to write. The write itself REPLACES the record rather
// than merging into it, because importing a bundle is a re-provisioning: a stale license slice
// surviving an air-gapped re-import would be a device running on a licence its operator
// deliberately replaced.
//
// No token is created. A bundle-activated install has no credential and never talks to the
// server — `activation: "bundle"` is what the gate reads instead (§7), and if the device later
// activates online the token path supersedes it.

import {
  CACHE_VERSION,
  PolarisError,
  inspectBundle,
  type BundleRefusalReason,
  type CacheRecordV3,
} from "@plrs/client-core";
import type { CacheManager } from "./cache.js";
import type { CoreContext } from "./context.js";
import { nowSec } from "./context.js";

export interface ImportBundleResult {
  bundleId: string;
  /** Which documents landed, in §7 order. `license` present ⇒ the gate is now activated by
   *  bundle; a config-only bundle imports settings and grants nothing (D-08). */
  imported: ("license" | "config")[];
}

/** Human-readable causes, so a CLI can tell an operator WHICH thing is wrong with the file
 *  they were handed. The machine-readable form is the `PolarisError.code`. */
const MESSAGES: Record<BundleRefusalReason, string> = {
  "bundle-jws-rejected":
    "The bundle's signature, type or size was not acceptable.",
  "bundle-claims-rejected":
    "The bundle is not addressed to this device, or its import window has closed.",
  "bundle-trust-rejected":
    "The trust manifest inside the bundle was rejected against the pinned keys.",
  "inner-doc-rejected":
    "A document inside the bundle failed verification; nothing was imported.",
};

/**
 * Verify and install an offline activation bundle.
 *
 * Throws `PolarisError` carrying the §7 step that refused — the step is the operator's remedy
 * ("get a bundle minted for THIS machine" is a different action from "the mint bound the wrong
 * device"), and collapsing them would make the air-gapped path the least diagnosable one.
 */
export async function importBundle(
  ctx: CoreContext,
  cache: CacheManager,
  jws: string,
  now: number = nowSec(),
): Promise<ImportBundleResult> {
  const result = await inspectBundle(jws, {
    pinned: ctx.pinnedTrust,
    product: ctx.product,
    deviceId: ctx.deviceId,
    now,
  });
  if (!result.ok) {
    throw new PolarisError(result.reason, MESSAGES[result.reason]);
  }
  const { bundle } = result;

  const record: CacheRecordV3 = {
    v: CACHE_VERSION,
    trustJws: bundle.trustJws,
    docs: {
      ...(bundle.docs.license ? { license: bundle.docs.license.jws } : {}),
      ...(bundle.docs.config ? { config: bundle.docs.config.jws } : {}),
    },
    // No ETags: these documents did not come from a conditional GET, and inventing validators
    // for them would make the next online sync send an `If-None-Match` the server never issued.
    importedBundle: { bundleId: bundle.bundleId, importedAt: now },
  };
  await cache.replace(record);
  // Re-run the normal load path over what we just wrote rather than trusting the in-memory
  // objects: the imported install must reach exactly the state a RESTART would reach, and the
  // only way to be sure of that is to take the same route.
  await cache.load();

  const imported: ("license" | "config")[] = [];
  if (bundle.docs.license) imported.push("license");
  if (bundle.docs.config) imported.push("config");
  return { bundleId: bundle.bundleId, imported };
}
