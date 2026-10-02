// The release record — WIRE-CONTRACT-V4 §2.4 and client steps 12–16 (plans/P3-01.md §2.4,
// §2.5). P3-02 landed `releaseRecordClaims` (step 14), which P3-03's ingest and CLI signer run;
// P3-05 adds `recordHash`, `verifyReleaseRecord` (hash before signature, key selection from the
// pinned release keys only, signature, claims, cross-check) and the reload path around it.
// Nothing here does I/O or throws.

import {
  base64UrlDecode,
  verifyJws,
  type NonWireIntegers,
  type TrustSet,
} from "@polaris-key/jws";
import {
  MAX_BUILD_EMBEDS,
  MAX_DELEGATION_TTL_SECONDS,
  MAX_DELEGATION_TYPES,
  MAX_PACK_VARIANTS,
  MAX_RECORD_JWS_BYTES,
  MAX_VARIANT_DELTAS,
  REVOCATION_REASON_MAX_BYTES,
} from "@polaris-key/protocol/core";
import {
  DELEGABLE_PACK_TYPES,
  ENGINE_PATTERN,
  ENTITLEMENT_PATTERN,
  HANDLER_PREFIX_PATTERN,
  OBJECT_FORMAT_PATTERN,
  PACK_TYPE_PATTERN,
  VARIANT_AXIS_PATTERN,
  VARIANT_VALUE_PATTERN,
  VOCAB_TOKEN_PATTERN,
} from "@polaris-key/protocol/packs";
import {
  BUILD_ID_PATTERN,
  DELEGATED_KID_PATTERN,
  type ReleaseRecordDoc,
} from "@polaris-key/protocol/release";
import type { FeedRevocation, ReleasePin } from "@polaris-key/protocol/update";
import { NO_NON_WIRE_INTEGERS, isWireInteger } from "./claims.js";
import {
  contentClaims,
  isPackId,
  objectRef,
  utf8Length,
} from "./packs/claims.js";
import { variantKey } from "./packs/variant.js";

export { isPackId, objectRef } from "./packs/claims.js";

export interface ReleaseRecordClaimsOptions {
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The verified payload's `nonWireIntegers`; omit when checking an object you built. */
  nonWire?: NonWireIntegers;
}

/** `@polaris-key/manifest`'s `DELIVERABLE_ID_PATTERN`, restated (client-core does not depend on
 *  the manifest package); at most 64 bytes. */
const DELIVERABLE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
/** P2-04's `VERSION_RE`. The record names no scheme: the pin's version parses under the feed's. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_BUILDS = 64;
const MAX_ARTIFACTS = 32;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
/** An optional string member: absent, or a string (a present `null` is refused). */
const optString = (o: Record<string, unknown>, key: string): boolean =>
  !has(o, key) || typeof o[key] === "string";

function claimsOk(
  doc: Record<string, unknown>,
  opts: ReleaseRecordClaimsOptions,
  nonWire: NonWireIntegers,
): boolean {
  const int = (v: unknown, pointer: string, min: number): v is number =>
    isWireInteger(v, pointer, min, nonWire);

  if (!int(doc.schemaVersion, "/schemaVersion", 1) || doc.schemaVersion !== 1)
    return false;
  if (doc.aud !== opts.expectedAud) return false;
  if (
    typeof doc.deliverable !== "string" ||
    doc.deliverable.length > 64 ||
    !DELIVERABLE_RE.test(doc.deliverable)
  )
    return false;
  if (!nonEmpty(doc.kind)) return false;
  if (typeof doc.version !== "string" || !VERSION_RE.test(doc.version))
    return false;
  if (!int(doc.seq, "/seq", 1)) return false;
  if (!int(doc.issuedAt, "/issuedAt", 0)) return false;
  if (
    has(doc, "minSupportedSeq") &&
    !int(doc.minSupportedSeq, "/minSupportedSeq", 1)
  )
    return false;
  for (const key of ["tag", "channel", "title", "notes"])
    if (!optString(doc, key)) return false;
  if (has(doc, "provenance")) {
    const p = doc.provenance;
    if (!isObject(p) || !optString(p, "commit") || !optString(p, "workflowRun"))
      return false;
  }

  // plans/P4-01.md §2.2: §2.3 applies to `kind: pack` and §2.4 to `kind: app`; a record of any
  // other kind keeps the common claims only.
  if (doc.kind === "pack") return packClaimsOk(doc, nonWire);
  if (
    doc.kind === "app" &&
    has(doc, "content") &&
    !contentClaims(doc.content, { nonWire, pointer: "/content" })
  )
    return false;

  if (!has(doc, "builds")) return doc.kind !== "app";
  const builds = doc.builds;
  if (!Array.isArray(builds) || builds.length < 1 || builds.length > MAX_BUILDS)
    return false;
  const ids = new Set<string>();
  for (const [i, build] of builds.entries()) {
    if (!isObject(build)) return false;
    if (typeof build.id !== "string" || !BUILD_ID_PATTERN.test(build.id))
      return false;
    if (ids.has(build.id)) return false;
    ids.add(build.id);
    if (
      !nonEmpty(build.platform) ||
      !nonEmpty(build.arch) ||
      !nonEmpty(build.format)
    )
      return false;
    if (!optString(build, "buildNumber") || !optString(build, "minOS"))
      return false;
    if (has(build, "requires") && !isObject(build.requires)) return false;
    const artifacts = build.artifacts;
    if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS)
      return false;
    let payloads = 0;
    for (const [j, artifact] of artifacts.entries()) {
      if (!isObject(artifact)) return false;
      if (!nonEmpty(artifact.name) || !nonEmpty(artifact.role)) return false;
      if (artifact.role === "payload") payloads++;
      if (
        typeof artifact.sha256 !== "string" ||
        !SHA256_RE.test(artifact.sha256)
      )
        return false;
      if (!int(artifact.size, `/builds/${i}/artifacts/${j}/size`, 0))
        return false;
      if (!optString(artifact, "contentType")) return false;
    }
    if (payloads > 1) return false;
    if (doc.kind === "app" && has(build, "embeds") && !embedsOk(build.embeds))
      return false;
  }
  return true;
}

