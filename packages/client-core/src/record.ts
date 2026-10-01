// The release record's claims — WIRE-CONTRACT-V4 §2.4 and client step 14 (plans/P3-01.md
// §2.4, §2.5). Pure and synchronous; it never throws. P3-02 lands `releaseRecordClaims`, which
// P3-03's ingest and CLI signer run; P3-05 adds `verifyReleaseRecord` (hash, key selection,
// signature, claims, cross-check) around it.

import { BUILD_ID_PATTERN } from "@polaris-key/protocol/release";
import { NO_NON_WIRE_INTEGERS, isWireInteger } from "./claims.js";

export interface ReleaseRecordClaimsOptions {
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The verified payload's `nonWireIntegers`; omit when checking an object you built. */
  nonWire?: ReadonlySet<string>;
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
  nonWire: ReadonlySet<string>,
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
  }
  return true;
}

/**
 * Client step 14 over a verified record payload: true when every claim of §2.4 holds. A caller
 * holding a parsed JWS passes `verifyJws`'s `nonWireIntegers`; a caller checking an object it
 * built passes none. Reserved kinds (`pack`, `revocation`, `delegation`) and unknown kinds pass
 * here; the cross-check refuses them where an app record is expected. Never throws.
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
