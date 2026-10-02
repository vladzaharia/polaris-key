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
  MAX_PACK_VARIANTS,
  MAX_RECORD_JWS_BYTES,
  MAX_VARIANT_DELTAS,
} from "@polaris-key/protocol/core";
import {
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
  type ReleaseRecordDoc,
} from "@polaris-key/protocol/release";
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
 * checks of §4.6 and the integer rule at §2.5's paths. A value outside a v1 vocabulary is never
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
}

/** Why `verifyReleaseRecord` refused, by client step (`releaseRecordCases` `expect.step`). */
export type ReleaseRecordStep = "hash" | "jws" | "claims" | "cross-check";

export type VerifyReleaseRecordResult =
  | { ok: true; record: ReleaseRecordDoc }
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

/**
 * Client steps 12–15 (plans/P3-01.md §2.5), in the contract's order:
 *
 *  12. a body over `MAX_RECORD_JWS_BYTES` (88 844) or with a byte outside ASCII is refused
 *      without hashing; otherwise its SHA-256 must equal `expectedHash`, before any Ed25519 work;
 *  13. the key is selected by `kid` from `releaseKeys` only, refused if its raw bytes are also
 *      in `productTrust`, then `verifyJws` with that one key and `typ` `pkey-release+jws`;
 *  14. the claims (`releaseRecordClaims`);
 *  15. with a `pin`: `kind` equals the pin's `kind` (`app` when the pin names none), and
 *      `deliverable`, `version` and `seq` equal the pin's (plans/P4-01.md §2.6).
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

    // 13. The pinned release keys only, and never a product key.
    const kid = headerKid(jws);
    if (kid === null || !has(opts.releaseKeys, kid)) return fail("jws");
    const key = opts.releaseKeys[kid]!;
    const raw = rawKey(key);
    if (raw === null) return fail("jws");
    for (const productKey of Object.values(opts.productTrust)) {
      const other = rawKey(productKey);
      if (other !== null && bytesEqual(raw, other)) return fail("jws");
    }
    // A computed key is an own property even for `__proto__`.
    const one: TrustSet = { [kid]: key };
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
    return { ok: true, record };
  } catch {
    return fail("jws");
  }
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