/** `builds[].embeds` (plans/P4-01.md §2.4): 0–64 unique pack ids. */
function embedsOk(embeds: unknown): boolean {
  if (!Array.isArray(embeds) || embeds.length > MAX_BUILD_EMBEDS) return false;
  const seen = new Set<string>();
  for (const id of embeds) {
    if (!isPackId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** An optional member that must match `re` when present (a present `null` is refused). */
const optPattern = (
  o: Record<string, unknown>,
  key: string,
  re: RegExp,
): boolean => !has(o, key) || (typeof o[key] === "string" && re.test(o[key]));

/** A `{sha256, bytes}` member (a delta's `artifact` or `data`): bytes ≥ 1. */
function hashBytesOk(
  v: unknown,
  pointer: string,
  nonWire: NonWireIntegers,
): boolean {
  return (
    isObject(v) &&
    typeof v.sha256 === "string" &&
    SHA256_RE.test(v.sha256) &&
    isWireInteger(v.bytes, `${pointer}/bytes`, 1, nonWire)
  );
}

/**
 * The pack record's claims (plans/P4-01.md §2.3), after the common ones: the 55 `kind: pack`
 * checks of §4.6, P4-10's checks 81–83 on `chunks` (plans/P4-10.md §2.2) and the integer rule at
 * §2.5's paths (18 with `chunks.bytes` and `chunks.size`). A value outside a v1 vocabulary is never
 * refused here; it only makes the governed thing unusable (§2.2).
 */
function packClaimsOk(
  doc: Record<string, unknown>,
  nonWire: NonWireIntegers,
): boolean {
  const int = (v: unknown, pointer: string, min: number): boolean =>
    isWireInteger(v, pointer, min, nonWire);
  if (doc.deliverable === "app") return false;
  if (has(doc, "builds")) return false;
  if (typeof doc.type !== "string" || !PACK_TYPE_PATTERN.test(doc.type))
    return false;
  if (!int(doc.formatVersion, "/formatVersion", 1)) return false;
  if (has(doc, "handler")) {
    const h = doc.handler;
    if (!isObject(h)) return false;
    if (has(h, "mountOrder") && !int(h.mountOrder, "/handler/mountOrder", 0))
      return false;
    if (has(h, "prefixes")) {
      const p = h.prefixes;
      if (!Array.isArray(p) || p.length < 1 || p.length > 32) return false;
      const seen = new Set<string>();
      for (const prefix of p) {
        if (typeof prefix !== "string" || !HANDLER_PREFIX_PATTERN.test(prefix))
          return false;
        if (utf8Length(prefix) > 256 || seen.has(prefix)) return false;
        seen.add(prefix);
      }
    }
    if (!optPattern(h, "activation", VOCAB_TOKEN_PATTERN)) return false;
  }
  if (!optPattern(doc, "entitlement", ENTITLEMENT_PATTERN)) return false;

  const variants = doc.variants;
  if (
    !Array.isArray(variants) ||
    variants.length < 1 ||
    variants.length > MAX_PACK_VARIANTS
  )
    return false;
  const keys = new Set<string>();
  let axes: string | null = null;
  for (const [i, v] of variants.entries()) {
    if (!isObject(v)) return false;
    const at = `/variants/${i}`;
    const sel = v.variant;
    if (!isObject(sel)) return false;
    const names = Object.keys(sel);
    if (names.length > 4) return false;
    for (const name of names) {
      if (!VARIANT_AXIS_PATTERN.test(name)) return false;
      const value = sel[name];
      if (typeof value !== "string" || !VARIANT_VALUE_PATTERN.test(value))
        return false;
    }
    const p = v.payload;
    if (!isObject(p)) return false;
    if (!int(p.size, `${at}/payload/size`, 0)) return false;
    if (typeof p.sha256 !== "string" || !SHA256_RE.test(p.sha256)) return false;
    if (!objectRef(v.full, `${at}/full`, 0, 0, nonWire)) return false;
    const f = v.files;
    if (!isObject(f)) return false;
    if (typeof f.format !== "string" || !OBJECT_FORMAT_PATTERN.test(f.format))
      return false;
    if (typeof f.layout !== "string" || !VOCAB_TOKEN_PATTERN.test(f.layout))
      return false;
    if (!objectRef(f, `${at}/files`, 1, 1, nonWire)) return false;
    if (has(f, "gaps")) {
      if (!isObject(f.gaps)) return false;
      if (f.layout === "tree") return false;
      if (!objectRef(f.gaps, `${at}/files/gaps`, 0, 0, nonWire)) return false;
    } else if (f.layout === "container") return false;
    if (has(v, "deltas")) {
      const deltas = v.deltas;
      if (!Array.isArray(deltas) || deltas.length > MAX_VARIANT_DELTAS)
        return false;
      const ids = new Set<string>();
      for (const [j, d] of deltas.entries()) {
        if (!isObject(d)) return false;
        const dt = `${at}/deltas/${j}`;
        if (typeof d.method !== "string" || !VOCAB_TOKEN_PATTERN.test(d.method))
          return false;
        if (typeof d.scope !== "string" || !VOCAB_TOKEN_PATTERN.test(d.scope))
          return false;
        if (d.scope === "payload" && f.layout === "tree") return false;
        if (typeof d.from !== "string" || !SHA256_RE.test(d.from)) return false;
        if (!int(d.memBytes, `${dt}/memBytes`, 1)) return false;
        let id: string | null = null;
        if (d.scope === "payload") {
          if (!hashBytesOk(d.artifact, `${dt}/artifact`, nonWire)) return false;
          id = (d.artifact as { sha256: string }).sha256;
        } else if (d.scope === "files") {
          if (!objectRef(d.patch, `${dt}/patch`, 1, 1, nonWire)) return false;
          if (!hashBytesOk(d.data, `${dt}/data`, nonWire)) return false;
          id = (d.patch as { sha256: string }).sha256;
        }
        if (id !== null) {
          if (ids.has(id)) return false;
          ids.add(id);
        }
      }
    }
    if (has(v, "requires")) {
      const r = v.requires;
      if (!isObject(r) || !optPattern(r, "engine", ENGINE_PATTERN))
        return false;
    }
    // plans/P4-10.md §2.2: checks 81–83 and the object ref at `chunks` (its `bytes` and `size`
    // from 1). Members other than these are ignored (reserved: an index delta).
    if (has(v, "chunks")) {
      const c = v.chunks;
      if (!isObject(c)) return false;
      if (typeof c.format !== "string" || !OBJECT_FORMAT_PATTERN.test(c.format))
        return false;
      if (!objectRef(c, `${at}/chunks`, 1, 1, nonWire)) return false;
      if (has(c, "params") && !isObject(c.params)) return false;
    }
    const key = variantKey(sel as Record<string, string>);
    if (keys.has(key)) return false;
    keys.add(key);
    const axisSet = JSON.stringify([...names].sort());
    if (axes === null) axes = axisSet;
    else if (axes !== axisSet) return false;
  }
  return true;
}

/**
 * Client step 14 over a verified record payload: true when every claim of §2.4 holds. A caller
 * holding a parsed JWS passes `verifyJws`'s `nonWireIntegers`; a caller checking an object it
 * built passes none. A `kind: pack` record must pass the pack claims (plans/P4-01.md §2.3) and a
 * `kind: app` record's `content` and `builds[].embeds` the app ones (§2.4); reserved kinds
 * (`revocation`, `delegation`) and unknown kinds keep the common claims only, ignoring any
 * `content` or `embeds`. The cross-check refuses them where an app record is expected. The
 * Worker's ingest and the CLI's self-check run this same function. Never throws.
 */
export function releaseRecordClaims(
  payload: unknown,
  opts: ReleaseRecordClaimsOptions,
): boolean {
  if (!isObject(payload)) return false;
  try {
    return claimsOk(payload, opts, opts.nonWire ?? NO_NON_WIRE_INTEGERS);
  } catch {
    return false;
  }
}

// ── P3-05: hash, key selection, signature, cross-check (client steps 12–16) ──────────────────

const NON_ASCII_RE = /[^\x00-\x7f]/;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * The record hash (WIRE-CONTRACT-V4 §8): the lowercase hex SHA-256 of the compact JWS's bytes,
 * exactly as received. A record is ASCII; `verifyReleaseRecord` refuses any other body before
 * hashing it, so the UTF-8 encoding here only matters to a caller hashing something else.
 */
export async function recordHash(jws: string): Promise<string> {
  const bytes = new TextEncoder().encode(jws);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return hex(new Uint8Array(digest));
}

/** What a target pins, for the cross-check (step 15). */
export interface ReleaseRecordPin {
  /** The record kind the pin names: `app` when absent (a feed target), `pack` for a content
   *  pin (plans/P4-01.md §2.6). */
  kind?: string;
  deliverable: string;
  version: string;
  seq: number;
}

export interface VerifyReleaseRecordOptions {
  /** The PINNED release keys (`pinnedReleaseKeys`): the only keys a record verifies against,
   *  never merged with, and never added to from, the product trust set (step 13). */
  releaseKeys: TrustSet;
  /** The EFFECTIVE product trust set. A selected release key whose raw bytes are also in it
   *  is refused at step `jws` (a release key is never a product key). */
  productTrust: TrustSet;
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The feed's pin, `targets[].release.sha256`: the lowercase hex SHA-256 the body must have. */
  expectedHash: string;
  /** The pin to cross-check against (step 15). Omit to verify only (a reserved kind). */
  pin?: ReleaseRecordPin;
  /**
   * The compact JWS of the delegation a `pkd1-` kid names (plans/P4-19.md §2.3), fetched by the
   * caller from the record route by `delegationHashOf(jws)`. Only the surfaces of §2.4 pass it (a
   * compatible or standalone pack's feed target, and the reload of a stored delegated install);
   * without it the behaviour is byte-for-byte P4-13's. Ignored when the kid is a pinned release
   * key.
   */
  delegation?: string;
}

/** Why `verifyReleaseRecord` refused, by client step (`releaseRecordCases` `expect.step`).
 *  `delegation` and `scope` are the delegated path's (plans/P4-19.md §2.3). */
export type ReleaseRecordStep =
  | "hash"
  | "jws"
  | "claims"
  | "cross-check"
  | "delegation"
  | "scope";

/** The delegation a delegated record verified through (plans/P4-19.md §2.3). */
export interface RecordDelegation {
  /** The delegation's record hash (the kid's hex). */
  sha256: string;
  /** The scope root. */
  deliverable: string;
  /** The effective types (`types ∩ DELEGABLE_PACK_TYPES`), in the delegation's order. */
  types: string[];
  issuedAt: number;
  expiresAt: number;
}

export type VerifyReleaseRecordResult =
  | {
      ok: true;
      record: ReleaseRecordDoc;
      /** The verified payload's non-wire integer pointers (for `revocationOf`, `holdsOf`). */
      nonWireIntegers: NonWireIntegers;
      /** The delegation, when a content key signed the record; null for a release key. */
      delegation: RecordDelegation | null;
    }
  | { ok: false; step: ReleaseRecordStep };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function rawKey(b64url: unknown): Uint8Array | null {
  if (typeof b64url !== "string") return null;
  try {
    return base64UrlDecode(b64url);
  } catch {
    return null;
  }
}

/** The protected header's `kid`, read without trusting anything else in it (`verifyJws`
 *  re-reads the header strictly). Null when there is none to read. */
function headerKid(jws: string): string | null {
  const encHeader = jws.split(".")[0];
  if (!encHeader) return null;
  try {
    const header: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        base64UrlDecode(encHeader),
      ),
    );
    if (!isObject(header) || typeof header.kid !== "string") return null;
    return header.kid;
  } catch {
    return null;
  }
}

const fail = (step: ReleaseRecordStep): VerifyReleaseRecordResult => ({
  ok: false,
  step,
});

/** True when any key of `set` has the raw bytes `raw`. */
function inTrust(raw: Uint8Array, set: TrustSet): boolean {
  for (const k of Object.values(set)) {
    const other = rawKey(k);
    if (other !== null && bytesEqual(raw, other)) return true;
  }
  return false;
}

/**
 * Client steps 12–16 (plans/P3-01.md §2.5, plans/P4-19.md §2.3), in the contract's order:
 *
 *  12. a body over `MAX_RECORD_JWS_BYTES` (88 844) or with a byte outside ASCII is refused
 *      without hashing; otherwise its SHA-256 must equal `expectedHash`, before any Ed25519 work;
 *  13. the key is selected by `kid` from `releaseKeys` only, refused if its raw bytes are also
 *      in `productTrust`, then `verifyJws` with that one key and `typ` `pkey-release+jws`.
 *      Otherwise, with `delegation` supplied and a `pkd1-` kid: the delegation is verified
 *      against the pinned release keys (`verifyDelegation`, its hash the kid's hex), its key must
 *      equal no pinned release key and no product key (both step `delegation`), then `verifyJws`
 *      with the delegated key (step `jws`);
 *  14. the claims (`releaseRecordClaims`);
 *  15. with a `pin`: `kind` equals the pin's `kind` (`app` when the pin names none), and
 *      `deliverable`, `version` and `seq` equal the pin's (plans/P4-01.md §2.6);
 *  16. a delegated record only (`scope`): `kind: pack`, `deliverable` the scope root or under it
 *      by whole segments, `type` in the effective types, every variant's `files.layout` `tree`,
 *      and `delegation.issuedAt ≤ issuedAt ≤ delegation.expiresAt`.
 *
 * Never throws.
 */
export async function verifyReleaseRecord(
  jws: string,
  opts: VerifyReleaseRecordOptions,
): Promise<VerifyReleaseRecordResult> {
  try {
    // 12. Hash before signature.
    if (typeof jws !== "string") return fail("hash");
    if (NON_ASCII_RE.test(jws) || jws.length > MAX_RECORD_JWS_BYTES)
      return fail("hash");
    if ((await recordHash(jws)) !== opts.expectedHash) return fail("hash");

    // 13. The pinned release keys only, and never a product key; or one delegation from them.
    const kid = headerKid(jws);
    if (kid === null) return fail("jws");
    let delegation: VerifiedDelegation | null = null;
    let one: TrustSet;
    if (has(opts.releaseKeys, kid)) {
      const key = opts.releaseKeys[kid]!;
      const raw = rawKey(key);
      if (raw === null) return fail("jws");
      if (inTrust(raw, opts.productTrust)) return fail("jws");
      // A computed key is an own property even for `__proto__`.
      one = { [kid]: key };
    } else {
      const hash = delegationHashOf(jws);
      if (typeof opts.delegation !== "string" || hash === null)
        return fail("jws");
      const d = await verifyDelegation(opts.delegation, {
        releaseKeys: opts.releaseKeys,
        productTrust: opts.productTrust,
        expectedAud: opts.expectedAud,
        expectedHash: hash,
      });
      if (!d.ok) return fail("delegation");
      const raw = rawKey(d.delegation.publicKey);
      if (raw === null) return fail("delegation");
      if (inTrust(raw, opts.releaseKeys) || inTrust(raw, opts.productTrust))
        return fail("delegation");
      delegation = d.delegation;
      one = { [kid]: d.delegation.publicKey };
    }
    const v = await verifyJws<unknown>(jws, one, { typ: "pkey-release+jws" });
    if (!v) return fail("jws");

    // 14. The claims.
    if (
      !releaseRecordClaims(v.payload, {
        expectedAud: opts.expectedAud,
        nonWire: v.nonWireIntegers,
      })
    )
      return fail("claims");
    const record = v.payload as ReleaseRecordDoc;

    // 15. The cross-check against the pin.
    const pin = opts.pin;
    if (pin) {
      if (
        (record.kind as string) !== (pin.kind ?? "app") ||
        record.deliverable !== pin.deliverable
      )
        return fail("cross-check");
      if (record.version !== pin.version || record.seq !== pin.seq)
        return fail("cross-check");
    }

    // 16. The delegation's scope.
    if (delegation !== null && !inScope(record, delegation))
      return fail("scope");
    return {
      ok: true,
      record,
      nonWireIntegers: v.nonWireIntegers,
      delegation:
        delegation === null
          ? null
          : {
              sha256: delegation.sha256,
              deliverable: delegation.deliverable,
              types: [...delegation.types],
              issuedAt: delegation.issuedAt,
              expiresAt: delegation.expiresAt,
            },
    };
  } catch {
    return fail("jws");
  }
}

/** Step 16 (plans/P4-19.md §2.3) over a record whose claims passed. */
function inScope(record: ReleaseRecordDoc, d: VerifiedDelegation): boolean {
  const r = record as unknown as Record<string, unknown>;
  if (r.kind !== "pack") return false;
  if (!coversPack(d.deliverable, record.deliverable)) return false;
  if (typeof r.type !== "string" || !d.types.includes(r.type)) return false;
  const variants = r.variants as { files: { layout: unknown } }[];
  if (!variants.every((x) => x.files.layout === "tree")) return false;
  return d.issuedAt <= record.issuedAt && record.issuedAt <= d.expiresAt;
}

/** Whether pack id `pack` is the scope root `root` or under it by whole segments
 *  (plans/P4-19.md §2.3 step 16): `djdl.events` covers `djdl.events.halloween`, never
 *  `djdl.eventsx`. */
export function coversPack(root: string, pack: string): boolean {
  return pack === root || pack.startsWith(`${root}.`);
}

/**
 * The reload path for the `releaseRecords` slice (plans/P3-01.md §2.5): each `records[h]` goes
 * through steps 12–14 with `h` as the pin, and is kept only when `pinned` (the hashes a
 * surviving committed feed's target for this platform pins) holds `h`. Anything else is absent.
 * Never throws.
 */
export async function reloadReleaseRecords(
  cached: Readonly<Record<string, string>> | undefined,
  opts: {
    releaseKeys: TrustSet;
    productTrust: TrustSet;
    expectedAud: string;
    pinned: ReadonlySet<string>;
  },
): Promise<Record<string, { jws: string; record: ReleaseRecordDoc }>> {
  const out: Record<string, { jws: string; record: ReleaseRecordDoc }> = {};
  if (!isObject(cached)) return out;
  for (const [h, jws] of Object.entries(cached)) {
    if (typeof jws !== "string" || !opts.pinned.has(h)) continue;
    const r = await verifyReleaseRecord(jws, {
      releaseKeys: opts.releaseKeys,
      productTrust: opts.productTrust,
      expectedAud: opts.expectedAud,
      expectedHash: h,
    });
    if (r.ok) out[h] = { jws, record: r.record };
  }
  return out;
}

// ── P4-13: the revocation record (plans/P4-13.md §2.3, WIRE-CONTRACT-V4 §2.5.3) ──────────────

/** A usable revocation body, as `revocationOf` reads it. */
export interface RevocationBody {
  /** The revoked pack (the record's `deliverable`). */
  pack: string;
  /** The revoked pack record's hash (`revokes`). */
  target: string;
  replacement: ReleasePin | null;
  reason: string;
  issuedAt: number;
}

/**
 * The revocation body (plans/P4-13.md §2.3), read beside the claims: usable when `kind` is
 * `revocation`, `deliverable` is a pack id, `revokes` is 64 lowercase hex, `replacement` is absent
 * or `{sha256: 64 hex and not revokes, seq: an integer ≥ 1 by token, version}`, and `reason` is a
 * string of 1–`REVOCATION_REASON_MAX_BYTES` bytes. `builds` and `content` are ignored. Null when
 * unusable. Never throws.
 */
export function revocationOf(
  doc: unknown,
  nonWire: NonWireIntegers = NO_NON_WIRE_INTEGERS,
): RevocationBody | null {
  try {
    if (!isObject(doc) || doc.kind !== "revocation") return null;
    if (!isPackId(doc.deliverable)) return null;
    if (typeof doc.revokes !== "string" || !SHA256_RE.test(doc.revokes))
      return null;
    let replacement: ReleasePin | null = null;
    if (has(doc, "replacement")) {
      const r = doc.replacement;
      if (!isObject(r)) return null;
      if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256))
        return null;
      if (r.sha256 === doc.revokes) return null;
      if (!isWireInteger(r.seq, "/replacement/seq", 1, nonWire)) return null;
      if (typeof r.version !== "string" || !VERSION_RE.test(r.version))
        return null;
      replacement = { sha256: r.sha256, seq: r.seq, version: r.version };
    }
    const reason = doc.reason;
    if (typeof reason !== "string") return null;
    const bytes = utf8Length(reason);
    if (bytes < 1 || bytes > REVOCATION_REASON_MAX_BYTES) return null;
    if (typeof doc.issuedAt !== "number") return null;
    return {
      pack: doc.deliverable,
      target: doc.revokes,
      replacement,
      reason,
      issuedAt: doc.issuedAt,
    };
  } catch {
    return null;
  }
}

