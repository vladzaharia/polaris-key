// Offline activation bundles — wire contract v3 §7.
//
// A bundle (`pkey-bundle+jws`) is the air-gapped activation path (D-12): an operator mints
// one against a device's request code, carries it across on a USB stick, and the client
// imports it with no network at all. It wraps up to three inner compact JWSs — a license
// document, an optional config document, and the trust manifest needed to verify them — so
// its payload cap is 262 144 bytes rather than the 64 KiB every other document gets (§1).
//
// ── WHAT THIS MODULE IS, AND WHAT IT IS NOT ─────────────────────────────────────────────
//
// This is the VERIFIER, and only the verifier: it is pure, isomorphic, and touches no store.
// Step 5 of §7 — "atomically write cache v3" — belongs to the host, because only the host has
// a cache. `@polaris-key/node`'s `core/bundle.ts` calls this and writes; React's will do the same.
// Keeping the write out here is what makes the ALL-OR-NOTHING rule structural rather than
// disciplinary: there is no partial result to write, because a refusal returns no documents.
//
// ── THE ORDER IS THE CONTRACT ───────────────────────────────────────────────────────────
//
// §7 numbers five steps, and the conformance corpus (`bundleCases`) pins WHICH ONE refuses
// for each vector, not merely that something did. That is why refusals are a discriminated
// union instead of a bare `null`: "the bundle was addressed to another device" (step 2) and
// "the license document inside it was addressed to another device" (step 4) are different
// failures with different operator remedies, and a verifier that collapsed them would pass a
// weaker test than the one the five SDKs have to agree on.
//
// `verifyBundle` — the plain `VerifiedBundle | null` shape — is the ergonomic call for hosts
// that only need yes/no. `inspectBundle` is the same walk with the step attributed.

import { verifyJws, type TrustSet } from "@polaris-key/jws";
import { MAX_BUNDLE_BYTES, type BundleDoc } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import { CLOCK_SKEW_SECONDS, isWireInteger } from "./claims.js";
import { verifyConfigDoc, verifyLicenseDoc } from "./verify.js";
import { mergeTrust, verifyTrustManifest } from "./trust.js";

export { MAX_BUNDLE_BYTES };

/** One inner document that survived every step, kept alongside the exact bytes it arrived
 *  as: the host persists the SIGNED artifact, never the decoded object (§4.1). */
export interface VerifiedBundleDoc<T> {
  /** The inner compact JWS, verbatim — this is what goes in the cache. */
  jws: string;
  /** The decoded, fully-validated payload, so the caller need not verify twice. */
  doc: T;
}

/** The result of a bundle that passed all four verification steps. Everything the host needs
 *  for §7 step 5's atomic write, and nothing it would have to re-derive. */
export interface VerifiedBundle {
  /** The mint's audit anchor, recorded as `importedBundle.bundleId`. */
  bundleId: string;
  /** The inner trust manifest's compact JWS — cached as `trustJws`, so the imported install
   *  reloads with exactly the key set the bundle shipped with. */
  trustJws: string;
  /** `pinned ∪ non-revoked manifest keys`, with the pins terminal — the set step 4 used. */
  effectiveTrust: TrustSet;
  /** Whichever documents the bundle carried. `license` absent ⇒ NO activation effect: the
   *  gate stays `needs-activation` (or `not-applicable`), never `activation: "bundle"` (§7). */
  docs: {
    license?: VerifiedBundleDoc<LicenseDoc>;
    config?: VerifiedBundleDoc<ConfigDoc>;
  };
}

/**
 * Which numbered step of §7 refused. Named for the step, not for the symptom, because the
 * corpus asserts the attribution and the five SDKs must agree on it.
 *
 *   `bundle-jws-rejected`     step 1 — signature, `typ`, or the 262 144-byte cap.
 *   `bundle-claims-rejected`  step 2 — `aud`/`deviceId`/import window/vacuous `docs`.
 *   `bundle-trust-rejected`   step 3 — the inner manifest failed against the PINS.
 *   `inner-doc-rejected`      step 4 — a carried document failed against the effective set.
 */
export type BundleRefusalReason =
  | "bundle-jws-rejected"
  | "bundle-claims-rejected"
  | "bundle-trust-rejected"
  | "inner-doc-rejected";

/** `inspectBundle`'s answer: the bundle, or the step that refused it. */
export type BundleInspection =
  | { ok: true; bundle: VerifiedBundle }
  | { ok: false; reason: BundleRefusalReason };

