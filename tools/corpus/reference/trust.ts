// Reference: trust custody and bundle import outcomes (V4 §1, §4.1, §7).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: `trust.ts` and `bundle.ts` recompute every case's expected
// outcome through it and throw when a hand-written expectation disagrees.

import { AUD_V3, MAX_BUNDLE_BYTES, type TypV3 } from "../common.js";
import {
  ctxOf,
  isObj,
  refBundleClaims,
  refByteOrder,
  refDocClaims,
  refTrustClaims,
} from "./claims.js";
import { refVerifyJws } from "./jws.js";

type KeySet = Record<string, string>;

/** The pins minus the tombstones. */
export function refUsable(
  pinned: KeySet,
  tombstones: Iterable<string>,
): KeySet {
  const dead = new Set(tombstones);
  return Object.fromEntries(
    Object.entries(pinned).filter(([kid]) => !dead.has(kid)),
  );
}

/** One manifest against the usable pins, or null when it is refused. */
export function refManifest(
  jws: string,
  pinned: KeySet,
  tombstones: ReadonlySet<string>,
  now: number,
  checkFreshness: boolean | undefined,
): { discovered: KeySet; revoked: string[]; issuedAt: number } | null {
  const v = refVerifyJws(jws, refUsable(pinned, tombstones), "pkey-trust+jws");
  if (v === null) return null;
  const r = refTrustClaims(v.payload, ctxOf(v.text), {
    pinned,
    now,
    checkFreshness,
    signer: v.kid,
    tombstones,
  });
  if (r === null) return null;
  return { ...r, issuedAt: v.payload.issuedAt as number };
}

/** V4 §4.1: the tombstones the `pinRevocations` evidence proves, applied in ascending manifest
 *  `issuedAt` (ties: the revoked kid's bytes), each against the pins minus those before it. */
export function refTombstones(
  evidence: KeySet | undefined,
  pinned: KeySet,
  now: number,
): string[] {
  const candidates: { kid: string; jws: string; issuedAt: number }[] = [];
  for (const [kid, jws] of Object.entries(evidence ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(pinned, kid)) continue;
    const pre = refManifest(jws, pinned, new Set(), now, false);
    if (pre !== null) candidates.push({ kid, jws, issuedAt: pre.issuedAt });
  }
  candidates.sort(
    (a, b) => a.issuedAt - b.issuedAt || refByteOrder(a.kid, b.kid),
  );
  const tombstones = new Set<string>();
  for (const c of candidates) {
    const r = refManifest(c.jws, pinned, tombstones, now, false);
    if (r !== null && r.revoked.includes(c.kid)) tombstones.add(c.kid);
  }
  return [...tombstones].sort(refByteOrder);
}

/** A `trustCases` vector's outcome: accepted, the effective set after, and every tombstone. */
export function refTrustOutcome(c: {
  pinned: KeySet;
  before: KeySet;
  pinRevocations?: KeySet;
  manifestJws: string;
  now: number;
  checkFreshness?: boolean;
}): {
  accepted: boolean;
  trust: KeySet;
  issuedAt?: number;
  revokedPins: string[];
} {
  const held = refTombstones(c.pinRevocations, c.pinned, c.now);
  const r = refManifest(
    c.manifestJws,
    c.pinned,
    new Set(held),
    c.now,
    c.checkFreshness,
  );
  if (r === null)
    return {
      accepted: false,
      trust: { ...c.before, ...refUsable(c.pinned, held) },
      revokedPins: held,
    };
  const all = [...new Set([...held, ...r.revoked])].sort(refByteOrder);
  return {
    accepted: true,
    trust: { ...r.discovered, ...refUsable(c.pinned, all) },
    issuedAt: r.issuedAt,
    revokedPins: all,
  };
}

/** A `bundleCases` vector's outcome under V4 §7's numbered order, both profiles and floors. */
export function refBundleOutcome(c: {
  bundleJws: string;
  pinned: KeySet;
  pinRevocations?: KeySet;
  expectedAud: string;
  deviceId: string;
  now: number;
  floors?: { license: number | null; config: number | null };
  profile?: "import" | "reload";
}): { imports: false; reason: string } | { imports: true; docs: string[] } {
  const held = refTombstones(c.pinRevocations, c.pinned, c.now);
  const v = refVerifyJws(
    c.bundleJws,
    refUsable(c.pinned, held),
    "pkey-bundle+jws",
    MAX_BUNDLE_BYTES,
  );
  if (v === null) return { imports: false, reason: "bundle-jws-rejected" };
  const doc = v.payload;
  if (
    c.expectedAud !== AUD_V3 ||
    !refBundleClaims(doc, ctxOf(v.text), {
      now: c.now,
      deviceId: c.deviceId,
      reload: c.profile === "reload",
    })
  )
    return { imports: false, reason: "bundle-claims-rejected" };
  const m = refManifest(
    doc.trust as string,
    c.pinned,
    new Set(held),
    c.now,
    false,
  );
  if (m === null) return { imports: false, reason: "bundle-trust-rejected" };
  const effective = {
    ...m.discovered,
    ...refUsable(c.pinned, [...held, ...m.revoked]),
  };
  const docs = isObj(doc.docs) ? doc.docs : {};
  const out: string[] = [];
  for (const [slice, typ] of [
    ["license", "pkey-license+jws"],
    ["config", "pkey-config+jws"],
  ] as ["license" | "config", TypV3][]) {
    const jws = docs[slice];
    if (jws === undefined) continue;
    const inner = refVerifyJws(jws as string, effective, typ);
    const floor = c.floors?.[slice] ?? null;
    if (
      inner === null ||
      !refDocClaims(typ, inner.payload, ctxOf(inner.text), {
        expectedAud: c.expectedAud,
        deviceId: c.deviceId,
        now: c.now,
        checkFreshness: false,
        ...(floor === null ? {} : { lastAcceptedIssuedAt: floor }),
      })
    )
      return { imports: false, reason: "inner-doc-rejected" };
    out.push(slice);
  }
  return { imports: true, docs: out };
}