/** A verified revocation: its body, its record hash and the pin it was verified with. */
export interface VerifiedRevocation extends RevocationBody {
  /** The revocation record's hash. */
  record: string;
  /** The target's version and `seq` (the record's own `version` and `seq`). */
  version: string;
  seq: number;
}

export interface VerifyRevocationOptions {
  /** The PINNED release keys only, never the Worker's trust set. */
  releaseKeys: TrustSet;
  /** The effective product trust set: a release key whose bytes are in it is refused. */
  productTrust: TrustSet;
  expectedAud: string;
  /** The feed's `revocations` entry (or a stored entry's equivalent). */
  entry: Pick<FeedRevocation, "record" | "pack" | "target" | "version" | "seq">;
}

/** Why `verifyRevocation` refused, by step (`revocationCases` `expect.step`). */
export type RevocationStep = ReleaseRecordStep | "revocation";

export type VerifyRevocationResult =
  | { ok: true; revocation: VerifiedRevocation }
  | { ok: false; step: RevocationStep };

/**
 * Verify a revocation record against a feed entry (plans/P4-13.md §2.3): V4 §3.5 steps 12–14
 * with `entry.record` as the pin hash, step 15 with the pin `{kind: "revocation", deliverable:
 * entry.pack, version: entry.version, seq: entry.seq}`, and step 16 (`revocation`): the body is
 * usable (`revocationOf`) and `revokes === entry.target`. Never throws.
 */
