// The marker, `pkey-marker/1` (plans/P4-01.md §2.6, §2.8; WIRE-CONTRACT-V4 §3.7): the compact
// pack record beside an embedded single-file payload (`X.pkey.json`) or inside an embedded tree
// (`D/.pkey/pack.json`). `cases.json#markerCases` pins `verifyMarker`; the byte match against the
// embedded payload and the content stamp's pin is the host's (`matchEmbedded`, unit-tested).

import type { TrustSet } from "@polaris-key/jws";
import {
  MARKER_FORMAT,
  MAX_RECORD_JWS_BYTES,
} from "@polaris-key/protocol/core";
import type { AppContent, PackRecordDoc } from "@polaris-key/protocol/packs";
import { verifyReleaseRecord } from "../record.js";
import { isObject, isPackId } from "./claims.js";
import { strictParse } from "./files.js";

/** P2-04's `VERSION_RE`. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const NON_ASCII_RE = /[^\x00-\x7f]/;

/** Where `verifyMarker` refused (`markerCases` `expect.step`), and the host's own two steps:
 *  `payload` (no variant matches the embedded bytes) and `pin` (the stamp pins another record). */
export type MarkerStep =
  | "format"
  | "hash"
  | "jws"
  | "claims"
  | "cross-check"
  | "payload"
  | "pin";

export type VerifyMarkerResult =
  | {
      ok: true;
      packId: string;
      version: string;
      record: PackRecordDoc;
      recordSha256: string;
    }
  | { ok: false; error: "marker-rejected"; step: MarkerStep };

export interface VerifyMarkerOptions {
  /** The PINNED release keys, the only keys a pack record verifies against. */
  releaseKeys: TrustSet;
  /** The effective product trust set; a release key also in it is refused (`jws`). */
  productTrust: TrustSet;
  /** The product: the record's `aud`. */
  expectedAud: string;
}

const refuse = (step: MarkerStep): VerifyMarkerResult => ({
  ok: false,
  error: "marker-rejected",
  step,
});

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text).buffer as ArrayBuffer,
    ),
  );
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `verifyMarker(marker, opts)` (§2.6 "Markers", V4 §3.7), in order:
 *
 *  1. the marker file's bytes pass V4 §1.2's strict JSON (`format`);
 *  2. `format === "pkey-marker/1"`, `packId` a pack id, `version` matching `VERSION_RE`,
 *     `release` a string (`format`);
 *  3. steps 12–14 with `release` as the body and its own SHA-256 as the pin hash: the 88,844-byte
 *     ASCII bound (`hash`), key selection from the pinned release keys and `verifyJws` (`jws`),
 *     the record claims (`claims`);
 *  4. `kind === "pack"`, `deliverable === packId`, `version === version` (`cross-check`).
 *
 * Returns the record and its SHA-256, or `marker-rejected` with the step. Never throws.
 */
export async function verifyMarker(
  marker: string | Uint8Array,
  opts: VerifyMarkerOptions,
): Promise<VerifyMarkerResult> {
  try {
    const bytes =
      typeof marker === "string" ? new TextEncoder().encode(marker) : marker;
    const parsed = strictParse(bytes);
    if (parsed === null || !isObject(parsed.value)) return refuse("format");
    const m = parsed.value;
    if (m.format !== MARKER_FORMAT) return refuse("format");
    if (!isPackId(m.packId)) return refuse("format");
    if (typeof m.version !== "string" || !VERSION_RE.test(m.version))
      return refuse("format");
    if (typeof m.release !== "string") return refuse("format");
    const release = m.release;
    if (NON_ASCII_RE.test(release) || release.length > MAX_RECORD_JWS_BYTES)
      return refuse("hash");
    const recordSha256 = await sha256Hex(release);
    const v = await verifyReleaseRecord(release, {
      releaseKeys: opts.releaseKeys,
      productTrust: opts.productTrust,
      expectedAud: opts.expectedAud,
      expectedHash: recordSha256,
    });
    if (!v.ok) return refuse(v.step);
    const record = v.record as unknown as Record<string, unknown>;
    if (
      record.kind !== "pack" ||
      record.deliverable !== m.packId ||
      record.version !== m.version
    )
      return refuse("cross-check");
    return {
      ok: true,
      packId: m.packId,
      version: m.version,
      record: v.record as unknown as PackRecordDoc,
      recordSha256,
    };
  } catch {
    return refuse("format");
  }
}

/** What the host measured of the embedded payload: a single file's SHA-256 and size, or a
 *  tree's `treeDigest` (computed from the files under its directory minus `.pkey/`). */
export type EmbeddedPayload =
  | { kind: "file"; sha256: string; size: number }
  | { kind: "tree"; treeDigest: string };

/**
 * The host's match of an embedded payload against its verified marker (§2.6): the variant whose
 * `payload` the bytes match (a single file by SHA-256 and size, a tree by `treeDigest`), and,
 * when the content stamp pins the pack, `recordSha256` equal to the pin's `sha256`. Returns the
 * variant's index, or the refused step: `payload` (no variant matches) or `pin` (the embedded
 * copy is not the pinned release and is not used).
 */
export function matchEmbedded(
  verified: { packId: string; record: PackRecordDoc; recordSha256: string },
  payload: EmbeddedPayload,
  stamp: AppContent | null,
):
  | { ok: true; variant: number }
  | { ok: false; error: "marker-rejected"; step: "payload" | "pin" } {
  const variants = verified.record.variants ?? [];
  const index = variants.findIndex((v) =>
    payload.kind === "file"
      ? v.payload.sha256 === payload.sha256 && v.payload.size === payload.size
      : v.files?.layout === "tree" && v.payload.sha256 === payload.treeDigest,
  );
  if (index < 0)
    return { ok: false, error: "marker-rejected", step: "payload" };
  const pin = stamp?.pins.find((p) => p.pack === verified.packId);
  if (pin && pin.release.sha256 !== verified.recordSha256)
    return { ok: false, error: "marker-rejected", step: "pin" };
  return { ok: true, variant: index };
}
