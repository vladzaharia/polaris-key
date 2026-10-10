// The verified cache — wire contract v3 §4.1. Core owns this record; no service module ever
// writes it.
//
// ── THE LOAD PROCEDURE IS THE SECURITY BOUNDARY ─────────────────────────────────────────────
//
// Every load re-verifies EVERYTHING, in this order:
//
//   1. a record whose `v !== 3` is DISCARDED, never migrated — one network round trip is the
//      right price for not carrying poisoned state forward, and an air-gapped install
//      re-imports its bundle;
//   2. `pinRevocations` (the evidence for each tombstoned pin) against the pins, in ascending
//      manifest `issuedAt` → the usable pins;
//   3. `trustJws` against the USABLE pins only, freshness off → the effective set;
//   4. each entry of `docs` against THAT set, freshness off, full §3 claim validation
//      including `aud` and `deviceId`;
//   5. `bundle` (an offline activation) on the bundle RELOAD profile, and only when its license
//      document is byte-identical to the cached one does it count as `activation: "bundle"`;
//   6. every derived counter — the per-type anti-replay floors, `lastVerifiedAt`, the
//      monotonic clock floor — computed from what verified, never read from the file.
//
// Any artifact that fails is treated as ABSENT and dropped from the in-memory record, so a
// failed license document yields `needs-activation` rather than a partial state. That is the
// whole of R2-03/R4-01/R4-02/R4-03: there is no unsigned field left to poison, and forging one
// now requires forging a signature.
//
// ── WHY WRITES ARE READ-MODIFY-WRITE OF THE WHOLE RECORD ───────────────────────────────────
//
// The record has independent slices — two documents, two ETags, a trust manifest, an import
// marker — updated by different call sites at different times. Serialising every mutation
// through `patch()` is what keeps a config write from clobbering a license slice that landed
// microseconds earlier in the same parallel sync.

import {
  CACHE_VERSION,
  inspectBundle,
  verifyConfigDoc,
  verifyLicenseDoc,
  type BlockedState,
  type CacheRecordV3,
} from "@polaris-key/client-core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { CoreContext } from "./context.js";
import type { TrustManager } from "./trust.js";

/** One re-verified document slice: the decoded payload plus the artifact it came from. */
export interface CachedDoc<T> {
  jws: string;
  doc: T;
}

/** What a load produced. Every field is DERIVED from a signature checked microseconds ago. */
export interface LoadedCache {
  license: CachedDoc<LicenseDoc> | null;
  config: CachedDoc<ConfigDoc> | null;
  /**
   * The cached offline bundle (§7), when it re-verified on the reload profile; null otherwise.
   * `docs` is what it carried. `activates` is the signed fact behind `activation: "bundle"`
   * (with no token held): it carried a license document byte-identical to the cached one.
   */
  bundle: {
    bundleId: string;
    docs: ("license" | "config")[];
    activates: boolean;
  } | null;
  lastSyncUnauthorized: boolean;
  blocked: BlockedState | null;
  /** Epoch MILLIseconds of the last verification, derived from the newest document's signed
   *  `issuedAt` — offline, the server's own statement of when it minted is the only
   *  trustworthy "last checked" signal there is (R4-04). */
  lastVerifiedAt: number | null;
}

/** The string-valued own entries of a slice read from disk; anything else is not a JWS. */
function stringEntries(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return out;
  for (const [k, v] of Object.entries(value))
    if (typeof v === "string") out[k] = v;
  return out;
}

const EMPTY: LoadedCache = {
  license: null,
  config: null,
  bundle: null,
  lastSyncUnauthorized: false,
  blocked: null,
  lastVerifiedAt: null,
};

export class CacheManager {
  private record: CacheRecordV3 | null = null;
  private loaded: LoadedCache = { ...EMPTY };

  constructor(
    private readonly ctx: CoreContext,
    private readonly trust: TrustManager,
  ) {}