export async function verifyRevocation(
  jws: string,
  opts: VerifyRevocationOptions,
): Promise<VerifyRevocationResult> {
  const { entry } = opts;
  const r = await verifyReleaseRecord(jws, {
    releaseKeys: opts.releaseKeys,
    productTrust: opts.productTrust,
    expectedAud: opts.expectedAud,
    expectedHash: entry.record,
    pin: {
      kind: "revocation",
      deliverable: entry.pack,
      version: entry.version,
      seq: entry.seq,
    },
  });
  if (!r.ok) return r;
  const body = revocationOf(r.record, r.nonWireIntegers);
  if (body === null || body.target !== entry.target)
    return { ok: false, step: "revocation" };
  return {
    ok: true,
    revocation: {
      ...body,
      record: entry.record,
      version: r.record.version,
      seq: r.record.seq,
    },
  };
}

/**
 * The winner of two verified revocations of one target (plans/P4-13.md §2.3, decision 18): the
 * higher `issuedAt`, else the higher record hash by bytes. The Worker ranks superseding
 * revocations with this same function. Revocations are permanent: superseding changes the
 * replacement or reason, never the revoked status.
 */
export function newerRevocation<T extends { issuedAt: number; record: string }>(
  a: T,
  b: T,
): T {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt > b.issuedAt ? a : b;
  return a.record >= b.record ? a : b;
}

