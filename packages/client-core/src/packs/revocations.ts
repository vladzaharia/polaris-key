// The device's revocations (plans/P4-13.md §2.5 "Persistence"): a sibling document,
// `revocations.json`, beside P4-06's pack state and never inside it, so an unparseable
// `state.json` cannot lose revocations and a lost revocation file cannot touch the install state.
//
//   {v: 1, revoked: {[targetSha256]: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}
//
// Each entry holds the winning revocation's compact JWS verbatim, the pin it was verified with
// (the feed entry's `pack`, `version`, `seq`), its record hash and its `issuedAt`. The document is
// NEVER trusted from storage: `reloadRevocations` re-verifies every entry against the currently
// pinned release keys and the stored pin, and a failing entry is dropped alone. A key that is no
// longer pinned forgets its target (the key-rotation recovery lever for a stolen release key); any
// other failure adds the entry's pack to `relearn`, cleared only by a fresh, network-verified
// feed whose `revocations` member is present and usable, or by `recoverState()`.
//
// Pure functions over the document: each returns a new document and changes nothing in place.
// The engine (`./engine.ts`) owns the I/O, the `revocationsStored` flag in `state.json` and the
// mount refusals.

import { scanStrictJson, type TrustSet } from "@polaris-key/jws";
import type { ContentHold } from "@polaris-key/protocol/packs";
import {
  newerRevocation,
  verifyRevocation,
  type VerifiedRevocation,
} from "../record.js";
import { SHA256_RE, holdsOf, isObject, isPackId } from "./claims.js";

/** The document's version. */
export const REVOCATIONS_VERSION = 1;
/** A device keeps at most this many revoked targets; beyond it the oldest by `issuedAt` is
 *  dropped first (and its pack is NOT added to `relearn`: dropping at the cap is deliberate). */
export const MAX_STORED_REVOCATIONS = 256;

/** One stored revocation: the winner for its target. */
export interface StoredRevocation {
  /** The revocation record's compact JWS, verbatim. */
  jws: string;
  /** The pin it was verified with: the feed entry's pack, version and `seq`. */
  pack: string;
  version: string;
  seq: number;
  /** The revocation record's hash. */
  record: string;
  issuedAt: number;
}

export interface RevocationsDoc {
  v: typeof REVOCATIONS_VERSION;
  /** Revoked target hash → the winning revocation. */
  revoked: Record<string, StoredRevocation>;
  /** Packs whose revocations must be re-learned from a fresh feed. */
  relearn: string[];
}

export function emptyRevocations(): RevocationsDoc {
  return { v: REVOCATIONS_VERSION, revoked: {}, relearn: [] };
}

/** True when the document holds nothing (the state a product with no revocations is in). */
export function isEmptyRevocations(doc: RevocationsDoc): boolean {
  return Object.keys(doc.revoked).length === 0 && doc.relearn.length === 0;
}

const nat = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Parse the stored text's shape. Null when it does not parse as the document at all (a torn
 * file, which the engine quarantines). Entries of the wrong shape are dropped with their pack (if
 * it can be read) added to `relearn`: shape only, `reloadRevocations` decides what is trusted.
 */
export function parseRevocations(text: string): RevocationsDoc | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(doc) || doc.v !== REVOCATIONS_VERSION) return null;
  if (!isObject(doc.revoked) || !Array.isArray(doc.relearn)) return null;
  const out = emptyRevocations();
  const relearn = new Set<string>();
  for (const p of doc.relearn) if (isPackId(p)) relearn.add(p);
  for (const [target, e] of Object.entries(doc.revoked)) {
    const ok =
      SHA256_RE.test(target) &&
      isObject(e) &&
      typeof e.jws === "string" &&
      isPackId(e.pack) &&
      typeof e.version === "string" &&
      nat(e.seq) &&
      e.seq >= 1 &&
      typeof e.record === "string" &&
      SHA256_RE.test(e.record) &&
      nat(e.issuedAt);
    if (ok)
      out.revoked[target] = {
        jws: e.jws as string,
        pack: e.pack as string,
        version: e.version as string,
        seq: e.seq as number,
        record: e.record as string,
        issuedAt: e.issuedAt as number,
      };
    else if (isObject(e) && isPackId(e.pack)) relearn.add(e.pack);
  }
  out.relearn = [...relearn].sort();
  return out;
}

export function serializeRevocations(doc: RevocationsDoc): string {
  return JSON.stringify(doc);
}

/** The protected header's `kid`, read without trusting anything else. */
function kidOf(jws: string): string | null {
  try {
    const seg = jws.split(".")[0] ?? "";
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const h = JSON.parse(json) as unknown;
    return isObject(h) && typeof h.kid === "string" ? h.kid : null;
  } catch {
    return null;
  }
}

export interface ReloadRevocationsResult {
  doc: RevocationsDoc;
  /** The verified revocation of every surviving target. */
  verified: Map<string, VerifiedRevocation>;
  /** Whether re-verification changed the document (a drop or a `relearn` addition). */
  changed: boolean;
}

