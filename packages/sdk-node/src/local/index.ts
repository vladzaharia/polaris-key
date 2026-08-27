// `@plrs/node/local` — the transportless profile (offline depth 3).
//
// The suite has three offline depths: online-with-grace (the default), bundle-activated, and
// LOCAL-ONLY — a build that must never open a socket at all. Air-gapped labs, regulated
// environments, and "this binary runs inside a network namespace with no route" all want the
// same thing: a client whose config resolution, gate and bundle import work, and whose every
// network-requiring call refuses LOUDLY rather than hanging on a connect timeout.
//
// ── HOW IT IS ENFORCED ──────────────────────────────────────────────────────────────────────
//
// Not by omitting endpoints — a client missing half its methods is a different type, and the
// host would have to branch on which one it got. Instead `CoreContext.fetcher()` throws
// `PolarisError("local-only")` BEFORE a URL is built or a header is assembled, so:
//
//   * there is one client type, and `client.license.activateWithKey(...)` rejects with a code
//     the host can render, instead of failing in whatever way the transport happens to;
//   * the refusal is at the dial, so a local-only build cannot make a request even by
//     accident — including from the refresh timer, which is not started at all;
//   * `deactivate()` still works: it treats the refusal exactly as it treats being offline,
//     because the local wipe was always the part that mattered.
//
// Two construction routes, both fully offline:
//
//   `createLocalClient()`  config-only or already-provisioned — reads whatever the cache holds.
//   `createBundleClient()` a fresh air-gapped install: import the operator's `.plrsbundle`
//                          first, then hand back a client already gated on it.

import { PolarisError } from "@plrs/client-core";
import { PolarisClient, type PolarisClientOptions } from "../client.js";
import type { ImportBundleResult } from "../core/bundle.js";

export { PolarisError };

/**
 * Local-only options. `fetchImpl` is absent by construction — supplying a transport to a
 * transportless client is a contradiction, and the type says so.
 */
export type LocalOptions = Omit<
  PolarisClientOptions,
  "fetchImpl" | "refreshIntervalSeconds"
>;

/**
 * A client that never touches the network.
 *
 * Everything offline still works: `client.config.getConfig(...)` resolves over a cached or
 * imported config document, `client.license.status()` gates on a cached or imported licence,
 * and `client.importBundle(...)` provisions one. Anything that would dial — activation,
 * enrolment, registration, `sync()`, the changelog, the update check — rejects with
 * `PolarisError` code `local-only`.
 */
export async function createLocalClient(
  opts: LocalOptions,
): Promise<PolarisClient> {
  const client = new PolarisClient({ ...opts, localOnly: true });
  await client.init();
  return client;
}

/**
 * A local-only client provisioned from an offline activation bundle in one step.
 *
 * The import is verified all-or-nothing against the pins before anything is written (§7), so a
 * rejected bundle leaves the install exactly as it was and this throws with the step that
 * refused. On success the returned client is already gated on the imported documents.
 */
export async function createBundleClient(
  opts: LocalOptions & { bundle: string; now?: number },
): Promise<{ client: PolarisClient; imported: ImportBundleResult }> {
  const { bundle, now, ...rest } = opts;
  const client = await createLocalClient(rest);
  const imported = await client.importBundle(bundle, now);
  return { client, imported };
}
