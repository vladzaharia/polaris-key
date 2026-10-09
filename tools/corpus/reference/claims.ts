// Reference: the claim checks of the envelope families (licence, config, trust, bundle).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import {
  AUD_V3,
  CLOCK_SKEW,
  ISSUER_V3,
  MAX_GRACE_SECONDS,
  MAX_WIRE_INTEGER_REF,
  type TypV3,
} from "../common.js";
import { refCanonicalB64url } from "./b64url.js";
import { PLAIN_INTEGER_REF, refNumberTokens } from "./tokens.js";

// ── The generator's own claim checks, for all six typs ────────────────────────────────────────
// One integer check, three switchable halves: the token rule, the 2^53 − 1 bound, and the
// claim's minimum (§2.2 "Minimums", one literal table below). `off` switches one half off at
// one pointer, which is how §4.9's per-claim self-check proves a case breaks that claim alone.

export interface ClaimCtx {
  tokens: Map<string, string>;
  off: ReadonlySet<string>;
}
export const ctxOf = (text: string, off: Iterable<string> = []): ClaimCtx => ({
  tokens: refNumberTokens(text),
  off: new Set(off),
});

/** §2.2 "Minimums": the 21 integer-claim paths (`*` is any index or member), plans/P4-01.md
 *  §2.5's 16 pack and `content` paths and plans/P4-10.md §2.2's two `chunks` paths (39 in all). */
const INTEGER_CLAIM_MINIMUMS: Readonly<Record<string, Record<string, number>>> =
  {
    envelope: { "/issuedAt": 0, "/expiresAt": 0, "/graceUntil": 0 },
    config: { "/schemaVersion": 1 },
    trust: { "/schemaVersion": 1, "/issuedAt": 0, "/expiresAt": 0 },
    bundle: { "/issuedAt": 0, "/expiresAt": 0 },
    feed: {
      "/schemaVersion": 1,
      "/seq": 1,
      "/issuedAt": 0,
      "/expiresAt": 1,
      "/app/targets/*/release/seq": 1,
      "/app/targets/*/outlets/*/live/seq": 1,
      "/app/targets/*/outlets/*/rollout/bp": 0,
    },
    record: {
      "/schemaVersion": 1,
      "/seq": 1,
      "/issuedAt": 0,
      "/minSupportedSeq": 1,
      "/builds/*/artifacts/*/size": 0,
    },
    // plans/P4-01.md §2.5: the pack record's 14 paths and the app record's two `content` paths.
    pack: {
      "/formatVersion": 1,
      "/handler/mountOrder": 0,
      "/variants/*/payload/size": 0,
      "/variants/*/full/bytes": 0,
      "/variants/*/full/size": 0,
      "/variants/*/files/bytes": 1,
      "/variants/*/files/size": 1,
      "/variants/*/files/gaps/bytes": 0,
      "/variants/*/files/gaps/size": 0,
      "/variants/*/deltas/*/memBytes": 1,
      "/variants/*/deltas/*/artifact/bytes": 1,
      "/variants/*/deltas/*/patch/bytes": 1,
      "/variants/*/deltas/*/patch/size": 1,
      "/variants/*/deltas/*/data/bytes": 1,
      // plans/P4-10.md §2.2: the chunk index's object ref (`bytes` and `size` from 1).
      "/variants/*/chunks/bytes": 1,
      "/variants/*/chunks/size": 1,
    },
    content: { "/content/contentApi": 1, "/content/pins/*/release/seq": 1 },
  };
/** A concrete pointer's path (`/app/targets/0/release/seq` → `/app/targets/*\/release/seq`). */
export function claimPathOf(family: string, pointer: string): string | null {
  const parts = pointer.split("/");
  for (const path of Object.keys(INTEGER_CLAIM_MINIMUMS[family]!)) {
    const want = path.split("/");
    if (want.length !== parts.length) continue;
    if (want.every((w, k) => w === "*" || w === parts[k])) return path;
  }
  return null;
}
function minimumOf(family: string, pointer: string): number {
  const path = claimPathOf(family, pointer);
  if (path === null) throw new Error(`no minimum for ${family} ${pointer}`);
  return INTEGER_CLAIM_MINIMUMS[family]![path]!;
}

