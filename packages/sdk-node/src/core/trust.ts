// Core's trust custody — wire contract v3 §1 and §4.2.
//
// Two tiers, strictly decreasing authority, and nothing else:
//
//   pinned    compiled into the host application. Terminal.
//   manifest  keys learned from a `plrs-trust+jws` verified AGAINST THE PINS, re-verified on
//             every load and REPLACED wholesale on every refresh, so absence is revocation.
//
// The on-disk cache is not a key source: it persists the manifest's compact JWS, never bare
// `kid → key` JSON, so a file write can neither add a kid nor swap the bytes behind one
// (R2-01 / R2-02 / R4-02). All of the actual rules live in `@plrs/client-core`; this class is
// the CUSTODIAN — it holds the two tiers, decides when to go to the network, and folds each
// accepted manifest into the clock floor.
//
// ── WHY TRUST REFRESH IS CORE'S, NOT A SERVICE'S ────────────────────────────────────────────
//
// v2's floor rode the `/config` fetch, which coupled the independent signed clock to one
// service's document. §4.2 abolishes that: a product with ANY service enabled must still
// advance the floor, so `refresh()` is called by `sync()` on Core's own cadence, before and
// independently of whichever documents this product happens to fetch. It is also what makes
// the floor bite at all — a floor built from a document alone is provably inert, because
// `doc.issuedAt < doc.graceUntil` always holds (R4-04).

import type { TrustSet } from "@plrs/jws";
import type { TrustManifestDoc } from "@plrs/protocol/trust";
import { mergeTrust, verifyTrustManifest } from "@plrs/client-core";
import type { CoreContext } from "./context.js";

export class TrustManager {
  /** Tier 2 — REPLACED, never merged into, on every successful verification (§1 rule 2). */
  private discovered: TrustSet = {};
  private manifest: TrustManifestDoc | null = null;

  constructor(private readonly ctx: CoreContext) {}

  /** The effective set: manifest keys first, pins spread LAST so they are terminal. */
  get effective(): TrustSet {
    return mergeTrust(this.ctx.pinnedTrust, this.discovered);
  }

  get manifestDoc(): TrustManifestDoc | null {
    return this.manifest;
  }

  /** Forget everything learned. Called on deactivate, and at the top of every cache load so a
   *  reload can never inherit keys the file no longer justifies. */
  reset(): void {
    this.discovered = {};
    this.manifest = null;
  }

  /**
   * Re-verify a CACHED manifest and install what it publishes.
   *
   * Freshness is not asserted: a manifest is only minutes-fresh by design, and refusing a
   * stale one would strand every offline client that has rotated keys. Its signature, its
   * `aud`/`iss`/`typ` binding and the pinned-substitution guard all still apply — and its
   * `issuedAt` still raises the floor, because a stale manifest is still a SIGNED LOWER BOUND
   * on real time, independent of whether it may still publish keys.
   *
   * Returns false when the cached artifact did not verify, which the caller treats as "that
   * slice is absent" and drops from the record (§4.1, fail closed).
   */
  async loadCached(jws: string): Promise<boolean> {
    const result = await verifyTrustManifest(jws, {
      pinned: this.ctx.pinnedTrust,
      expectedAud: this.ctx.product,
      checkFreshness: false,
    });
    if (!result.doc) return false;
    this.manifest = result.doc;
    this.discovered = result.discovered;
    this.ctx.raiseFloor(result.doc.issuedAt);
    return true;
  }

  /**
   * Fetch, verify and install a signed trust manifest from the network.
   *
   * Verified against the PINNED keys only — never against the current (possibly extended)
   * set. v1 verified against the effective set, so a single planted key could sign a manifest
   * minting further keys and the poisoning became self-sustaining (R2-01's amplifier). It also
   * keeps the online and offline paths identical: anything installed here still verifies after
   * a restart, when only the pins are available.
   *
   * Returns the compact JWS to persist, or null when nothing acceptable arrived.
   */
  async refresh(): Promise<string | null> {
    const f = this.ctx.fetcher();
    const res = await f(this.ctx.url(".well-known/polaris-trust.jws"), {
      headers: { accept: "application/jose" },
      signal: this.ctx.deadline(),
    });
    if (!res.ok) return null;
    const jws = await res.text();
    const result = await verifyTrustManifest(jws, {
      pinned: this.ctx.pinnedTrust,
      expectedAud: this.ctx.product,
      // Anti-rollback: derived from the manifest we last verified, never from a disk counter
      // (R4-03 — `lastTrustIssuedAt` used to be an attacker-writable JSON field).
      lastTrustIssuedAt: this.manifest?.issuedAt,
    });
    if (!result.doc) return null;
    this.manifest = result.doc;
    this.discovered = result.discovered;
    this.ctx.raiseFloor(result.doc.issuedAt);
    return jws;
  }
}