  get state(): LoadedCache {
    return this.loaded;
  }

  /** The ETag held for one document, or undefined. Non-security: it is a conditional-request
   *  validator, and the worst a forged one achieves is an unnecessary 200. */
  etag(slice: "license" | "config"): string | undefined {
    return this.record?.etags?.[slice];
  }

  /**
   * The wire v4 update slices AS STORED (`feeds`, keyed by canonical channel, and
   * `releaseRecords`, keyed by hash): signed JWSs and nothing else, never a floor. They are
   * UNVERIFIED here — the update client re-verifies every entry before using it (the reload path
   * of plans/P3-01.md §2.5), and the floors are derived from what survives. Copies, so a caller
   * cannot edit the record behind `patch()`'s back.
   */
  updateSlices(): {
    feeds: Record<string, string>;
    releaseRecords: Record<string, string>;
  } {
    return {
      feeds: stringEntries(this.record?.feeds),
      releaseRecords: stringEntries(this.record?.releaseRecords),
    };
  }

  /**
   * Replace the update slices with what the reload path kept. In memory only, like
   * `dropSlice()`: a slice that failed verification is absent for this session and rewritten out
   * on the next `patch()`, never erased from disk on a read path.
   */
  keepUpdateSlices(slices: {
    feeds: Record<string, string>;
    releaseRecords: Record<string, string>;
  }): void {
    if (!this.record) return;
    const next: CacheRecordV3 = { ...this.record };
    delete next.feeds;
    delete next.releaseRecords;
    if (Object.keys(slices.feeds).length > 0) next.feeds = { ...slices.feeds };
    if (Object.keys(slices.releaseRecords).length > 0)
      next.releaseRecords = { ...slices.releaseRecords };
    this.record = next;
  }

  /** Re-verify the whole record and derive every counter from it (§4.1). */
  async load(): Promise<LoadedCache> {
    this.trust.reset();
    this.loaded = { ...EMPTY };

    const rec = await this.ctx.store.readCache();
    // §4.1 — a record from another cache version is DISCARDED, not migrated. `v` is checked
    // before any field is read, so a v1/v2 record's `trustedKeys` and unsigned counters are
    // never even looked at.
    if (!rec || rec.v !== CACHE_VERSION) {
      this.record = null;
      return this.loaded;
    }
    this.record = rec;

    // §4.1: the tombstones first, so the manifest, the documents and the bundle all verify
    // against the usable pins. Evidence that no longer verifies is dropped on the next write.
    await this.trust.loadEvidence(rec.pinRevocations);
    this.keepEvidence();

    if (rec.trustJws) {
      const ok = await this.trust.loadCached(rec.trustJws);
      if (!ok) this.record = { ...this.record, trustJws: undefined };
    }

    const reload = {
      trust: this.trust.effective,
      expectedAud: this.ctx.product,
      deviceId: this.ctx.deviceId,
      // Reload: no floor (explicit); the floors are DERIVED from what verifies here.
      lastAcceptedIssuedAt: null,
      // A cached document is EXPECTED to be past its short `expiresAt`; its signed outer bound
      // is `graceUntil`, which the gate enforces against the monotonic floor (§4.2). Asserting
      // freshness here would delete offline grace outright.
      checkFreshness: false as const,
    };

    let newestIssuedAt = 0;
    const licenseJws = rec.docs?.license;
    if (licenseJws) {
      const doc = await verifyLicenseDoc(licenseJws, reload);
      if (doc) {
        this.loaded.license = { jws: licenseJws, doc };
        this.ctx.raiseFloor(doc.issuedAt);
        newestIssuedAt = Math.max(newestIssuedAt, doc.issuedAt);
      } else {
        this.dropSlice("license");
      }
    }
    const configJws = rec.docs?.config;
    if (configJws) {
      const doc = await verifyConfigDoc(configJws, reload);
      if (doc) {
        this.loaded.config = { jws: configJws, doc };
        this.ctx.raiseFloor(doc.issuedAt);
        newestIssuedAt = Math.max(newestIssuedAt, doc.issuedAt);
      } else {
        this.dropSlice("config");
      }
    }

    this.loaded.bundle = await this.reloadBundle();
    // A cached manifest may have tombstoned a pin whose evidence the record lacked.
    this.keepEvidence();
    this.loaded.lastSyncUnauthorized =
      this.record.lastSyncUnauthorized === true;
    this.loaded.blocked = this.record.blocked ?? null;
    this.loaded.lastVerifiedAt =
      newestIssuedAt > 0 ? newestIssuedAt * 1000 : null;
    return this.loaded;
  }

