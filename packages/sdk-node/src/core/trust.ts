// Core's trust custody — WIRE-CONTRACT-V4 §1, §2.3 and §4.2.
//
// Two tiers, strictly decreasing authority, and nothing else:
//
//   pinned    compiled into the host application. Terminal unless TOMBSTONED: a verified
//             manifest signed by another usable pin that lists a pin's exact bytes as `revoked`
//             removes it from the usable pins, permanently, on this install.
//   manifest  keys learned from a `pkey-trust+jws` verified AGAINST THE USABLE PINS, re-verified
//             on every load and REPLACED wholesale on every refresh, so absence is revocation.
//
// The on-disk cache is not a key source: it persists the manifest's compact JWS, never bare
// `kid → key` JSON, so a file write can neither add a kid nor swap the bytes behind one
// (R2-01 / R2-02 / R4-02). A tombstone is persisted the same way: the revoking manifest,
// verbatim, in the `pinRevocations` slice, re-verified on every load. All of the actual rules
// live in `@polaris-key/client-core`; this class is the CUSTODIAN — it holds the tiers and the
// evidence, decides when to go to the network, and folds each accepted manifest into the clock
// floor.
//
// ── WHY TRUST REFRESH IS CORE'S, NOT A SERVICE'S ────────────────────────────────────────────
//
// v2's floor rode the `/config` fetch, which coupled the independent signed clock to one
// service's document. §4.2 abolishes that: a product with ANY service enabled must still
// advance the floor, so `refresh()` is called by `sync()` on Core's own cadence, before and
// independently of whichever documents this product happens to fetch. It is also what makes
// the floor bite at all — a floor built from a document alone is provably inert, because
// `doc.issuedAt < doc.graceUntil` always holds (R4-04).
//
// ── ROTATION AND THE SIGNER RETRY (§2.3) ────────────────────────────────────────────────────
//
// The served manifest is signed by the product's ACTIVE key. An app that pins only an older key
// cannot verify it, so `refresh()` retries with `?signer=<kid>` for each usable pin (ascending
// kid byte order, at most `MAX_TRUST_SIGNER_ATTEMPTS`) whenever the default manifest's signer is
// not a usable pin, and keeps the first manifest it accepts.

import type { TrustSet } from "@polaris-key/jws";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import {
  compareKidBytes,
  jwsHeaderKid,
  loadPinRevocations,
  mergeTrust,
  trustSignerOrder,
  usablePins,
  verifyTrustManifest,
  type TrustManifestResult,
} from "@polaris-key/client-core";
import type { CoreContext } from "./context.js";

export class TrustManager {
  /** Tier 2 — REPLACED, never merged into, on every successful verification (§1 rule 2). */
  private discovered: TrustSet = {};
  private manifest: TrustManifestDoc | null = null;
  /** The tombstoned pins, re-derived from `evidence` on every load (§1, §4.1). */
  private tombstones: string[] = [];
  /** The `pinRevocations` slice as it should be written: kid → the revoking manifest. */
  private evidence: Record<string, string> = {};

  constructor(private readonly ctx: CoreContext) {}

  /** The pins minus the tombstones: the ONLY keys a manifest or bundle verifies against. */
  get usable(): TrustSet {
    return usablePins(this.ctx.pinnedTrust, this.tombstones);
  }

  /** The tombstoned pins (ascending byte order). */
  get revokedPins(): readonly string[] {
    return this.tombstones;
  }

  /** The effective set: manifest keys first, the USABLE pins spread LAST so they are terminal. */
  get effective(): TrustSet {
    return mergeTrust(this.usable, this.discovered);
  }

  get manifestDoc(): TrustManifestDoc | null {
    return this.manifest;
  }

  /** The `pinRevocations` slice to persist; a copy. Empty when no pin was revoked. */
  get pinRevocations(): Record<string, string> {
    return { ...this.evidence };
  }

