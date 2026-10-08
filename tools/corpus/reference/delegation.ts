// Reference: content-key delegation (plans/P4-19.md).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { base64UrlDecode } from "@polaris-key/jws";
import { sha256Hex, utf8Bytes } from "../common.js";
import { type ClaimCtx, ctxOf, hasOwn, isObj } from "./claims.js";
import { p13Int, refPackId } from "./content.js";
import { refVerifyJws } from "./jws.js";
import { refRecordSteps } from "./packs.js";
import { REF_PACK_TYPE_RE } from "./patterns.js";
import { refRecordClaims } from "./record.js";
import { payloadTextOf } from "./tokens.js";

const P19_DELEGABLE = ["files.tree", "data.json", "l10n.table"];
export const P19_MAX_TTL = 31622400;
const P19_MAX_TYPES = 8;
const P19_KEY_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const P19_KID_RE = /^pkd1-[0-9a-f]{64}$/;

/** §2.2's `delegationOf`, from first principles. */
function refDelegationOf(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown> | null {
  if (doc.kind !== "delegation" || !refPackId(doc.deliverable)) return null;
  const d = doc.delegate;
  if (!isObj(d) || typeof d.publicKey !== "string") return null;
  if (!P19_KEY_RE.test(d.publicKey)) return null;
  const types = doc.types;
  if (!Array.isArray(types) || types.length < 1 || types.length > P19_MAX_TYPES)
    return null;
  if (new Set(types).size !== types.length) return null;
  if (!types.every((t) => typeof t === "string" && REF_PACK_TYPE_RE.test(t)))
    return null;
  const effective = types.filter((t) => P19_DELEGABLE.includes(t));
  if (effective.length === 0) return null;
  if (!p13Int(ctx, doc.expiresAt, "/expiresAt", 1)) return null;
  if (!p13Int(ctx, doc.issuedAt, "/issuedAt", 0)) return null;
  if (!(doc.issuedAt < doc.expiresAt)) return null;
  if (doc.expiresAt > doc.issuedAt + P19_MAX_TTL) return null;
  return {
    deliverable: doc.deliverable,
    publicKey: d.publicKey,
    types: effective,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
  };
}

export interface DelegationPin {
  kind?: string;
  deliverable: string;
  version: string;
  seq: number;
}

export type P19Step =
  | "hash"
  | "jws"
  | "claims"
  | "cross-check"
  | "delegation"
  | "scope"
  | "revocation";

export const p19Kid = (jws: string): unknown => {
  try {
    return (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(jws.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return undefined;
  }
};

/** §2.3 step 13.1: a delegation against the pinned release keys, by hash. */
function refVerifyDelegation(
  jws: string,
  hash: string,
  releaseKeys: Record<string, string>,
  productTrust: Record<string, string>,
  aud: string,
): (Record<string, any> & { sha256: string }) | null {
  const r = refRecordSteps(jws, hash, releaseKeys, productTrust, aud);
  if (!r.ok || r.doc.kind !== "delegation") return null;
  const text = payloadTextOf(jws)!;
  const body = refDelegationOf(r.doc, ctxOf(text));
  return body === null ? null : { ...body, sha256: hash };
}

/** §2.3's steps 12–16 with an optional delegation, from first principles. */
export function refVerifyDelegatedRecord(c: {
  jws: string;
  delegation: string | null;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin: DelegationPin | null;
}):
  | {
      ok: true;
      doc: Record<string, any>;
      delegation: Record<string, any> | null;
    }
  | { ok: false; step: P19Step } {
  const body = c.jws;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { ok: false, step: "hash" };
  if (sha256Hex(body) !== c.expectedHash) return { ok: false, step: "hash" };
  const kid = p19Kid(body);
  if (typeof kid !== "string") return { ok: false, step: "jws" };
  let key: string;
  let delegation: Record<string, any> | null = null;
  if (hasOwn(c.releaseKeys, kid)) {
    key = c.releaseKeys[kid]!;
    if (Object.values(c.productTrust).includes(key))
      return { ok: false, step: "jws" };
  } else {
    if (c.delegation === null || !P19_KID_RE.test(kid))
      return { ok: false, step: "jws" };
    const d = refVerifyDelegation(
      c.delegation,
      kid.slice(5),
      c.releaseKeys,
      c.productTrust,
      c.expectedAud,
    );
    if (d === null) return { ok: false, step: "delegation" };
    if (
      Object.values(c.releaseKeys).includes(d.publicKey) ||
      Object.values(c.productTrust).includes(d.publicKey)
    )
      return { ok: false, step: "delegation" };
    delegation = d;
    key = d.publicKey;
  }
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { ok: false, step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), c.expectedAud))
    return { ok: false, step: "claims" };
  const doc = v.payload as Record<string, any>;
  if (c.pin) {
    if (
      doc.kind !== (c.pin.kind ?? "app") ||
      doc.deliverable !== c.pin.deliverable
    )
      return { ok: false, step: "cross-check" };
    if (doc.version !== c.pin.version || doc.seq !== c.pin.seq)
      return { ok: false, step: "cross-check" };
  }
  if (delegation !== null) {
    const root = delegation.deliverable as string;
    const inScope =
      doc.kind === "pack" &&
      (doc.deliverable === root || doc.deliverable.startsWith(`${root}.`)) &&
      (delegation.types as string[]).includes(doc.type) &&
      (doc.variants as Record<string, any>[]).every(
        (x) => x.files.layout === "tree",
      ) &&
      delegation.issuedAt <= doc.issuedAt &&
      doc.issuedAt <= delegation.expiresAt;
    if (!inScope) return { ok: false, step: "scope" };
  }
  return { ok: true, doc, delegation };
}

/** §2.3's `recordRevoked`, from first principles. */
export function refRecordRevoked(
  record: string,
  delegation: string | null,
  revoked: readonly string[],
): "record" | "delegation" | null {
  if (revoked.includes(record)) return "record";
  if (delegation !== null && revoked.includes(delegation)) return "delegation";
  return null;
}