export interface BundleOptions {
  /** The ONLY keys a bundle may be verified against (§7.1). The manifest it carries is
   *  verified against these too — an air-gapped device must not be the one place where a
   *  planted key set is accepted. */
  pinned: TrustSet;
  /** The expected `aud` — this client's product slug. */
  product: string;
  /** The LOCAL device id. Step 4 binds inner documents to this, not to the bundle's own
   *  claim, so a mint-side mix-up cannot smuggle a foreign license onto this machine. */
  deviceId: string;
  /** Epoch seconds. Required — a bundle import is a deliberate, timestamped operation, and
   *  defaulting the clock here would hide which clock the decision was made against. */
  now: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const refuse = (reason: BundleRefusalReason): BundleInspection => ({
  ok: false,
  reason,
});

/**
 * Walk §7's numbered order over one bundle, reporting which step refused.
 *
 * Nothing is returned until every step has passed, which is the mechanical form of
 * all-or-nothing: a caller physically cannot write half a bundle, because a failure at step 4
 * hands back no documents at all — not even the ones that verified before it.
 */
export async function inspectBundle(
  jws: string,
  opts: BundleOptions,
): Promise<BundleInspection> {
  // ── 1. The bundle JWS against PINNED keys only ────────────────────────────────────────
  // The `typ` closes the replay this artifact would otherwise open: the raised cap travels
  // with the `typ`, so an untyped 256 KiB blob accepted here could be re-presented at an
  // ordinary document call site. The cap is taken from the protocol constant rather than
  // from the caller — no host gets to choose how big a bundle may be.
  const verified = await verifyJws<BundleDoc>(jws, opts.pinned, {
    typ: "pkey-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  });
  if (!verified) return refuse("bundle-jws-rejected");
  const bundle = verified.payload;
  if (!isPlainObject(bundle)) return refuse("bundle-jws-rejected");

  // ── 2. The bundle's OWN claims, on NETWORK-path freshness ─────────────────────────────
  // §7.2: a stale bundle is refused even though the documents it carries are validated with
  // the reload profile. The two windows mean different things — `expiresAt` here is the
  // operator's import deadline, while the inner documents' long bound is `graceUntil`.
  if (typeof bundle.bundleId !== "string" || bundle.bundleId === "")
    return refuse("bundle-claims-rejected");
  if (typeof bundle.trust !== "string") return refuse("bundle-claims-rejected");
  if (bundle.aud !== opts.product) return refuse("bundle-claims-rejected");
  if (bundle.deviceId !== opts.deviceId)
    return refuse("bundle-claims-rejected");
  // V4 §3: integer claims decided from the token, minimum 0.
  if (
    !isWireInteger(bundle.issuedAt, "/issuedAt", 0, verified.nonWireIntegers) ||
    !isWireInteger(bundle.expiresAt, "/expiresAt", 0, verified.nonWireIntegers)
  ) {
    return refuse("bundle-claims-rejected");
  }
  if (bundle.issuedAt > opts.now + CLOCK_SKEW_SECONDS)
    return refuse("bundle-claims-rejected");
  if (opts.now > bundle.expiresAt + CLOCK_SKEW_SECONDS)
    return refuse("bundle-claims-rejected");

  if (!isPlainObject(bundle.docs)) return refuse("bundle-claims-rejected");
  const licenseJws = bundle.docs.license;
  const configJws = bundle.docs.config;
  if (licenseJws !== undefined && typeof licenseJws !== "string")
    return refuse("bundle-claims-rejected");
  if (configJws !== undefined && typeof configJws !== "string")
    return refuse("bundle-claims-rejected");
  // A bundle carrying NEITHER document is vacuous (§7): it can grant nothing and configure
  // nothing, so importing it would write an `importedBundle` marker with no content behind
  // it — an install that looks provisioned and is not. Refused here, at the claims step,
  // for the same reason the other addressing failures are: nothing about the trust manifest
  // or the (absent) documents is relevant to a bundle that was never going to do anything.
  if (licenseJws === undefined && configJws === undefined)
    return refuse("bundle-claims-rejected");

  // ── 3. The inner trust manifest, against the PINS, on the RELOAD profile ──────────────
  // Reload, not network: a bundle minted weeks ago carries a manifest whose minutes-long
  // `expiresAt` passed long before it reached the air-gapped machine. Everything else about
  // the manifest still applies — the signature, the `aud`/`iss`/`typ` binding, and above all
  // the pinned-substitution rule, which is what stops a bundle from shipping its own roots.
  const manifest = await verifyTrustManifest(bundle.trust, {
    pinned: opts.pinned,
    expectedAud: opts.product,
    now: opts.now,
    checkFreshness: false,
  });
  if (!manifest.doc) return refuse("bundle-trust-rejected");
  const effectiveTrust = mergeTrust(opts.pinned, manifest.discovered);

  // ── 4. Each inner document against the EFFECTIVE set, reload profile ──────────────────
  // Bound to the LOCAL device id — step 2 has only proved the BUNDLE claims this device, and
  // a document inside it may claim another. There is no anti-replay floor here: a bundle
  // import is the act of establishing state on a device that has none, so there is no
  // previously-accepted document to be newer than. (The host applies its own floor after the
  // write, on the next network sync.)
  const reload = {
    trust: effectiveTrust,
    expectedAud: opts.product,
    deviceId: opts.deviceId,
    now: opts.now,
    checkFreshness: false,
  };
  const docs: VerifiedBundle["docs"] = {};
  if (licenseJws !== undefined) {
    const doc = await verifyLicenseDoc(licenseJws, reload);
    if (!doc) return refuse("inner-doc-rejected");
    docs.license = { jws: licenseJws, doc };
  }
  if (configJws !== undefined) {
    const doc = await verifyConfigDoc(configJws, reload);
    if (!doc) return refuse("inner-doc-rejected");
    docs.config = { jws: configJws, doc };
  }

  // ── 5. The caller's turn ──────────────────────────────────────────────────────────────
  // Everything above passed, so and only so may the host write the cache atomically:
  // `trustJws`, `docs`, and `importedBundle: {bundleId, importedAt}`. No token is created —
  // a bundle-activated install has no credential and never talks to the server.
  return {
    ok: true,
    bundle: {
      bundleId: bundle.bundleId,
      trustJws: bundle.trust,
      effectiveTrust,
      docs,
    },
  };
}

/**
 * Verify an offline activation bundle (§7). Returns the verified contents, or `null` on ANY
 * refusal — the shape hosts want when they just need to know whether to write.
 *
 * Use `inspectBundle` when the refusal REASON matters (a CLI telling an operator that the
 * bundle was minted for a different machine is a materially better error than "invalid").
 */
export async function verifyBundle(
  jws: string,
  opts: BundleOptions,
): Promise<VerifiedBundle | null> {
  const result = await inspectBundle(jws, opts);
  return result.ok ? result.bundle : null;
}