  /**
   * §7 reload profile: the cached bundle's own signature and claims, without the import window,
   * against the usable pins; its inner documents against its own manifest's set with no floor.
   * It activates only when its license document is the cached one, byte for byte — otherwise a
   * stale bundle could vouch for a license it never carried.
   */
  private async reloadBundle(): Promise<LoadedCache["bundle"]> {
    const jws = this.record?.bundle;
    if (typeof jws !== "string") return null;
    const result = await inspectBundle(jws, {
      pinned: this.ctx.pinnedTrust,
      tombstones: this.trust.revokedPins,
      product: this.ctx.product,
      deviceId: this.ctx.deviceId,
      now: this.ctx.now(),
      floors: { license: null, config: null },
      profile: "reload",
    });
    if (!result.ok) return null;
    const { docs } = result.bundle;
    const license = docs.license?.jws;
    return {
      bundleId: result.bundle.bundleId,
      docs: [
        ...(docs.license ? (["license"] as const) : []),
        ...(docs.config ? (["config"] as const) : []),
      ],
      activates: license !== undefined && license === this.loaded.license?.jws,
    };
  }

  /** The `pinRevocations` slice in memory follows the custodian's evidence. */
  private keepEvidence(): void {
    if (!this.record) return;
    const evidence = this.trust.pinRevocations;
    const next: CacheRecordV3 = { ...this.record };
    delete next.pinRevocations;
    if (Object.keys(evidence).length > 0) next.pinRevocations = evidence;
    this.record = next;
  }

  /** The cached trust manifest JWS as held (verified on load, or dropped). */
  trustJws(): string | undefined {
    const t = this.record?.trustJws;
    return typeof t === "string" ? t : undefined;
  }

  /** The cached bundle JWS as stored (unverified), for the byte-identical re-import check. */
  bundleJws(): string | undefined {
    const b = this.record?.bundle;
    return typeof b === "string" ? b : undefined;
  }

  /** In-memory only: a slice that failed verification is absent for the rest of this session
   *  and is rewritten out on the next patch. Not erased from disk eagerly — a read path that
   *  deleted files would turn a transient key-rotation gap into data loss. */
  private dropSlice(slice: "license" | "config"): void {
    if (!this.record) return;
    const docs = { ...this.record.docs };
    const etags = { ...this.record.etags };
    delete docs[slice];
    delete etags[slice];
    this.record = { ...this.record, docs, etags };
  }

  /**
   * The server answered for this slice with a hard 401 (or, for the license, a 403
   * build block), so the document is no longer a grant. Removes it — payload, artifact and ETag
   * — from the derived state AND the record, so the `flush()` that persists the display hint
   * persists the removal in the same write. The token is untouched: the gate still reports
   * `revoked` or the block. The floor stays (it only rises).
   */
  revokeSlice(slice: "license" | "config"): void {
    this.loaded[slice] = null;
    this.dropSlice(slice);
  }

  /** Record a freshly verified document: artifact + ETag in the record, payload in the derived
   *  state, `issuedAt` into the floor. In memory only — `flush()` persists. */
  applyLicense(jws: string, doc: LicenseDoc, etag: string | null): void {
    this.loaded.license = { jws, doc };
    this.ctx.raiseFloor(doc.issuedAt);
    this.record = {
      ...this.empty(),
      ...this.record,
      docs: { ...this.record?.docs, license: jws },
      etags: { ...this.record?.etags, license: etag ?? undefined },
    };
  }