// ── P4-19: content-key delegation (plans/P4-19.md §2.2–§2.6, WIRE-CONTRACT-V4 §2.5.4) ──────

/** 32 raw bytes in strict base64url (V4 §1): 43 characters, no padding, zero trailing bits. */
const KEY_B64URL_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * The delegation hash a delegated record's header names (plans/P4-19.md §2.2): the hex of a
 * `pkd1-<sha256>` kid, read from the protected header only. Null for any other kid. Never throws.
 */
export function delegationHashOf(jws: unknown): string | null {
  if (typeof jws !== "string") return null;
  const kid = headerKid(jws);
  if (kid === null || !DELEGATED_KID_PATTERN.test(kid)) return null;
  return kid.slice(5);
}

/** The delegated kid of a delegation record hash: `pkd1-<sha256>`. */
export function delegatedKid(delegationSha256: string): string {
  return `pkd1-${delegationSha256}`;
}

/** A usable delegation body, as `delegationOf` reads it. */
export interface DelegationBody {
  /** The scope root, a pack id. */
  deliverable: string;
  seq: number;
  /** The content key: base64url of its 32 raw Ed25519 bytes. */
  publicKey: string;
  /** The effective types: `types ∩ DELEGABLE_PACK_TYPES`, in the record's order (never empty). */
  types: string[];
  /** The record's `types` as listed (unknown and non-delegable entries included). */
  listedTypes: string[];
  issuedAt: number;
  expiresAt: number;
}