  /** Forget the learned keys. Called on deactivate, and at the top of every cache load so a
   *  reload can never inherit keys the file no longer justifies. The tombstones are NOT
   *  forgotten: they are security state, re-derived from the evidence by `loadEvidence`. */
  reset(): void {
    this.discovered = {};
    this.manifest = null;
  }

  /**
   * Re-derive the tombstones from the cached `pinRevocations` slice (§4.1). Entries that do not
   * re-verify are dropped from what `pinRevocations` returns, so the next write removes them.
   */
  async loadEvidence(
    slice: Record<string, unknown> | undefined,
  ): Promise<void> {
    const { tombstones, kept } = await loadPinRevocations(slice, {
      pinned: this.ctx.pinnedTrust,
      expectedAud: this.ctx.product,
    });
    this.tombstones = tombstones;
    this.evidence = kept;
  }

  /** Record a verified manifest's new tombstones, with the manifest as their evidence. */
  noteRevocations(jws: string, revokedPins: readonly string[]): void {
    if (revokedPins.length === 0) return;
    for (const kid of revokedPins) this.evidence[kid] = jws;
    this.tombstones = [...new Set([...this.tombstones, ...revokedPins])].sort(
      compareKidBytes,
    );
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
      tombstones: this.tombstones,
      expectedAud: this.ctx.product,
      checkFreshness: false,
    });
    if (!result.doc) return false;
    this.install(jws, result);
    return true;
  }

  /**
   * Fetch, verify and install a signed trust manifest from the network.
   *
   * Verified against the USABLE pins only — never against the current (possibly extended)
   * set. v1 verified against the effective set, so a single planted key could sign a manifest
   * minting further keys and the poisoning became self-sustaining (R2-01's amplifier). It also
   * keeps the online and offline paths identical: anything installed here still verifies after
   * a restart, when only the pins are available.
   *
   * Returns the compact JWS to persist, or null when nothing acceptable arrived. A manifest that
   * tombstoned a pin also changed `pinRevocations`, which the caller writes in the same patch.
   */
  async refresh(): Promise<string | null> {
    const first = await this.fetchManifest(null);
    if (first === null) return null;
    const verify = (jws: string) =>
      verifyTrustManifest(jws, {
        pinned: this.ctx.pinnedTrust,
        tombstones: this.tombstones,
        expectedAud: this.ctx.product,
        // The network path runs at the effective clock, not the bare system clock.
        now: this.ctx.now(),
        // Anti-rollback: derived from the manifest we last verified, never from a disk counter
        // (R4-03 — `lastTrustIssuedAt` used to be an attacker-writable JSON field).
        lastTrustIssuedAt: this.manifest?.issuedAt,
      });
    let jws = first;
    let result = await verify(jws);
    if (!result.doc) {
      // §2.3: the default manifest's signer is not one of our usable pins (a rotation, or a
      // revoked active key): ask for the same manifest signed by each pin we hold.
      for (const signer of trustSignerOrder(this.usable, jwsHeaderKid(first))) {
        const retry = await this.fetchManifest(signer);
        if (retry === null) continue;
        const r = await verify(retry);
        if (r.doc) {
          jws = retry;
          result = r;
          break;
        }
      }
    }
    if (!result.doc) return null;
    this.install(jws, result);
    return jws;
  }

  private install(jws: string, result: TrustManifestResult): void {
    this.noteRevocations(jws, result.revokedPins);
    this.manifest = result.doc;
    this.discovered = result.discovered;
    if (result.doc) this.ctx.raiseFloor(result.doc.issuedAt);
  }

  /** One `GET /<p>/.well-known/polaris-trust.jws[?signer=<kid>]`; the body on a 200, else null. */
  private async fetchManifest(signer: string | null): Promise<string | null> {
    const f = this.ctx.fetcher();
    const path =
      signer === null
        ? ".well-known/polaris-trust.jws"
        : `.well-known/polaris-trust.jws?signer=${encodeURIComponent(signer)}`;
    const res = await f(this.ctx.url(path), {
      headers: { accept: "application/jose" },
      signal: this.ctx.deadline(),
    });
    if (!res.ok) return null;
    return res.text();
  }
}