  applyConfig(jws: string, doc: ConfigDoc, etag: string | null): void {
    this.loaded.config = { jws, doc };
    this.ctx.raiseFloor(doc.issuedAt);
    this.record = {
      ...this.empty(),
      ...this.record,
      docs: { ...this.record?.docs, config: jws },
      etags: { ...this.record?.etags, config: etag ?? undefined },
    };
  }

  /** Mark the last verification time from a successful authenticated exchange (including a
   *  304 — content unchanged still means freshness renewed, §5). */
  markVerified(atMs = Date.now()): void {
    this.loaded.lastVerifiedAt = atMs;
  }

  /**
   * Read-modify-write the whole record. The ONLY mutation path (§4.1): a service module that
   * wrote the file directly could not be prevented from writing a half-record.
   */
  async patch(patch: Partial<CacheRecordV3>): Promise<void> {
    this.record = { ...this.empty(), ...this.record, ...patch };
    if (patch.lastSyncUnauthorized !== undefined)
      this.loaded.lastSyncUnauthorized = patch.lastSyncUnauthorized === true;
    if ("blocked" in patch) this.loaded.blocked = patch.blocked ?? null;
    await this.ctx.store.writeCache(this.record);
  }

  /** Persist whatever `apply*` staged, with an optional patch folded into the same write. */
  async flush(patch: Partial<CacheRecordV3> = {}): Promise<void> {
    await this.patch(patch);
  }

  /**
   * Replace the record wholesale, atomically. Only `importBundle` uses this: §7 step 5 is an
   * all-or-nothing write of a verified bundle's contents, and merging it into whatever was
   * there before would let a stale slice survive an air-gapped re-provisioning.
   *
   * The wire v4 update slices are one exception (as in React's browser adapter): they are
   * signed public documents, not grants, and they carry each channel's `seq` floor. Dropping
   * them would let a replayed older feed past the floor, so they are carried into the new
   * record and re-verified, like everything else, before any use. The `pinRevocations`
   * evidence is the other: security state, not a grant (§4.1). The custodian's evidence (which
   * includes any the new record's manifest added) is what is written.
   */
  async replace(record: CacheRecordV3): Promise<void> {
    this.record = { ...record, ...this.carriedUpdateSlices() };
    await this.ctx.store.writeCache(this.record);
  }

  /** Wipe everything, in memory and on disk — except the update slices and the pin evidence
   *  (see `replace()`): a deactivation removes every credential and grant, not the feeds' `seq`
   *  floors and not a pinned key's revocation. */
  async clear(): Promise<void> {
    const carried = this.carriedUpdateSlices();
    this.record = null;
    this.loaded = { ...EMPTY };
    this.trust.reset();
    this.ctx.resetFloor();
    if (Object.keys(carried).length === 0) {
      await this.ctx.store.clearCache();
      return;
    }
    this.record = { ...this.empty(), ...carried };
    await this.ctx.store.writeCache(this.record);
  }

  private carriedUpdateSlices(): Pick<
    CacheRecordV3,
    "feeds" | "releaseRecords" | "pinRevocations"
  > {
    const out: Pick<
      CacheRecordV3,
      "feeds" | "releaseRecords" | "pinRevocations"
    > = {};
    const feeds = stringEntries(this.record?.feeds);
    const records = stringEntries(this.record?.releaseRecords);
    const evidence = this.trust.pinRevocations;
    if (Object.keys(feeds).length > 0) out.feeds = feeds;
    if (Object.keys(records).length > 0) out.releaseRecords = records;
    if (Object.keys(evidence).length > 0) out.pinRevocations = evidence;
    return out;
  }

  private empty(): CacheRecordV3 {
    return { v: CACHE_VERSION };
  }
}