/**
 * The delegation body (plans/P4-19.md §2.2), read beside the claims: usable when `kind` is
 * `delegation`, `deliverable` is a pack id, `delegate.publicKey` is strict base64url of 32 bytes,
 * `types` is 1–`MAX_DELEGATION_TYPES` unique `PACK_TYPE_PATTERN` strings whose intersection with
 * `DELEGABLE_PACK_TYPES` is non-empty, and `expiresAt` is an integer by token (minimum 1) with
 * `issuedAt < expiresAt ≤ issuedAt + MAX_DELEGATION_TTL_SECONDS`. `builds`, `content` and unknown
 * members are ignored. Null when unusable. Never throws.
 */
export function delegationOf(
  doc: unknown,
  nonWire: NonWireIntegers = NO_NON_WIRE_INTEGERS,
): DelegationBody | null {
  try {
    if (!isObject(doc) || doc.kind !== "delegation") return null;
    if (!isPackId(doc.deliverable)) return null;
    const delegate = doc.delegate;
    if (!isObject(delegate)) return null;
    const publicKey = delegate.publicKey;
    if (typeof publicKey !== "string" || !KEY_B64URL_RE.test(publicKey))
      return null;
    const types = doc.types;
    if (
      !Array.isArray(types) ||
      types.length < 1 ||
      types.length > MAX_DELEGATION_TYPES
    )
      return null;
    const seen = new Set<string>();
    for (const t of types) {
      if (typeof t !== "string" || !PACK_TYPE_PATTERN.test(t) || seen.has(t))
        return null;
      seen.add(t);
    }
    const effective = (types as string[]).filter((t) =>
      (DELEGABLE_PACK_TYPES as readonly string[]).includes(t),
    );
    if (effective.length === 0) return null;
    if (!isWireInteger(doc.expiresAt, "/expiresAt", 1, nonWire)) return null;
    if (!isWireInteger(doc.issuedAt, "/issuedAt", 0, nonWire)) return null;
    if (!isWireInteger(doc.seq, "/seq", 1, nonWire)) return null;
    const issuedAt = doc.issuedAt;
    const expiresAt = doc.expiresAt;
    if (!(issuedAt < expiresAt)) return null;
    if (expiresAt > issuedAt + MAX_DELEGATION_TTL_SECONDS) return null;
    return {
      deliverable: doc.deliverable,
      seq: doc.seq,
      publicKey,
      types: effective,
      listedTypes: [...(types as string[])],
      issuedAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

/** A verified delegation: its body and its record hash. */
export interface VerifiedDelegation extends DelegationBody {
  /** The delegation record's hash. */
  sha256: string;
}

export interface VerifyDelegationOptions {
  /** The PINNED release keys only: never the Worker's trust set, never a delegated key. */
  releaseKeys: TrustSet;
  /** The effective product trust set: a release key whose bytes are in it is refused. */
  productTrust: TrustSet;
  expectedAud: string;
  /** The delegation's hash: the delegated record's kid hex, or a feed entry's target. */
  expectedHash: string;
}

export type VerifyDelegationResult =
  | { ok: true; delegation: VerifiedDelegation }
  | { ok: false; step: ReleaseRecordStep | "delegation" };

/**
 * Verify a delegation record (plans/P4-19.md §2.3 step 13.1): steps 12–14 against the pinned
 * release keys only (the ASCII bound, the hash, the product-key refusal, the signature, the
 * claims), then `kind === "delegation"` and `delegationOf`. A delegation is never verified
 * through another delegation, so a content key cannot re-delegate. Never throws.
 */
export async function verifyDelegation(
  jws: string,
  opts: VerifyDelegationOptions,
): Promise<VerifyDelegationResult> {
  const r = await verifyReleaseRecord(jws, {
    releaseKeys: opts.releaseKeys,
    productTrust: opts.productTrust,
    expectedAud: opts.expectedAud,
    expectedHash: opts.expectedHash,
  });
  if (!r.ok) return r;
  if ((r.record.kind as string) !== "delegation")
    return { ok: false, step: "delegation" };
  const body = delegationOf(r.record, r.nonWireIntegers);
  if (body === null) return { ok: false, step: "delegation" };
  return { ok: true, delegation: { ...body, sha256: opts.expectedHash } };
}

/**
 * The one rule for applying revocations to a release (plans/P4-19.md §2.3): `record` when the
 * release's own hash is revoked, else `delegation` when the delegation it was signed under is,
 * else null. `revoked` holds revoked target hashes. Pure.
 */
export function recordRevoked(
  recordSha256: string,
  delegationSha256: string | null,
  revoked: ReadonlySet<string> | Readonly<Record<string, unknown>>,
): "record" | "delegation" | null {
  const hasTarget = (h: string): boolean =>
    revoked instanceof Set
      ? revoked.has(h)
      : Object.prototype.hasOwnProperty.call(revoked, h);
  if (hasTarget(recordSha256)) return "record";
  if (delegationSha256 !== null && hasTarget(delegationSha256))
    return "delegation";
  return null;
}