/**
 * Re-verify every entry against the currently pinned release keys and its stored pin (`target` =
 * the map key, `record` = the stored hash). A failing entry is dropped alone: a key that is no
 * longer pinned forgets the target; any other failure adds the entry's pack to `relearn`. Never
 * throws.
 */
export async function reloadRevocations(
  doc: RevocationsDoc,
  opts: { releaseKeys: TrustSet; productTrust: TrustSet; expectedAud: string },
): Promise<ReloadRevocationsResult> {
  const out: RevocationsDoc = {
    v: REVOCATIONS_VERSION,
    revoked: {},
    relearn: [...doc.relearn],
  };
  const verified = new Map<string, VerifiedRevocation>();
  let changed = false;
  const relearn = new Set(out.relearn);
  for (const [target, e] of Object.entries(doc.revoked)) {
    const r = await verifyRevocation(e.jws, {
      releaseKeys: opts.releaseKeys,
      productTrust: opts.productTrust,
      expectedAud: opts.expectedAud,
      entry: {
        record: e.record,
        pack: e.pack,
        target,
        version: e.version,
        seq: e.seq,
      },
    }).catch(() => ({ ok: false as const, step: "jws" as const }));
    if (r.ok) {
      out.revoked[target] = e;
      verified.set(target, r.revocation);
      continue;
    }
    changed = true;
    const kid = kidOf(e.jws);
    const rotated =
      r.step === "jws" &&
      kid !== null &&
      !Object.prototype.hasOwnProperty.call(opts.releaseKeys, kid);
    if (!rotated) relearn.add(e.pack);
  }
  out.relearn = [...relearn].sort();
  return { doc: out, verified, changed };
}

/**
 * Store a verified revocation (plans/P4-13.md §2.5 step 11): kept when its target is new, or
 * when `newerRevocation` ranks it above the stored one (a superseding revocation). Then the cap.
 * Returns the new document and whether anything changed.
 */
export function storeRevocation(
  doc: RevocationsDoc,
  revocation: VerifiedRevocation,
  jws: string,
  storedIssuedAt?: (target: string) => VerifiedRevocation | undefined,
): { doc: RevocationsDoc; changed: boolean } {
  const target = revocation.target;
  const prev = Object.prototype.hasOwnProperty.call(doc.revoked, target)
    ? doc.revoked[target]!
    : undefined;
  if (prev) {
    if (prev.record === revocation.record) return { doc, changed: false };
    const stored = storedIssuedAt?.(target) ?? {
      ...revocation,
      record: prev.record,
      issuedAt: prev.issuedAt,
    };
    if (newerRevocation(revocation, stored) !== revocation)
      return { doc, changed: false };
  }
  const next: RevocationsDoc = {
    v: REVOCATIONS_VERSION,
    revoked: {
      ...doc.revoked,
      [target]: {
        jws,
        pack: revocation.pack,
        version: revocation.version,
        seq: revocation.seq,
        record: revocation.record,
        issuedAt: revocation.issuedAt,
      },
    },
    relearn: [...doc.relearn],
  };
  return { doc: capRevocations(next), changed: true };
}

/** Keep at most `MAX_STORED_REVOCATIONS` targets: the oldest by `issuedAt` (then the lower record
 *  hash) is dropped first, without adding its pack to `relearn`. */
export function capRevocations(doc: RevocationsDoc): RevocationsDoc {
  const targets = Object.keys(doc.revoked);
  if (targets.length <= MAX_STORED_REVOCATIONS) return doc;
  const keep = targets
    .sort((a, b) => {
      const x = doc.revoked[a]!;
      const y = doc.revoked[b]!;
      if (x.issuedAt !== y.issuedAt) return y.issuedAt - x.issuedAt;
      return x.record < y.record ? 1 : x.record > y.record ? -1 : 0;
    })
    .slice(0, MAX_STORED_REVOCATIONS);
  const revoked: Record<string, StoredRevocation> = {};
  for (const t of keep) revoked[t] = doc.revoked[t]!;
  return { v: REVOCATIONS_VERSION, revoked, relearn: [...doc.relearn] };
}

/** Clear `relearn` for the given packs. */
export function clearRelearn(
  doc: RevocationsDoc,
  packs: readonly string[],
): { doc: RevocationsDoc; changed: boolean } {
  if (packs.length === 0) return { doc, changed: false };
  const drop = new Set(packs);
  const relearn = doc.relearn.filter((p) => !drop.has(p));
  if (relearn.length === doc.relearn.length) return { doc, changed: false };
  return { doc: { ...doc, relearn }, changed: true };
}

/**
 * The holds of a content stamp file (plans/P4-13.md §2.4): strict JSON, then `holdsOf` at the
 * stamp's top level with its own non-wire pointers. `parseContentStamp`'s result is unchanged and
 * carries no holds; a host that runs the content decision reads them with this. Null when the
 * stamp does not parse or its holds are unusable. Never throws.
 */
export function stampHolds(input: Uint8Array | string): ContentHold[] | null {
  try {
    const text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
    const scan = scanStrictJson(text);
    if (!scan.ok) return null;
    return holdsOf(JSON.parse(text), scan.nonWireIntegers, "");
  } catch {
    return null;
  }
}
