// Reference: the record's claims (V4 §2.4) and the `releaseRecordCases` verdict.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { base64UrlDecode } from "@polaris-key/jws";
import { sha256Hex, utf8Bytes } from "../common.js";
import { type ClaimCtx, ctxOf, hasOwn, isObj, refInt } from "./claims.js";
import { refVerifyJws } from "./jws.js";
import {
  on,
  refContentClaims,
  refEmbedsClaims,
  refPackClaims,
} from "./pack-claims.js";
import {
  REF_BUILD_ID_RE,
  REF_DELIVERABLE_RE,
  REF_RECORD_VERSION_RE,
  REF_SHA256_RE,
} from "./patterns.js";

/** Client step 14 (plans/P3-01.md §2.4). */
export function refRecordClaims(
  doc: unknown,
  ctx: ClaimCtx,
  aud: string,
): boolean {
  if (!isObj(doc)) return false;
  const r = "record";
  if (
    !refInt(ctx, r, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return false;
  if (doc.aud !== aud) return false;
  if (
    typeof doc.deliverable !== "string" ||
    utf8Bytes(doc.deliverable).length > 64 ||
    !REF_DELIVERABLE_RE.test(doc.deliverable)
  )
    return false;
  if (typeof doc.kind !== "string" || doc.kind === "") return false;
  if (
    typeof doc.version !== "string" ||
    !REF_RECORD_VERSION_RE.test(doc.version)
  )
    return false;
  if (!refInt(ctx, r, doc.seq, "/seq")) return false;
  if (!refInt(ctx, r, doc.issuedAt, "/issuedAt")) return false;
  if (
    hasOwn(doc, "minSupportedSeq") &&
    !refInt(ctx, r, doc.minSupportedSeq, "/minSupportedSeq")
  )
    return false;
  for (const k of ["tag", "channel", "title", "notes"])
    if (hasOwn(doc, k) && typeof doc[k] !== "string") return false;
  if (hasOwn(doc, "provenance")) {
    const p = doc.provenance;
    if (!isObj(p)) return false;
    for (const k of ["commit", "workflowRun"])
      if (hasOwn(p, k) && typeof p[k] !== "string") return false;
  }
  // plans/P4-01.md §2.2: §2.3 for `kind: pack`, §2.4 for `kind: app`, the common claims only
  // for any other kind (whose `content` and `embeds` are ignored).
  if (doc.kind === "pack") return refPackClaims(doc, ctx);
  const app = doc.kind === "app";
  if (app && hasOwn(doc, "content") && on(ctx, "content")) {
    if (!refContentClaims(doc.content, ctx, "/content")) return false;
  }
  if (!hasOwn(doc, "builds")) return doc.kind !== "app";
  if (
    !Array.isArray(doc.builds) ||
    doc.builds.length < 1 ||
    doc.builds.length > 64
  )
    return false;
  const ids = new Set<string>();
  for (const [i, b] of doc.builds.entries()) {
    if (!isObj(b) || typeof b.id !== "string" || !REF_BUILD_ID_RE.test(b.id))
      return false;
    if (ids.has(b.id)) return false;
    ids.add(b.id);
    for (const k of ["platform", "arch", "format"])
      if (typeof b[k] !== "string" || b[k] === "") return false;
    for (const k of ["buildNumber", "minOS"])
      if (hasOwn(b, k) && typeof b[k] !== "string") return false;
    if (hasOwn(b, "requires") && !isObj(b.requires)) return false;
    if (!Array.isArray(b.artifacts) || b.artifacts.length > 32) return false;
    let payloads = 0;
    for (const [j, a] of b.artifacts.entries()) {
      if (!isObj(a)) return false;
      if (typeof a.name !== "string" || a.name === "") return false;
      if (typeof a.role !== "string" || a.role === "") return false;
      if (a.role === "payload") payloads++;
      if (typeof a.sha256 !== "string" || !REF_SHA256_RE.test(a.sha256))
        return false;
      if (!refInt(ctx, r, a.size, `/builds/${i}/artifacts/${j}/size`))
        return false;
      if (hasOwn(a, "contentType") && typeof a.contentType !== "string")
        return false;
    }
    if (payloads > 1) return false;
    if (app && hasOwn(b, "embeds") && on(ctx, "embeds")) {
      if (!refEmbedsClaims(b.embeds, ctx)) return false;
    }
  }
  return true;
}

// ── §4.5 `releaseRecordCases` ────────────────────────────────────────────────────────────────

export interface RecordCase {
  id: string;
  description: string;
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin?: { deliverable: string; version: string; seq: number };
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: "hash" | "jws" | "claims" | "cross-check" };
}

/** V4 §2.5 steps 12–15, from first principles. */
export function refVerifyRecordCase(c: RecordCase): RecordCase["expect"] {
  const body = c.jws;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { verify: "fail", step: "hash" };
  if (sha256Hex(body) !== c.expectedHash)
    return { verify: "fail", step: "hash" };
  const parts = body.split(".");
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(parts[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return { verify: "fail", step: "jws" };
  }
  if (typeof kid !== "string" || !hasOwn(c.releaseKeys, kid))
    return { verify: "fail", step: "jws" };
  const key = c.releaseKeys[kid]!;
  if (Object.values(c.productTrust).includes(key))
    return { verify: "fail", step: "jws" };
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { verify: "fail", step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), c.expectedAud))
    return { verify: "fail", step: "claims" };
  if (c.pin) {
    const d = v.payload;
    if (d.kind !== "app" || d.deliverable !== c.pin.deliverable)
      return { verify: "fail", step: "cross-check" };
    if (d.version !== c.pin.version || d.seq !== c.pin.seq)
      return { verify: "fail", step: "cross-check" };
  }
  return { verify: "ok", kind: v.payload.kind as string };
}
