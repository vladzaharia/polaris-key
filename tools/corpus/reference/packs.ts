// Reference: the `packRecordCases` and `markerCases` verdicts.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { base64UrlDecode } from "@polaris-key/jws";
import { sha256Hex, utf8Bytes } from "../common.js";
import { ctxOf, hasOwn, isObj } from "./claims.js";
import { refParseStrict } from "./config.js";
import { refVerifyJws } from "./jws.js";
import { REF_RECORD_VERSION_RE, refPackIdShape } from "./patterns.js";
import { refRecordClaims } from "./record.js";

// ── `packRecordCases` (159) ──────────────────────────────────────────────────────────────────

export interface PackPin {
  kind?: string;
  deliverable: string;
  version: string;
  seq: number;
}

export interface PackRecordCase {
  id: string;
  description: string;
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin?: PackPin;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: "hash" | "jws" | "claims" | "cross-check" };
}

/** Steps 12–14 over a record body (shared by pack cases and markers). */
export function refRecordSteps(
  body: string,
  expectedHash: string,
  releaseKeys: Record<string, string>,
  productTrust: Record<string, string>,
  aud: string,
):
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; step: "hash" | "jws" | "claims" } {
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { ok: false, step: "hash" };
  if (sha256Hex(body) !== expectedHash) return { ok: false, step: "hash" };
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(body.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return { ok: false, step: "jws" };
  }
  if (typeof kid !== "string" || !hasOwn(releaseKeys, kid))
    return { ok: false, step: "jws" };
  const key = releaseKeys[kid]!;
  if (Object.values(productTrust).includes(key))
    return { ok: false, step: "jws" };
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { ok: false, step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), aud))
    return { ok: false, step: "claims" };
  return { ok: true, doc: v.payload };
}

/** V4 §3.5 steps 12–15 with plans/P4-01.md §2.6's step 15: `kind` equals the pin's, `app`
 *  when the pin names none. */
export function refVerifyPackCase(c: PackRecordCase): PackRecordCase["expect"] {
  const r = refRecordSteps(
    c.jws,
    c.expectedHash,
    c.releaseKeys,
    c.productTrust,
    c.expectedAud,
  );
  if (!r.ok) return { verify: "fail", step: r.step };
  const d = r.doc;
  if (c.pin) {
    if (d.kind !== (c.pin.kind ?? "app") || d.deliverable !== c.pin.deliverable)
      return { verify: "fail", step: "cross-check" };
    if (d.version !== c.pin.version || d.seq !== c.pin.seq)
      return { verify: "fail", step: "cross-check" };
  }
  return { verify: "ok", kind: d.kind as string };
}

// ── `markerCases` (17), V4 §3.7 ──────────────────────────────────────────────────────────────

export interface MarkerCase {
  id: string;
  description: string;
  marker: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; packId: string; version: string; recordSha256: string }
    | {
        verify: "fail";
        step: "format" | "hash" | "jws" | "claims" | "cross-check";
      };
}

/** V4 §3.7 (plans/P4-01.md §2.6), from first principles. */
export function refVerifyMarkerCase(c: MarkerCase): MarkerCase["expect"] {
  const text = c.marker;
  if (text.charCodeAt(0) === 0xfeff) return { verify: "fail", step: "format" };
  const parsed = refParseStrict(text);
  if (!parsed.ok || !isObj(parsed.value))
    return { verify: "fail", step: "format" };
  const m = parsed.value as Record<string, unknown>;
  if (m.format !== "pkey-marker/1") return { verify: "fail", step: "format" };
  if (!refPackIdShape(m.packId) || m.packId === "app")
    return { verify: "fail", step: "format" };
  if (typeof m.version !== "string" || !REF_RECORD_VERSION_RE.test(m.version))
    return { verify: "fail", step: "format" };
  if (typeof m.release !== "string") return { verify: "fail", step: "format" };
  const body = m.release;
  const r = refRecordSteps(
    body,
    utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body)
      ? ""
      : sha256Hex(body),
    c.releaseKeys,
    c.productTrust,
    c.expectedAud,
  );
  if (!r.ok) return { verify: "fail", step: r.step };
  if (
    r.doc.kind !== "pack" ||
    r.doc.deliverable !== m.packId ||
    r.doc.version !== m.version
  )
    return { verify: "fail", step: "cross-check" };
  return {
    verify: "ok",
    packId: m.packId,
    version: m.version,
    recordSha256: sha256Hex(body),
  };
}