export function refInt(
  ctx: ClaimCtx,
  family: string,
  value: unknown,
  pointer: string,
): boolean {
  const token = ctx.tokens.get(pointer);
  if (typeof value !== "number" || token === undefined) return false;
  const min = minimumOf(family, pointer);
  const plain = PLAIN_INTEGER_REF.test(token);
  if (!plain && !ctx.off.has(`token:${pointer}`)) return false;
  const big = plain ? BigInt(token) : null;
  const over =
    big !== null
      ? big > BigInt(MAX_WIRE_INTEGER_REF)
      : value > MAX_WIRE_INTEGER_REF;
  if (over && !ctx.off.has(`bound:${pointer}`)) return false;
  const under = big !== null ? big < BigInt(min) : value < min;
  if (under && !ctx.off.has(`min:${pointer}`)) return false;
  return true;
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

export interface EnvelopeOpts {
  expectedAud: string;
  deviceId: string;
  now: number;
  checkFreshness?: boolean;
  lastAcceptedIssuedAt?: number;
}

/** V3 §3's envelope and the licence or config claims, with V4 §3's integer rule. */
export function refDocClaims(
  typ: TypV3,
  doc: unknown,
  ctx: ClaimCtx,
  o: EnvelopeOpts,
): boolean {
  if (!isObj(doc)) return false;
  if (doc.aud !== o.expectedAud || doc.iss !== ISSUER_V3) return false;
  if (doc.deviceId !== o.deviceId) return false;
  const e = "envelope";
  if (!refInt(ctx, e, doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, e, doc.expiresAt, "/expiresAt")) return false;
  if (!refInt(ctx, e, doc.graceUntil, "/graceUntil")) return false;
  const [iat, exp, grace] = [
    doc.issuedAt,
    doc.expiresAt,
    doc.graceUntil,
  ] as number[];
  if (o.lastAcceptedIssuedAt !== undefined && iat! <= o.lastAcceptedIssuedAt)
    return false;
  if (grace! < exp! || grace! > iat! + MAX_GRACE_SECONDS) return false;
  if (o.checkFreshness !== false) {
    if (iat! > o.now + CLOCK_SKEW || exp! <= o.now - CLOCK_SKEW) return false;
  }
  if (typ === "pkey-license+jws") {
    if (typeof doc.licenseId !== "string" || doc.licenseId === "") return false;
    if (!isObj(doc.entitlements)) return false;
    if (hasOwn(doc, "profile") && !isObj(doc.profile)) return false;
    return true;
  }
  if (!refInt(ctx, "config", doc.schemaVersion, "/schemaVersion")) return false;
  return isObj(doc.config) && isObj(doc.secrets);
}

/** The statuses that keep a published key (V4 §1), restated rather than imported. */
const REF_LIVE_STATUSES: ReadonlySet<unknown> = new Set([
  "active",
  "staged",
  "retired",
]);

/** V3 §1 / §2.3's trust-manifest claims; the keys, the substitution rule and V4 §1's key
 *  custody: the status allow-list, canonical published keys, and pinned-key tombstones (a
 *  pinned kid listed `revoked` with its exact bytes by another pin; never by its own signer).
 *  `signer` is the verified header `kid` (absent in the per-claim self-check, which never
 *  revokes a pin); `tombstones` are the pinned kids already tombstoned. */
export function refTrustClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: {
    pinned: Record<string, string>;
    now: number;
    checkFreshness?: boolean;
    signer?: string;
    tombstones?: ReadonlySet<string>;
  },
): { discovered: Record<string, string>; revoked: string[] } | null {
  if (!isObj(doc)) return null;
  const t = "trust";
  if (
    !refInt(ctx, t, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return null;
  if (doc.aud !== AUD_V3 || doc.iss !== ISSUER_V3) return null;
  if (!refInt(ctx, t, doc.issuedAt, "/issuedAt")) return null;
  if (!refInt(ctx, t, doc.expiresAt, "/expiresAt")) return null;
  if (o.checkFreshness !== false) {
    if ((doc.issuedAt as number) > o.now + CLOCK_SKEW) return null;
    if ((doc.expiresAt as number) <= o.now - CLOCK_SKEW) return null;
  }
  if (!Array.isArray(doc.keys)) return null;
  const tombstones = o.tombstones ?? new Set<string>();
  const out: Record<string, string> = {};
  const revoked = new Set<string>();
  for (const key of doc.keys) {
    if (
      !isObj(key) ||
      typeof key.kid !== "string" ||
      typeof key.publicKey !== "string"
    )
      return null;
    const pinned = hasOwn(o.pinned, key.kid);
    if (pinned && o.pinned[key.kid] !== key.publicKey) return null;
    if (key.status === "revoked") {
      if (pinned) {
        if (key.kid === o.signer) return null;
        if (!tombstones.has(key.kid)) revoked.add(key.kid);
      }
      continue;
    }
    if (!REF_LIVE_STATUSES.has(key.status)) continue;
    if (key.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519")
      continue;
    if (!refCanonicalB64url(key.publicKey)) continue;
    out[key.kid] = key.publicKey;
  }
  for (const kid of [...tombstones, ...revoked]) delete out[kid];
  return { discovered: out, revoked: [...revoked].sort(refByteOrder) };
}

/** Ascending byte order of the UTF-8 encodings. */
export const refByteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** V3 §7 step 2: the bundle's own claims, and the `docs` shapes (V4 §3 presence). */
export function refBundleClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: { now: number; deviceId: string; reload?: boolean },
): boolean {
  if (!isObj(doc)) return false;
  if (typeof doc.bundleId !== "string" || doc.bundleId === "") return false;
  if (typeof doc.trust !== "string") return false;
  if (doc.aud !== AUD_V3 || doc.deviceId !== o.deviceId) return false;
  if (!refInt(ctx, "bundle", doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, "bundle", doc.expiresAt, "/expiresAt")) return false;
  // V4 §7: the reload profile is step 2 without its two import-window comparisons.
  if (!o.reload) {
    if ((doc.issuedAt as number) > o.now + CLOCK_SKEW) return false;
    if (o.now > (doc.expiresAt as number) + CLOCK_SKEW) return false;
  }
  if (!isObj(doc.docs)) return false;
  const docs = doc.docs;
  for (const k of ["license", "config"])
    if (hasOwn(docs, k) && typeof docs[k] !== "string") return false;
  return hasOwn(docs, "license") || hasOwn(docs, "config");
}
